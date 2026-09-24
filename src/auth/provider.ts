import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidGrantError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { checkResourceAllowed } from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import type {
	OAuthClientInformationFull,
	OAuthTokenRevocationRequest,
	OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { WhoopDatabase } from '../database.js';
import { sendLoginPage } from './login-page.js';

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

interface McpAuthProviderOptions {
	db: WhoopDatabase;
	password: string;
	/** The /mcp URL. Tokens are only issued for this server. */
	resourceUrl: URL;
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
 * whoever used it first (RFC 9700 §4.14.2).
 */
export class McpAuthProvider implements OAuthServerProvider {
	private readonly db: WhoopDatabase;
	private readonly password: string;
	private readonly resourceUrl: URL;

	constructor(options: McpAuthProviderOptions) {
		this.db = options.db;
		this.password = options.password;
		this.resourceUrl = options.resourceUrl;
	}

	get clientsStore(): OAuthRegisteredClientsStore {
		return {
			getClient: clientId => {
				const info = this.db.getOAuthClient(clientId);
				return info ? JSON.parse(info) as OAuthClientInformationFull : undefined;
			},
			registerClient: client => {
				// The SDK's registration handler normally assigns the id; the defaults are a fallback.
				const full: OAuthClientInformationFull = {
					client_id: randomUUID(),
					client_id_issued_at: Math.floor(Date.now() / 1000),
					...client,
				};
				this.db.saveOAuthClient(full.client_id, JSON.stringify(full));
				return full;
			},
		};
	}

	// SECURITY: the SDK has already checked client_id and redirect_uri against the
	// registered client before this runs. Failed password attempts are rate-limited in app.ts.
	async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
		this.checkResource(params.resource);

		const body = res.req.method === 'POST' ? res.req.body as { password?: unknown } : undefined;
		if (body?.password === undefined) {
			sendLoginPage(res, { client, params });
			return;
		}

		if (typeof body.password !== 'string' || !passwordMatches(body.password, this.password)) {
			sendLoginPage(res, { client, params, error: 'Incorrect password.', status: 401 });
			return;
		}

		const code = newSecret();
		this.db.saveOAuthCode({
			code_hash: hashSecret(code),
			family_id: randomUUID(),
			client_id: client.client_id,
			code_challenge: params.codeChallenge,
			redirect_uri: params.redirectUri,
			scopes: (params.scopes ?? []).join(' '),
			expires_at: Date.now() + AUTH_CODE_TTL_MS,
		});

		const redirectUrl = new URL(params.redirectUri);
		redirectUrl.searchParams.set('code', code);
		if (params.state) {
			redirectUrl.searchParams.set('state', params.state);
		}
		res.redirect(302, redirectUrl.href);
	}

	async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
		const stored = this.db.getOAuthCode(hashSecret(authorizationCode));
		if (!stored || stored.client_id !== client.client_id) {
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
			if (used) this.db.deleteOAuthFamily(used.family_id);
			throw new InvalidGrantError('Invalid authorization code');
		}
		if (stored.client_id !== client.client_id) {
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

		const tokenHash = hashSecret(refreshToken);
		const stored = this.db.consumeRefreshToken(tokenHash, client.client_id, Date.now());
		if (!stored) {
			// A spent refresh token presented again has leaked: revoke its whole family.
			const used = this.db.getOAuthToken(tokenHash, 'refresh');
			if (used?.consumed_at != null) {
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
		if (!stored || stored.expires_at < Date.now()) {
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

	/** Tokens are only ever issued for this server's own /mcp endpoint (RFC 8707). */
	private checkResource(resource: URL | undefined): void {
		if (resource && !checkResourceAllowed({ requestedResource: resource, configuredResource: this.resourceUrl })) {
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
			kind: 'access',
			client_id: clientId,
			scopes,
			expires_at: now + ACCESS_TOKEN_TTL_MS,
		});
		this.db.saveOAuthToken({
			token_hash: hashSecret(refreshToken),
			family_id: familyId,
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
