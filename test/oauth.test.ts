import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	CLIENT_REDIRECT_URI,
	INITIALIZE,
	PASSWORD,
	authorizationCode,
	authorizeParams,
	mcpRequest,
	pkcePair,
	postToken,
	readRpc,
	registerClient,
	signIn,
	startTestServer,
	submitPassword,
	type TestServer,
} from './helpers.js';

describe('sign-in protects /mcp', () => {
	let server: TestServer;

	before(async () => {
		server = await startTestServer();
	});

	after(async () => {
		await server.close();
	});

	it('rejects requests without a token and points clients to the sign-in metadata', async () => {
		const res = await mcpRequest(server.baseUrl, undefined, INITIALIZE);
		assert.equal(res.status, 401);
		assert.match(
			res.headers.get('www-authenticate') ?? '',
			new RegExp(`resource_metadata="${server.baseUrl}/.well-known/oauth-protected-resource/mcp"`),
		);
	});

	it('rejects a made-up token', async () => {
		const res = await mcpRequest(server.baseUrl, 'not-a-real-token', INITIALIZE);
		assert.equal(res.status, 401);
	});

	it('publishes discovery metadata for Claude.ai', async () => {
		const resource = await (await fetch(`${server.baseUrl}/.well-known/oauth-protected-resource/mcp`)).json() as {
			resource: string;
			authorization_servers: string[];
		};
		assert.equal(resource.resource, `${server.baseUrl}/mcp`);
		assert.deepEqual(resource.authorization_servers, [`${server.baseUrl}/`]);

		const metadata = await (await fetch(`${server.baseUrl}/.well-known/oauth-authorization-server`)).json() as {
			authorization_endpoint: string;
			registration_endpoint: string;
			code_challenge_methods_supported: string[];
		};
		assert.equal(metadata.authorization_endpoint, `${server.baseUrl}/authorize`);
		assert.equal(metadata.registration_endpoint, `${server.baseUrl}/register`);
		assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
	});

	it('shows a sign-in page that cannot be framed', async () => {
		const clientId = await registerClient(server.baseUrl);
		const res = await fetch(`${server.baseUrl}/authorize?${authorizeParams(clientId, pkcePair().challenge)}`);
		assert.equal(res.status, 200);
		assert.equal(res.headers.get('x-frame-options'), 'DENY');
		assert.match(await res.text(), /name="password"/);
	});

	it('rejects a wrong password without issuing a code', async () => {
		const clientId = await registerClient(server.baseUrl);
		const res = await submitPassword(server.baseUrl, authorizeParams(clientId, pkcePair().challenge), 'wrong password');
		assert.equal(res.status, 401);
		assert.equal(res.headers.get('location'), null);
		assert.match(await res.text(), /Incorrect password/);
	});

	it('redirects back with a code and the client state after the right password', async () => {
		const clientId = await registerClient(server.baseUrl);
		const res = await submitPassword(server.baseUrl, authorizeParams(clientId, pkcePair().challenge), PASSWORD);
		assert.equal(res.status, 302);
		const location = new URL(res.headers.get('location') ?? '');
		assert.equal(`${location.origin}${location.pathname}`, CLIENT_REDIRECT_URI);
		assert.ok(location.searchParams.get('code'));
		assert.equal(location.searchParams.get('state'), 'client-state');
	});

	it('refuses to sign in for another server or another path on this one', async () => {
		const clientId = await registerClient(server.baseUrl);
		for (const resource of ['https://other.example/mcp', `${server.baseUrl}/callback`]) {
			const params = authorizeParams(clientId, pkcePair().challenge, { resource });
			const res = await submitPassword(server.baseUrl, params, PASSWORD);
			assert.equal(res.status, 302, resource);
			assert.equal(new URL(res.headers.get('location') ?? '').searchParams.get('error'), 'invalid_target', resource);
		}
	});

	it('accepts this server\'s own /mcp as the resource', async () => {
		const clientId = await registerClient(server.baseUrl);
		const params = authorizeParams(clientId, pkcePair().challenge, { resource: `${server.baseUrl}/mcp` });
		const res = await submitPassword(server.baseUrl, params, PASSWORD);
		assert.ok(new URL(res.headers.get('location') ?? '').searchParams.get('code'));
	});

	it('refuses to issue tokens for another server at the token endpoint', async () => {
		const clientId = await registerClient(server.baseUrl);
		const { verifier, challenge } = pkcePair();
		const code = await authorizationCode(server.baseUrl, clientId, challenge);
		const res = await postToken(server.baseUrl, {
			grant_type: 'authorization_code',
			code,
			code_verifier: verifier,
			client_id: clientId,
			redirect_uri: CLIENT_REDIRECT_URI,
			resource: 'https://other.example/mcp',
		});
		assert.equal(res.status, 400);
		assert.equal((await res.json() as { error: string }).error, 'invalid_target');

		const { clientId: refreshingClient, tokens } = await signIn(server.baseUrl);
		const refresh = await postToken(server.baseUrl, {
			grant_type: 'refresh_token',
			refresh_token: tokens.refresh_token,
			client_id: refreshingClient,
			resource: 'https://other.example/mcp',
		});
		assert.equal(refresh.status, 400);
		assert.equal((await refresh.json() as { error: string }).error, 'invalid_target');
	});

	it('serves MCP to a signed-in client', async () => {
		const { tokens } = await signIn(server.baseUrl);

		const init = await mcpRequest(server.baseUrl, tokens.access_token, INITIALIZE);
		assert.equal(init.status, 200);
		const initBody = await readRpc<{ result: { serverInfo: { name: string; version: string } } }>(init);
		assert.deepEqual(initBody.result.serverInfo, { name: 'whoop-mcp-server', version: '1.1.0' });

		const list = await mcpRequest(server.baseUrl, tokens.access_token, { method: 'tools/list', params: {} });
		const listBody = await readRpc<{ result: { tools: { name: string }[] } }>(list);
		assert.deepEqual(
			listBody.result.tools.map(tool => tool.name),
			['get_today', 'get_recovery_trends', 'get_sleep_analysis', 'get_strain_history', 'sync_data', 'get_auth_url'],
		);
	});

	it('accepts clients that leave text/event-stream out of Accept', async () => {
		const { tokens } = await signIn(server.baseUrl);
		const res = await mcpRequest(server.baseUrl, tokens.access_token, INITIALIZE, 'application/json');
		assert.equal(res.status, 200);
	});

	it('answers GET and DELETE on /mcp with 405, since there are no sessions', async () => {
		const { tokens } = await signIn(server.baseUrl);
		for (const method of ['GET', 'DELETE']) {
			const res = await fetch(`${server.baseUrl}/mcp`, { method, headers: { Authorization: `Bearer ${tokens.access_token}` } });
			assert.equal(res.status, 405, method);
		}
	});

	it('exchanges an authorization code only once', async () => {
		const clientId = await registerClient(server.baseUrl);
		const { verifier, challenge } = pkcePair();
		const redirect = await submitPassword(server.baseUrl, authorizeParams(clientId, challenge), PASSWORD);
		const code = new URL(redirect.headers.get('location') ?? '').searchParams.get('code') ?? '';
		const exchange = { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: CLIENT_REDIRECT_URI };

		assert.equal((await postToken(server.baseUrl, exchange)).status, 200);
		const replay = await postToken(server.baseUrl, exchange);
		assert.equal(replay.status, 400);
		assert.equal((await replay.json() as { error: string }).error, 'invalid_grant');
	});

	it('rejects a code exchange with the wrong PKCE verifier', async () => {
		const clientId = await registerClient(server.baseUrl);
		const redirect = await submitPassword(server.baseUrl, authorizeParams(clientId, pkcePair().challenge), PASSWORD);
		const code = new URL(redirect.headers.get('location') ?? '').searchParams.get('code') ?? '';
		const res = await postToken(server.baseUrl, {
			grant_type: 'authorization_code',
			code,
			code_verifier: pkcePair().verifier,
			client_id: clientId,
			redirect_uri: CLIENT_REDIRECT_URI,
		});
		assert.equal(res.status, 400);
	});

	it('rotates refresh tokens and refuses a replayed one', async () => {
		const { clientId, tokens } = await signIn(server.baseUrl);
		const refresh = { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId };

		const first = await postToken(server.baseUrl, refresh);
		assert.equal(first.status, 200);
		const rotated = await first.json() as { access_token: string; refresh_token: string };
		assert.notEqual(rotated.refresh_token, tokens.refresh_token);
		assert.equal((await mcpRequest(server.baseUrl, rotated.access_token, INITIALIZE)).status, 200);

		assert.equal((await postToken(server.baseUrl, refresh)).status, 400);
	});

	it('cuts off the whole sign-in when a refresh token is replayed', async () => {
		const { clientId, tokens } = await signIn(server.baseUrl);
		const stolen = { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId };

		// The attacker refreshes first and gets a fresh pair...
		const attackerRes = await postToken(server.baseUrl, stolen);
		assert.equal(attackerRes.status, 200);
		const attacker = await attackerRes.json() as { access_token: string; refresh_token: string };
		assert.equal((await mcpRequest(server.baseUrl, attacker.access_token, INITIALIZE)).status, 200);
		// ...then the real client presents the same token, which shows it leaked.
		assert.equal((await postToken(server.baseUrl, stolen)).status, 400);

		assert.equal((await mcpRequest(server.baseUrl, attacker.access_token, INITIALIZE)).status, 401);
		const attackerRefresh = await postToken(server.baseUrl, { ...stolen, refresh_token: attacker.refresh_token });
		assert.equal(attackerRefresh.status, 400);
	});

	it('revokes the tokens from an authorization code that is exchanged twice', async () => {
		const clientId = await registerClient(server.baseUrl);
		const { verifier, challenge } = pkcePair();
		const code = await authorizationCode(server.baseUrl, clientId, challenge);
		const exchange = { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: CLIENT_REDIRECT_URI };

		const firstRes = await postToken(server.baseUrl, exchange);
		assert.equal(firstRes.status, 200);
		const first = await firstRes.json() as { access_token: string };
		assert.equal((await mcpRequest(server.baseUrl, first.access_token, INITIALIZE)).status, 200);
		assert.equal((await postToken(server.baseUrl, exchange)).status, 400);
		assert.equal((await mcpRequest(server.baseUrl, first.access_token, INITIALIZE)).status, 401);
	});

	it('revokes the access token too when a refresh token is revoked', async () => {
		const { clientId, tokens } = await signIn(server.baseUrl);
		const revoke = await fetch(`${server.baseUrl}/revoke`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ token: tokens.refresh_token, client_id: clientId }),
		});
		assert.equal(revoke.status, 200);
		assert.equal((await mcpRequest(server.baseUrl, tokens.access_token, INITIALIZE)).status, 401);
	});

	it('stops accepting a revoked access token', async () => {
		const { clientId, tokens } = await signIn(server.baseUrl);
		const revoke = await fetch(`${server.baseUrl}/revoke`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ token: tokens.access_token, client_id: clientId }),
		});
		assert.equal(revoke.status, 200);
		assert.equal((await mcpRequest(server.baseUrl, tokens.access_token, INITIALIZE)).status, 401);
	});

	it('does not store tokens in plain text', async () => {
		const { tokens } = await signIn(server.baseUrl);
		assert.equal(server.db.getOAuthToken(tokens.access_token, 'access'), undefined);
	});
});

describe('failed sign-ins', () => {
	let server: TestServer;

	before(async () => {
		server = await startTestServer();
	});

	after(async () => {
		await server.close();
	});

	it('are limited to 10 per address every 15 minutes', async () => {
		const clientId = await registerClient(server.baseUrl);
		const params = authorizeParams(clientId, pkcePair().challenge);
		for (let attempt = 1; attempt <= 10; attempt++) {
			assert.equal((await submitPassword(server.baseUrl, params, `guess ${attempt}`)).status, 401);
		}
		assert.equal((await submitPassword(server.baseUrl, params, 'guess 11')).status, 429);
		// Even the right password waits out the window, or guessing would still pay off.
		assert.equal((await submitPassword(server.baseUrl, params, PASSWORD)).status, 429);
	});
});

describe('failed sign-in limits', () => {
	it('cover every path that reaches the sign-in form', async () => {
		const server = await startTestServer();
		try {
			const clientId = await registerClient(server.baseUrl);
			const params = authorizeParams(clientId, pkcePair().challenge);
			const paths = ['/authorize', '/authorize/', '/authorize//', '/AUTHORIZE'];
			for (let attempt = 0; attempt < 10; attempt++) {
				const path = paths[attempt % paths.length];
				assert.equal((await submitPassword(server.baseUrl, params, `guess ${attempt}`, { path })).status, 401, path);
			}
			for (const path of paths) {
				assert.equal((await submitPassword(server.baseUrl, params, 'one more guess', { path })).status, 429, path);
			}
		} finally {
			await server.close();
		}
	});

	it('cannot be dodged with a forged X-Forwarded-For header', async t => {
		// express-rate-limit warns about the forged header; in production that warning
		// points a self-hoster behind a proxy to TRUST_PROXY, here it is expected.
		t.mock.method(console, 'error', () => {});
		const server = await startTestServer();
		try {
			const clientId = await registerClient(server.baseUrl);
			const params = authorizeParams(clientId, pkcePair().challenge);
			for (let attempt = 0; attempt < 10; attempt++) {
				const headers = { 'X-Forwarded-For': `203.0.113.${attempt}` };
				assert.equal((await submitPassword(server.baseUrl, params, `guess ${attempt}`, { headers })).status, 401);
			}
			const headers = { 'X-Forwarded-For': '198.51.100.1' };
			assert.equal((await submitPassword(server.baseUrl, params, 'one more guess', { headers })).status, 429);
		} finally {
			await server.close();
		}
	});
});

describe('refresh-token replay detection', () => {
	it('still works after the replayed token\'s own expiry, while its family is alive', async t => {
		const DAY = 24 * 60 * 60 * 1000;
		let now = Date.now();
		t.mock.method(Date, 'now', () => now);

		const server = await startTestServer();
		try {
			const { clientId, tokens } = await signIn(server.baseUrl);
			const refresh = (refreshToken: string) =>
				postToken(server.baseUrl, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
			const refreshOk = async (refreshToken: string) => {
				const res = await refresh(refreshToken);
				assert.equal(res.status, 200);
				return await res.json() as { refresh_token: string };
			};

			// An attacker steals the refresh token and keeps its family alive past the
			// stolen token's own 30-day expiry by refreshing every 20 days.
			let attacker = await refreshOk(tokens.refresh_token);
			for (let step = 0; step < 2; step++) {
				now += 20 * DAY;
				attacker = await refreshOk(attacker.refresh_token);
			}

			// 40 days in, the owner's client finally presents the stolen (long expired) token.
			assert.equal((await refresh(tokens.refresh_token)).status, 400);
			assert.equal((await refresh(attacker.refresh_token)).status, 400, 'the attacker\'s family should be revoked');
		} finally {
			await server.close();
		}
	});

	it('also catches an authorization code replayed after the code itself expired', async t => {
		let now = Date.now();
		t.mock.method(Date, 'now', () => now);

		const server = await startTestServer();
		try {
			const clientId = await registerClient(server.baseUrl);
			const { verifier, challenge } = pkcePair();
			const code = await authorizationCode(server.baseUrl, clientId, challenge);
			const exchange = { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: CLIENT_REDIRECT_URI };
			const firstRes = await postToken(server.baseUrl, exchange);
			assert.equal(firstRes.status, 200);
			const first = await firstRes.json() as { refresh_token: string };

			// Well past the code's 5-minute life, a refresh runs the expiry cleanup...
			now += 60 * 60 * 1000;
			const refreshed = await postToken(server.baseUrl, {
				grant_type: 'refresh_token',
				refresh_token: first.refresh_token,
				client_id: clientId,
			});
			assert.equal(refreshed.status, 200);
			const current = await refreshed.json() as { access_token: string };
			assert.equal((await mcpRequest(server.baseUrl, current.access_token, INITIALIZE)).status, 200);

			// ...and the replayed code still revokes the family.
			assert.equal((await postToken(server.baseUrl, exchange)).status, 400);
			assert.equal((await mcpRequest(server.baseUrl, current.access_token, INITIALIZE)).status, 401);
		} finally {
			await server.close();
		}
	});
});

describe('sign-in state', () => {
	it('survives a restart, so a redeploy does not sign Claude out', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'whoop-mcp-test-'));
		const dbPath = join(dir, 'whoop.db');
		try {
			const first = await startTestServer(dbPath);
			const { tokens } = await signIn(first.baseUrl);
			await first.close();

			const second = await startTestServer(dbPath);
			try {
				assert.equal((await mcpRequest(second.baseUrl, tokens.access_token, INITIALIZE)).status, 200);
			} finally {
				await second.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
