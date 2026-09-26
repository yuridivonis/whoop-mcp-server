import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { consentText } from '../src/auth/login-page.js';
import { INITIALIZE, PASSWORD, mcpRequest, pkcePair, postToken, readRpc, startTestServer, type TestServer } from './helpers.js';

/**
 * Each way an MCP client signs in, run end to end: register, open the sign-in page, allow
 * and sign in, exchange the code, call the tools, refresh. These show the server accepts
 * what each app is documented or known to send, not that the app sends it: Claude and
 * ChatGPT were also tested live (26 Sep 2026); the others weren't yet.
 */
interface SignInStyle {
	name: string;
	redirectUri: string;
	/** What the sign-in page should name as the destination. */
	destination: string;
	/** The `resource` the client sends, from the server's base URL; undefined when it sends none. */
	resource: (baseUrl: string) => string | undefined;
	tokenAuth: 'none' | 'client_secret_post';
}

const mcp = (baseUrl: string) => `${baseUrl}/mcp`;

const STYLES: SignInStyle[] = [
	{ name: 'Claude (claude.ai)', redirectUri: 'https://claude.ai/api/mcp/auth_callback', destination: 'claude.ai', resource: mcp, tokenAuth: 'none' },
	{ name: 'Claude (claude.com)', redirectUri: 'https://claude.com/api/mcp/auth_callback', destination: 'claude.com', resource: mcp, tokenAuth: 'none' },
	{
		name: 'ChatGPT, returning to a per-app callback, with the bare server address as the resource',
		redirectUri: 'https://chatgpt.com/connector/oauth/cb_5f2a9c',
		destination: 'chatgpt.com',
		resource: baseUrl => baseUrl,
		tokenAuth: 'none',
	},
	{
		name: 'ChatGPT, returning to its platform callback, with the bare server address as the resource',
		redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect',
		destination: 'chatgpt.com',
		resource: baseUrl => baseUrl,
		tokenAuth: 'client_secret_post',
	},
	{ name: 'a local app on a loopback port (Claude Code, Claude Desktop)', redirectUri: 'http://127.0.0.1:33418/callback', destination: 'an app on this computer', resource: mcp, tokenAuth: 'none' },
	{ name: 'a local app on localhost, sending no resource', redirectUri: 'http://localhost:6274/oauth/callback', destination: 'an app on this computer', resource: () => undefined, tokenAuth: 'none' },
	{ name: 'a desktop app link (Cursor)', redirectUri: 'cursor://anysphere.cursor-mcp/oauth/callback', destination: 'the cursor app on this device', resource: mcp, tokenAuth: 'none' },
	{ name: 'a desktop app link (VS Code)', redirectUri: 'vscode://vscode.mcp/oauth/callback', destination: 'the vscode app on this device', resource: mcp, tokenAuth: 'none' },
	{ name: 'a desktop app link (VS Code Insiders)', redirectUri: 'vscode-insiders://vscode.mcp/oauth/callback', destination: 'the vscode-insiders app on this device', resource: mcp, tokenAuth: 'none' },
	{ name: 'a desktop app link (Windsurf)', redirectUri: 'windsurf://codeium.windsurf/oauth/callback', destination: 'the windsurf app on this device', resource: mcp, tokenAuth: 'none' },
];

async function register(baseUrl: string, style: SignInStyle): Promise<{ client_id: string; client_secret?: string }> {
	const res = await fetch(`${baseUrl}/register`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			client_name: style.name,
			redirect_uris: [style.redirectUri],
			token_endpoint_auth_method: style.tokenAuth,
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
		}),
	});
	assert.equal(res.status, 201, `registers: ${await res.clone().text()}`);
	return await res.json() as { client_id: string; client_secret?: string };
}

describe('sign-in compatibility', () => {
	let server: TestServer;

	before(async () => {
		server = await startTestServer();
	});

	after(async () => {
		await server.close();
	});

	for (const style of STYLES) {
		it(`works for ${style.name}`, async () => {
			const { baseUrl } = server;
			const client = await register(baseUrl, style);
			if (style.tokenAuth === 'client_secret_post') assert.ok(client.client_secret, 'a confidential client gets a secret');
			const resource = style.resource(baseUrl);
			const credentials: Record<string, string> = { client_id: client.client_id, ...(client.client_secret ? { client_secret: client.client_secret } : {}) };

			// The sign-in page names where the code goes.
			const { verifier, challenge } = pkcePair();
			const params = new URLSearchParams({
				client_id: client.client_id,
				redirect_uri: style.redirectUri,
				response_type: 'code',
				code_challenge: challenge,
				code_challenge_method: 'S256',
				state: 'app-state',
				...(resource ? { resource } : {}),
			});
			const page = await fetch(`${baseUrl}/authorize?${params}`);
			assert.equal(page.status, 200);
			assert.ok((await page.text()).includes(consentText(style.destination)), `names ${style.destination}`);

			// The owner allows it and signs in; the app gets its code back where it asked.
			const form = new URLSearchParams(params);
			form.set('password', PASSWORD);
			form.set('consent', 'yes');
			const signedIn = await fetch(`${baseUrl}/authorize`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: form,
				redirect: 'manual',
			});
			assert.equal(signedIn.status, 302);
			const location = signedIn.headers.get('location') ?? '';
			assert.ok(location.startsWith(`${style.redirectUri}?`), `returns to ${style.redirectUri}`);
			const returned = new URL(location);
			assert.equal(returned.searchParams.get('state'), 'app-state');
			const code = returned.searchParams.get('code') ?? '';

			const exchanged = await postToken(baseUrl, {
				grant_type: 'authorization_code',
				code,
				code_verifier: verifier,
				redirect_uri: style.redirectUri,
				...credentials,
				...(resource ? { resource } : {}),
			});
			assert.equal(exchanged.status, 200, await exchanged.clone().text());
			const tokens = await exchanged.json() as { access_token: string; refresh_token: string };

			// The tools answer.
			assert.equal((await mcpRequest(baseUrl, tokens.access_token, INITIALIZE)).status, 200);
			const list = await readRpc<{ result: { tools: { name: string }[] } }>(
				await mcpRequest(baseUrl, tokens.access_token, { method: 'tools/list', params: {} }),
			);
			assert.equal(list.result.tools.length, 6);

			// Refreshing keeps it signed in.
			const refreshed = await postToken(baseUrl, {
				grant_type: 'refresh_token',
				refresh_token: tokens.refresh_token,
				...credentials,
				...(resource ? { resource } : {}),
			});
			assert.equal(refreshed.status, 200, await refreshed.clone().text());
			const renewed = await refreshed.json() as { access_token: string };
			assert.equal((await mcpRequest(baseUrl, renewed.access_token, INITIALIZE)).status, 200);
		});
	}
});

describe("the MCP authorization spec's requirements", () => {
	let server: TestServer;

	before(async () => {
		server = await startTestServer();
	});

	after(async () => {
		await server.close();
	});

	it('publishes protected-resource and authorization-server metadata with what clients need', async () => {
		const { baseUrl } = server;
		const resource = await (await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`)).json() as { resource: string; authorization_servers: string[] };
		assert.equal(resource.resource, `${baseUrl}/mcp`);
		assert.deepEqual(resource.authorization_servers, [`${baseUrl}/`]);

		const metadata = await (await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)).json() as Record<string, unknown>;
		assert.equal(metadata.issuer, `${baseUrl}/`);
		assert.ok(metadata.registration_endpoint, 'dynamic client registration');
		assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
		assert.deepEqual(metadata.response_types_supported, ['code']);
		assert.ok((metadata.grant_types_supported as string[]).includes('refresh_token'));
		assert.ok((metadata.token_endpoint_auth_methods_supported as string[]).includes('none'), 'public clients');
	});

	it('requires PKCE with S256', async () => {
		const client = await register(server.baseUrl, STYLES[0]);
		const base = { client_id: client.client_id, redirect_uri: STYLES[0].redirectUri, response_type: 'code', state: 's' };
		const attempts: Record<string, string>[] = [{}, { code_challenge: pkcePair().challenge, code_challenge_method: 'plain' }];
		for (const extra of attempts) {
			const form = new URLSearchParams({ ...base, ...extra, password: PASSWORD, consent: 'yes' });
			const res = await fetch(`${server.baseUrl}/authorize`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: form,
				redirect: 'manual',
			});
			// Refused as a bad request, sent back to the app, with no code.
			assert.equal(res.status, 302, JSON.stringify(extra));
			const back = new URL(res.headers.get('location') ?? '');
			assert.equal(`${back.origin}${back.pathname}`, STYLES[0].redirectUri);
			assert.equal(back.searchParams.get('error'), 'invalid_request');
			assert.match(back.searchParams.get('error_description') ?? '', /code_challenge/);
			assert.equal(back.searchParams.get('code'), null);
		}
	});

	it('accepts access tokens only in the Authorization header', async () => {
		const client = await register(server.baseUrl, STYLES[0]);
		const { verifier, challenge } = pkcePair();
		const form = new URLSearchParams({
			client_id: client.client_id, redirect_uri: STYLES[0].redirectUri, response_type: 'code',
			code_challenge: challenge, code_challenge_method: 'S256', state: 's', password: PASSWORD, consent: 'yes',
		});
		const signedIn = await fetch(`${server.baseUrl}/authorize`, {
			method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form, redirect: 'manual',
		});
		const code = new URL(signedIn.headers.get('location') ?? '').searchParams.get('code') ?? '';
		const tokens = await (await postToken(server.baseUrl, {
			grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: STYLES[0].redirectUri,
		})).json() as { access_token: string };

		const inQuery = await fetch(`${server.baseUrl}/mcp?access_token=${tokens.access_token}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...INITIALIZE }),
		});
		assert.equal(inQuery.status, 401);
		assert.equal((await mcpRequest(server.baseUrl, tokens.access_token, INITIALIZE)).status, 200);
	});
});
