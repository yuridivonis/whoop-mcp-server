import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
	InvalidClientMetadataError,
	InvalidGrantError,
	InvalidTargetError,
	InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { checkResourceAllowed } from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import type {
	OAuthClientInformationFull,
	OAuthTokenRevocationRequest,
	OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { WhoopDatabase } from '../database.js';
import { sendLoginPage, sendSignInError } from './login-page.js';
import { describeRedirect, redirectAllowed, redirectHost } from './redirects.js';

// Codes are exchanged seconds after the redirect; anything older is suspect.
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
// Rotated on every use, so an active connector never hits this; an idle one signs in again.
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function newSecret(): string {
	return randomBytes(32).toString('base64url');
}

function hashSecret(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

/** Compares digests, so neither the length nor the content of the password leaks through timing. */
function passwordMatches(candidate: string, expected: string): boolean {
	const a = createHash('sha256').update(candidate).digest();
	const b = createHash('sha256').update(expected).digest();
	return timingSafeEqual(a, b);
}

const PASSWORD_RECORD = 'mcp_auth_password';

interface PasswordRecord {
	salt: string;
	hash: string;
	generation: string;
}

function readPasswordRecord(value: string | undefined): PasswordRecord | null {
	try {
		const record = JSON.parse(value ?? '') as Partial<PasswordRecord>;
		if (typeof record.salt === 'string' && typeof record.hash === 'string' && typeof record.generation === 'string') {
			return record as PasswordRecord;
		}
	} catch {
		// Missing or unreadable: treated as a password change.
	}
	return null;
}

/**
 * A client name made safe for the log: control and bidirectional-text characters removed,
 * then quoted, so a name can't add lines, fake fields, or visually reorder the line.
 */
function quotedName(value: string): string {
	return JSON.stringify(value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, ' ').slice(0, 80));
}

function fingerprint(password: string, salt: string): Buffer {
	return scryptSync(password, Buffer.from(salt, 'hex'), 32);
}

/**
 * The sign-in generation for the current MCP_AUTH_PASSWORD.
 *
 * SECURITY: every code and token carries the generation it was issued under, and only the
 * current one is accepted. A new password starts a new generation, which signs every client
 * out, including clients of a server that is still running with the old password. Only a
 * salted scrypt fingerprint of the password is stored, never the password itself.
 */
export function signInGeneration(db: WhoopDatabase, password: string): { generation: string; passwordChanged: boolean } {
	const stored = readPasswordRecord(db.getSetting(PASSWORD_RECORD));
	if (stored) {
		const expected = Buffer.from(stored.hash, 'hex');
		const actual = fingerprint(password, stored.salt);
		if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
			return { generation: stored.generation, passwordChanged: false };
		}
	}

	const salt = randomBytes(16).toString('hex');
	const record: PasswordRecord = { salt, hash: fingerprint(password, salt).toString('hex'), generation: randomUUID() };
	db.startSignInGeneration(PASSWORD_RECORD, JSON.stringify(record));
	return { generation: record.generation, passwordChanged: stored !== null };
}

interface McpAuthProviderOptions {
	db: WhoopDatabase;
	password: string;
	/** From signInGeneration(); stamped on every code and token. */
	generation: string;
	/** The /mcp URL. Tokens are only issued for this server. */
	resourceUrl: URL;
	/** Web clients whose redirect addresses are allowed; see redirects.ts. */
	allowedRedirectHosts: string[];
	/** Records each successful sign-in, so the owner can spot one they didn't make. */
	log: (line: string) => void;
}

/**
 * OAuth 2.1 authorization server for /mcp, for a single owner per deployment.
 *
 * The MCP SDK's auth router does the protocol work: client registration, PKCE checks,
 * metadata, per-endpoint rate limits. This class decides who may sign in (whoever knows
 * MCP_AUTH_PASSWORD) and stores codes and tokens in SQLite, so a restart or redeploy
 * does not sign Claude out.
 *
 * SECURITY: each sign-in starts a token family. Codes and refresh tokens work once; a
 * second use means one of them leaked, so the whole family is revoked, cutting off
 * whoever used it first (RFC 9700 §4.14.2). Codes only go to allowed redirect addresses
 * (redirects.ts), and only grants from the current sign-in generation are accepted.
 */
export class McpAuthProvider implements OAuthServerProvider {
	private readonly db: WhoopDatabase;
	private readonly password: string;
	private readonly generation: string;
	private readonly resourceUrl: URL;
	private readonly allowedRedirectHosts: string[];
	private readonly log: (line: string) => void;

	constructor(options: McpAuthProviderOptions) {
		this.db = options.db;
		this.password = options.password;
		this.generation = options.generation;
		this.resourceUrl = options.resourceUrl;
		this.allowedRedirectHosts = options.allowedRedirectHosts;
		this.log = options.log;
	}

	private withAllowedRedirects(client: OAuthClientInformationFull): OAuthClientInformationFull {
		return { ...client, redirect_uris: client.redirect_uris.filter(uri => redirectAllowed(uri, this.allowedRedirectHosts)) };
	}

	/**
	 * Whether this server's password is still the current one. A server started with an
	 * older password (before a restart replaced it) must not issue or accept anything, so
	 * this reads the stored record rather than trusting the generation cached at startup.
	 */
	private isCurrent(): boolean {
		return readPasswordRecord(this.db.getSetting(PASSWORD_RECORD))?.generation === this.generation;
	}

	get clientsStore(): OAuthRegisteredClientsStore {
		return {
			// Registrations only ever expose allowed redirect addresses, so the SDK rejects any
			// other address outright instead of redirecting an error to it.
			getClient: clientId => {
				const info = this.db.getOAuthClient(clientId);
				return info ? this.withAllowedRedirects(JSON.parse(info) as OAuthClientInformationFull) : undefined;
			},
			registerClient: client => {
				// At least one address must be allowed. Some clients register a spare address
				// they don't use, so each sign-in is checked against the address it actually uses.
				if (!client.redirect_uris.some(uri => redirectAllowed(uri, this.allowedRedirectHosts))) {
					const host = redirectHost(client.redirect_uris[0] ?? '');
					throw new InvalidClientMetadataError(
						`Redirect address ${host} is not allowed. To use this client, add ${host} to MCP_ALLOWED_REDIRECT_HOSTS.`,
					);
				}
				// The SDK's registration handler normally assigns the id; the defaults are a fallback.
				// Addresses that aren't allowed are dropped (RFC 7591 lets the server change what it
				// registers; the response tells the client what it got).
				const full = this.withAllowedRedirects({
					client_id: randomUUID(),
					client_id_issued_at: Math.floor(Date.now() / 1000),
					...client,
				});
				this.db.saveOAuthClient(full.client_id, JSON.stringify(full));
				return full;
			},
		};
	}

	// SECURITY: the SDK has already checked client_id and redirect_uri against the
	// registered client before this runs. Failed password attempts are rate-limited in app.ts.
	async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
		// Checked here as well as at registration, so clients registered before the allowlist are covered.
		if (!redirectAllowed(params.redirectUri, this.allowedRedirectHosts)) {
			sendSignInError(res, `This app wants to send you to ${redirectHost(params.redirectUri)}, which this server doesn't allow. Nothing was shared.`);
			return;
		}
		if (!this.isCurrent()) {
			sendSignInError(res, "This server's password was just changed and it is restarting. Try again in a minute.", 503);
			return;
		}
		this.checkResource(params.resource);

		const destination = describeRedirect(params.redirectUri);
		const body = res.req.method === 'POST' ? res.req.body as { password?: unknown; consent?: unknown } : undefined;
		if (body?.password === undefined) {
			sendLoginPage(res, { client, params, destination });
			return;
		}

		// WHOOP's terms require explicit opt-in consent before the app receives any WHOOP data.
		if (body.consent !== 'yes') {
			sendLoginPage(res, { client, params, destination, error: `To sign in, tick the box to allow ${destination} to read your WHOOP data.`, status: 400 });
			return;
		}

		if (typeof body.password !== 'string' || !passwordMatches(body.password, this.password)) {
			sendLoginPage(res, { client, params, destination, error: 'Incorrect password.', status: 401 });
			return;
		}

		const code = newSecret();
		this.db.saveOAuthCode({
			code_hash: hashSecret(code),
			family_id: randomUUID(),
			generation: this.generation,
			client_id: client.client_id,
			code_challenge: params.codeChallenge,
			redirect_uri: params.redirectUri,
			scopes: (params.scopes ?? []).join(' '),
			expires_at: Date.now() + AUTH_CODE_TTL_MS,
			consented_at: Date.now(),
		});

		const redirectUrl = new URL(params.redirectUri);
		redirectUrl.searchParams.set('code', code);
		if (params.state) {
			redirectUrl.searchParams.set('state', params.state);
		}
		// Server-controlled fields first; the client-chosen name last, quoted.
		this.log(`Signed in: client ${client.client_id}, returning to ${destination}, app ${quotedName(client.client_name ?? 'unnamed')}`);
		res.redirect(302, redirectUrl.href);
	}

	async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
		const stored = this.db.getOAuthCode(hashSecret(authorizationCode));
		if (!stored || stored.client_id !== client.client_id || stored.generation !== this.generation || !this.isCurrent()) {
			throw new InvalidGrantError('Invalid authorization code');
		}
		if (stored.consumed_at !== null) {
			this.db.deleteOAuthFamily(stored.family_id);
			throw new InvalidGrantError('Authorization code was already used');
		}
		return stored.code_challenge;
	}

	async exchangeAuthorizationCode(
		client: OAuthClientInformationFull,
		authorizationCode: string,
		_codeVerifier?: string,
		redirectUri?: string,
		resource?: URL,
	): Promise<OAuthTokens> {
		this.checkResource(resource);

		// PKCE was verified by the SDK against challengeForAuthorizationCode before this runs.
		const codeHash = hashSecret(authorizationCode);
		const stored = this.db.consumeOAuthCode(codeHash, Date.now());
		if (!stored) {
			// The code is unknown, or a second exchange raced past the PKCE check; in that
			// case, revoke what the first exchange received.
			const used = this.db.getOAuthCode(codeHash);
			if (used?.generation === this.generation) this.db.deleteOAuthFamily(used.family_id);
			throw new InvalidGrantError('Invalid authorization code');
		}
		if (stored.client_id !== client.client_id || stored.generation !== this.generation || !this.isCurrent()) {
			throw new InvalidGrantError('Invalid authorization code');
		}
		if (stored.expires_at < Date.now()) {
			throw new InvalidGrantError('Authorization code has expired');
		}
		if (redirectUri !== undefined && redirectUri !== stored.redirect_uri) {
			throw new InvalidGrantError('redirect_uri does not match the authorization request');
		}
		return this.issueTokens(client.client_id, stored.scopes, stored.family_id);
	}

	async exchangeRefreshToken(
		client: OAuthClientInformationFull,
		refreshToken: string,
		_scopes?: string[],
		resource?: URL,
	): Promise<OAuthTokens> {
		this.checkResource(resource);

		if (!this.isCurrent()) {
			throw new InvalidGrantError('Invalid refresh token');
		}
		const tokenHash = hashSecret(refreshToken);
		const stored = this.db.consumeRefreshToken(tokenHash, client.client_id, this.generation, Date.now());
		if (!stored) {
			// A spent refresh token presented again has leaked: revoke its whole family.
			const used = this.db.getOAuthToken(tokenHash, 'refresh');
			if (used?.consumed_at != null && used.generation === this.generation) {
				this.db.deleteOAuthFamily(used.family_id);
			}
			throw new InvalidGrantError('Invalid refresh token');
		}
		if (stored.expires_at < Date.now()) {
			throw new InvalidGrantError('Refresh token has expired');
		}
		return this.issueTokens(client.client_id, stored.scopes, stored.family_id);
	}

	async verifyAccessToken(token: string): Promise<AuthInfo> {
		const stored = this.db.getOAuthToken(hashSecret(token), 'access');
		if (!stored || stored.generation !== this.generation || stored.expires_at < Date.now() || !this.isCurrent()) {
			throw new InvalidTokenError('Invalid or expired access token');
		}
		return {
			token,
			clientId: stored.client_id,
			scopes: stored.scopes ? stored.scopes.split(' ') : [],
			expiresAt: Math.floor(stored.expires_at / 1000),
			resource: this.resourceUrl,
		};
	}

	async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
		const tokenHash = hashSecret(request.token);
		const stored = this.db.getOAuthToken(tokenHash);
		// RFC 7009: a client may only revoke its own tokens, and revoking a refresh token
		// also revokes the access tokens issued alongside it.
		if (!stored || stored.client_id !== client.client_id) return;
		if (stored.kind === 'refresh') {
			this.db.deleteOAuthFamily(stored.family_id);
		} else {
			this.db.deleteOAuthToken(tokenHash);
		}
	}

	/**
	 * Tokens are only ever issued for this server (RFC 8707): its /mcp endpoint, or its bare
	 * origin, which ChatGPT may send instead.
	 */
	private checkResource(resource: URL | undefined): void {
		if (!resource || resource.href === new URL('/', this.resourceUrl).href) return;
		if (!checkResourceAllowed({ requestedResource: resource, configuredResource: this.resourceUrl })) {
			throw new InvalidTargetError(`This server only issues tokens for ${this.resourceUrl.href}`);
		}
	}

	private issueTokens(clientId: string, scopes: string, familyId: string): OAuthTokens {
		const now = Date.now();
		const accessToken = newSecret();
		const refreshToken = newSecret();
		this.db.saveOAuthToken({
			token_hash: hashSecret(accessToken),
			family_id: familyId,
			generation: this.generation,
			kind: 'access',
			client_id: clientId,
			scopes,
			expires_at: now + ACCESS_TOKEN_TTL_MS,
		});
		this.db.saveOAuthToken({
			token_hash: hashSecret(refreshToken),
			family_id: familyId,
			generation: this.generation,
			kind: 'refresh',
			client_id: clientId,
			scopes,
			expires_at: now + REFRESH_TOKEN_TTL_MS,
		});
		// After saving, so this family counts as live and keeps its replay markers.
		this.db.deleteExpiredOAuth(now);

		return {
			access_token: accessToken,
			token_type: 'Bearer',
			expires_in: ACCESS_TOKEN_TTL_MS / 1000,
			refresh_token: refreshToken,
			...(scopes ? { scope: scopes } : {}),
		};
	}
}
