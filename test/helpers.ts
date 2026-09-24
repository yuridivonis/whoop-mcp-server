import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { WhoopDatabase } from '../src/database.js';
import { PendingAuthStates } from '../src/auth-states.js';
import type { WhoopClient } from '../src/whoop-client.js';
import type { WhoopSync } from '../src/sync.js';
import type { WhoopTokens } from '../src/types.js';

// crypto.ts encrypts stored WHOOP tokens with this.
process.env.ENCRYPTION_SECRET ??= 'test-encryption-secret';

export const PASSWORD = 'correct horse battery staple';
export const CLIENT_REDIRECT_URI = 'http://localhost:9999/oauth/callback';

export interface TestServer {
	baseUrl: string;
	db: WhoopDatabase;
	authStates: PendingAuthStates;
	/** Codes the stub WHOOP client was asked to exchange at /callback. */
	exchangedCodes: string[];
	close(): Promise<void>;
}

/** Starts the real app on a random port, with WHOOP and the sync stubbed out. */
export async function startTestServer(dbPath = ':memory:'): Promise<TestServer> {
	const httpServer = createServer();
	await new Promise<void>(resolve => httpServer.listen(0, resolve));
	const { port } = httpServer.address() as AddressInfo;
	const baseUrl = `http://localhost:${port}`;

	const config = loadConfig({
		MCP_AUTH_PASSWORD: PASSWORD,
		PUBLIC_URL: baseUrl,
		WHOOP_REDIRECT_URI: `${baseUrl}/callback`,
		DB_PATH: dbPath,
	});
	const db = new WhoopDatabase(config.dbPath);
	const authStates = new PendingAuthStates();
	const exchangedCodes: string[] = [];

	const client = {
		getAuthorizationUrl: (_scopes: string[], state: string) => `https://whoop.example/auth?state=${state}`,
		exchangeCodeForTokens: async (code: string): Promise<WhoopTokens> => {
			exchangedCodes.push(code);
			return { access_token: 'whoop-access', refresh_token: 'whoop-refresh', expires_at: Date.now() + 3_600_000 };
		},
	} as unknown as WhoopClient;

	const sync = {
		syncDays: async () => ({ cycles: 0, recoveries: 0, sleeps: 0, workouts: 0 }),
		smartSync: async () => ({ type: 'skip' }),
	} as unknown as WhoopSync;

	httpServer.on('request', createApp({ config, db, client, sync, authStates }));

	return {
		baseUrl,
		db,
		authStates,
		exchangedCodes,
		close: async () => {
			httpServer.closeAllConnections();
			await new Promise<void>(resolve => httpServer.close(() => resolve()));
			db.close();
		},
	};
}

export function pkcePair(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString('base64url');
	const challenge = createHash('sha256').update(verifier).digest('base64url');
	return { verifier, challenge };
}

export async function registerClient(baseUrl: string): Promise<string> {
	const res = await fetch(`${baseUrl}/register`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			client_name: 'Test Client',
			redirect_uris: [CLIENT_REDIRECT_URI],
			token_endpoint_auth_method: 'none',
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
		}),
	});
	if (res.status !== 201) throw new Error(`registration failed: ${res.status} ${await res.text()}`);
	return (await res.json() as { client_id: string }).client_id;
}

export function authorizeParams(clientId: string, challenge: string, extra: Record<string, string> = {}): URLSearchParams {
	return new URLSearchParams({
		client_id: clientId,
		redirect_uri: CLIENT_REDIRECT_URI,
		response_type: 'code',
		code_challenge: challenge,
		code_challenge_method: 'S256',
		state: 'client-state',
		...extra,
	});
}

/** Submits the sign-in form the way a browser would. */
export function submitPassword(
	baseUrl: string,
	params: URLSearchParams,
	password: string,
	options: { path?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
	const form = new URLSearchParams(params);
	form.set('password', password);
	return fetch(`${baseUrl}${options.path ?? '/authorize'}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...options.headers },
		body: form,
		redirect: 'manual',
	});
}

/** Signs in and returns the authorization code, without exchanging it. */
export async function authorizationCode(baseUrl: string, clientId: string, challenge: string): Promise<string> {
	const redirect = await submitPassword(baseUrl, authorizeParams(clientId, challenge), PASSWORD);
	return new URL(redirect.headers.get('location') ?? '').searchParams.get('code') ?? '';
}

export function postToken(baseUrl: string, fields: Record<string, string>): Promise<Response> {
	return fetch(`${baseUrl}/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(fields),
	});
}

export interface TokenSet {
	access_token: string;
	refresh_token: string;
	expires_in: number;
}

/** Runs the whole flow a client like Claude.ai runs: register, sign in, exchange the code. */
export async function signIn(baseUrl: string): Promise<{ clientId: string; tokens: TokenSet }> {
	const clientId = await registerClient(baseUrl);
	const { verifier, challenge } = pkcePair();
	const redirect = await submitPassword(baseUrl, authorizeParams(clientId, challenge), PASSWORD);
	const code = new URL(redirect.headers.get('location') ?? '').searchParams.get('code') ?? '';
	const res = await postToken(baseUrl, {
		grant_type: 'authorization_code',
		code,
		code_verifier: verifier,
		client_id: clientId,
		redirect_uri: CLIENT_REDIRECT_URI,
	});
	if (res.status !== 200) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
	return { clientId, tokens: await res.json() as TokenSet };
}

export function mcpRequest(
	baseUrl: string,
	accessToken: string | undefined,
	message: object,
	accept = 'application/json, text/event-stream',
): Promise<Response> {
	return fetch(`${baseUrl}/mcp`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: accept,
			...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...message }),
	});
}

export const INITIALIZE = {
	method: 'initialize',
	params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
};

/** Reads a JSON-RPC response whether the server answered as JSON or as an SSE event. */
export async function readRpc<T = Record<string, unknown>>(res: Response): Promise<T> {
	const body = await res.text();
	if ((res.headers.get('content-type') ?? '').includes('application/json')) {
		return JSON.parse(body) as T;
	}
	const data = body.split('\n').find(line => line.startsWith('data: '));
	if (!data) throw new Error(`no JSON-RPC message in response: ${body}`);
	return JSON.parse(data.slice('data: '.length)) as T;
}
