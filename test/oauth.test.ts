import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
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
	registrationRequest,
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

	it('answers /health without revealing anything about the owner', async () => {
		const res = await fetch(`${server.baseUrl}/health`);
		assert.deepEqual(await res.json(), { status: 'ok' });
	});

	it('accepts the bare server address as the resource, as ChatGPT may send it', async () => {
		const clientId = await registerClient(server.baseUrl);
		const params = authorizeParams(clientId, pkcePair().challenge, { resource: server.baseUrl });
		const res = await submitPassword(server.baseUrl, params, PASSWORD);
		assert.ok(new URL(res.headers.get('location') ?? '').searchParams.get('code'));
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
		const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
		assert.deepEqual(initBody.result.serverInfo, { name: 'whoop-mcp-server', version }, 'reports the version in package.json');

		const list = await mcpRequest(server.baseUrl, tokens.access_token, { method: 'tools/list', params: {} });
		const listBody = await readRpc<{ result: { tools: { name: string }[] } }>(list);
		assert.deepEqual(
			listBody.result.tools.map(tool => tool.name),
			['get_today', 'get_recovery_trends', 'get_sleep_analysis', 'get_strain_history', 'get_workouts', 'get_auth_url'],
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

describe('consent to share WHOOP data', () => {
	let server: TestServer;

	before(async () => {
		server = await startTestServer();
	});

	after(async () => {
		await server.close();
	});

	it('asks the owner to allow the app, naming where the WHOOP data goes', async () => {
		const toClaude = await registerClient(server.baseUrl, 'https://claude.ai/api/mcp/auth_callback');
		const params = authorizeParams(toClaude, pkcePair().challenge, { redirect_uri: 'https://claude.ai/api/mcp/auth_callback' });
		const page = await (await fetch(`${server.baseUrl}/authorize?${params}`)).text();
		assert.match(page, /<input type="checkbox" id="consent" name="consent" value="yes" required>/);
		assert.match(page, /Allow claude\.ai to read your WHOOP recovery, sleep, strain and workouts/);

		const local = await registerClient(server.baseUrl);
		const localPage = await (await fetch(`${server.baseUrl}/authorize?${authorizeParams(local, pkcePair().challenge)}`)).text();
		assert.match(localPage, /Allow an app on this computer to read your WHOOP/);
	});

	it('issues no code, even for the right password, unless the box is ticked', async () => {
		const clientId = await registerClient(server.baseUrl);
		for (const consent of [undefined, 'on', 'no']) {
			const form = new URLSearchParams(authorizeParams(clientId, pkcePair().challenge));
			form.set('password', PASSWORD);
			if (consent) form.set('consent', consent);
			const res = await fetch(`${server.baseUrl}/authorize`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: form,
				redirect: 'manual',
			});
			assert.equal(res.status, 400, String(consent));
			assert.equal(res.headers.get('location'), null);
			assert.match(await res.text(), /tick the box to allow an app on this computer to read your WHOOP data/);
		}
	});

	it('never signs in from a link, even one carrying the password and the tick', async () => {
		const clientId = await registerClient(server.baseUrl);
		const params = authorizeParams(clientId, pkcePair().challenge, { password: PASSWORD, consent: 'yes' });
		const res = await fetch(`${server.baseUrl}/authorize?${params}`, { redirect: 'manual' });
		assert.equal(res.status, 200);
		assert.equal(res.headers.get('location'), null);
		assert.match(await res.text(), /name="consent"/);
	});

	it('names where the code goes, not what the app calls itself', async () => {
		const res = await fetch(`${server.baseUrl}/register`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ client_name: 'claude.ai', redirect_uris: [CLIENT_REDIRECT_URI], token_endpoint_auth_method: 'none' }),
		});
		const { client_id: clientId } = await res.json() as { client_id: string };
		const page = await (await fetch(`${server.baseUrl}/authorize?${authorizeParams(clientId, pkcePair().challenge)}`)).text();
		assert.match(page, /Allow an app on this computer to read your WHOOP/);
		assert.doesNotMatch(page, /Allow claude\.ai/);
	});

	it('records when the owner allowed the app', async () => {
		const clientId = await registerClient(server.baseUrl);
		const before = Date.now();
		const code = await authorizationCode(server.baseUrl, clientId, pkcePair().challenge);
		const stored = server.db.getOAuthCode(createHash('sha256').update(code).digest('hex'));
		assert.ok(stored && stored.consented_at >= before && stored.consented_at <= Date.now());
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

/** Runs a test against a database file that outlives one server. */
async function withDatabaseFile(test: (dbPath: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), 'whoop-mcp-test-'));
	try {
		await test(join(dir, 'whoop.db'));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe('sign-in state', () => {
	it('survives a restart, so a redeploy does not sign Claude out', async () => {
		await withDatabaseFile(async dbPath => {
			const first = await startTestServer({ dbPath });
			const { tokens } = await signIn(first.baseUrl);
			await first.close();

			const second = await startTestServer({ dbPath });
			try {
				assert.equal((await mcpRequest(second.baseUrl, tokens.access_token, INITIALIZE)).status, 200);
			} finally {
				await second.close();
			}
		});
	});

	it('is revoked for every client when MCP_AUTH_PASSWORD changes', async () => {
		await withDatabaseFile(async dbPath => {
			const first = await startTestServer({ dbPath });
			const { clientId, tokens } = await signIn(first.baseUrl);
			await first.close();

			const logged: string[] = [];
			const second = await startTestServer({ dbPath, password: 'a completely new password', log: line => logged.push(line) });
			try {
				assert.equal((await mcpRequest(second.baseUrl, tokens.access_token, INITIALIZE)).status, 401);
				const refresh = await postToken(second.baseUrl, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
				assert.equal(refresh.status, 400);
				assert.ok(logged.some(line => line.includes('MCP_AUTH_PASSWORD changed')), 'the sign-out should be logged');
			} finally {
				await second.close();
			}
		});
	});

	it('shuts out a server still running with the old password, including its own sign-ins', async () => {
		await withDatabaseFile(async dbPath => {
			const stale = await startTestServer({ dbPath });
			try {
				const { clientId, tokens } = await signIn(stale.baseUrl);
				assert.equal((await mcpRequest(stale.baseUrl, tokens.access_token, INITIALIZE)).status, 200);
				const oldGeneration = (JSON.parse(stale.db.getSetting('mcp_auth_password') ?? '{}') as { generation: string }).generation;

				// A restart with a new password happens while the old server is still up.
				const current = await startTestServer({ dbPath, password: 'a completely new password' });
				try {
					for (const server of [stale, current]) {
						assert.equal((await mcpRequest(server.baseUrl, tokens.access_token, INITIALIZE)).status, 401);
						const refresh = await postToken(server.baseUrl, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
						assert.equal(refresh.status, 400);
					}
					// The old server won't sign anyone in with the old password any more.
					const retry = await submitPassword(stale.baseUrl, authorizeParams(clientId, pkcePair().challenge), PASSWORD);
					assert.equal(retry.status, 503);
					assert.equal(retry.headers.get('location'), null);

					// A token the old server finished minting just as the password changed.
					const raced = 'token-minted-during-the-password-change';
					stale.db.saveOAuthToken({
						token_hash: createHash('sha256').update(raced).digest('hex'),
						family_id: 'raced-family',
						generation: oldGeneration,
						kind: 'access',
						client_id: clientId,
						scopes: '',
						expires_at: Date.now() + 3_600_000,
					});
					assert.equal((await mcpRequest(stale.baseUrl, raced, INITIALIZE)).status, 401);
				} finally {
					await current.close();
				}
			} finally {
				await stale.close();
			}
		});
	});

	it('signs every app out once when upgrading from a version that did not ask for consent', async t => {
		const logged: string[] = [];
		t.mock.method(process.stderr, 'write', (chunk: string) => {
			logged.push(chunk);
			return true;
		});
		await withDatabaseFile(async dbPath => {
			// A 1.2.0 sign-in: an app registered, and its live access token.
			const first = await startTestServer({ dbPath });
			const { clientId, tokens } = await signIn(first.baseUrl);
			await first.close();
			const legacy = new Database(dbPath);
			legacy.exec(`
				CREATE TABLE codes_1_2_0 AS SELECT code_hash, family_id, generation, client_id, code_challenge, redirect_uri, scopes, expires_at, consumed_at FROM oauth_codes;
				DROP TABLE oauth_codes;
				ALTER TABLE codes_1_2_0 RENAME TO oauth_codes;
			`);
			legacy.close();

			const upgraded = await startTestServer({ dbPath });
			try {
				assert.equal((await mcpRequest(upgraded.baseUrl, tokens.access_token, INITIALIZE)).status, 401);
				assert.ok(logged.some(line => line.startsWith('Signed every app out')));
				// The app stays registered, so it only has to sign in again, this time with the box.
				const code = await authorizationCode(upgraded.baseUrl, clientId, pkcePair().challenge);
				assert.ok(code);
			} finally {
				await upgraded.close();
			}
		});
	});

	it('signs clients out once when upgrading a database from before sign-in generations', async () => {
		await withDatabaseFile(async dbPath => {
			// The sign-in tables as an earlier 1.1.0 build created them, with a live access token.
			const legacy = new Database(dbPath);
			legacy.exec(`
				CREATE TABLE oauth_codes (code_hash TEXT PRIMARY KEY, family_id TEXT NOT NULL, client_id TEXT NOT NULL,
					code_challenge TEXT NOT NULL, redirect_uri TEXT NOT NULL, scopes TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER);
				CREATE TABLE oauth_tokens (token_hash TEXT PRIMARY KEY, family_id TEXT NOT NULL, kind TEXT NOT NULL,
					client_id TEXT NOT NULL, scopes TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER);
			`);
			legacy.prepare('INSERT INTO oauth_tokens VALUES (?, ?, ?, ?, ?, ?, NULL)')
				.run(createHash('sha256').update('legacy-access-token').digest('hex'), 'family', 'access', 'client', '', Date.now() + 3_600_000);
			legacy.close();

			const server = await startTestServer({ dbPath });
			try {
				assert.equal((await mcpRequest(server.baseUrl, 'legacy-access-token', INITIALIZE)).status, 401);
				const { tokens } = await signIn(server.baseUrl);
				assert.equal((await mcpRequest(server.baseUrl, tokens.access_token, INITIALIZE)).status, 200);
			} finally {
				await server.close();
			}
		});
	});
});

describe('where sign-in codes may be sent', () => {
	let server: TestServer;

	before(async () => {
		server = await startTestServer({ env: { MCP_ALLOWED_REDIRECT_HOSTS: 'mcp-client.example' } });
	});

	after(async () => {
		await server.close();
	});

	it('refuses to register a client with no allowed address', async () => {
		const notAllowed = [
			'https://attacker.example/callback',
			'http://attacker.example/callback',
			// App links whose handlers fetch the address over the network.
			'webcal://attacker.example/callback',
			'web+capture://attacker.example/callback',
		];
		for (const uri of notAllowed) {
			const res = await registrationRequest(server.baseUrl, [uri]);
			assert.equal(res.status, 400, uri);
			const body = await res.json() as { error: string; error_description: string };
			assert.equal(body.error, 'invalid_client_metadata');
			assert.match(body.error_description, /MCP_ALLOWED_REDIRECT_HOSTS/);
		}
	});

	it('registers Claude, ChatGPT, apps on this device, and hosts added with MCP_ALLOWED_REDIRECT_HOSTS', async () => {
		const allowed = [
			'https://claude.ai/api/mcp/auth_callback',
			'https://claude.com/api/mcp/auth_callback',
			'https://chatgpt.com/connector_platform_oauth_redirect',
			'http://127.0.0.1:33418/callback',
			'http://localhost:8787/callback',
			'cursor://anysphere.cursor-mcp/oauth/callback',
			'https://mcp-client.example/oauth/callback',
		];
		for (const uri of allowed) {
			assert.equal((await registrationRequest(server.baseUrl, [uri])).status, 201, uri);
		}
	});

	it('registers a client with a spare address, but never signs in through the spare', async () => {
		const res = await registrationRequest(server.baseUrl, ['https://attacker.example/callback', CLIENT_REDIRECT_URI]);
		assert.equal(res.status, 201);
		const { client_id: clientId, redirect_uris: registered } = await res.json() as { client_id: string; redirect_uris: string[] };
		assert.deepEqual(registered, [CLIENT_REDIRECT_URI], 'only the allowed address is registered');

		// A malformed request can't bounce the browser to the spare either (no open redirect).
		const malformed = authorizeParams(clientId, pkcePair().challenge, { redirect_uri: 'https://attacker.example/callback', response_type: 'invalid' });
		const bounce = await fetch(`${server.baseUrl}/authorize?${malformed}`, { redirect: 'manual' });
		assert.equal(bounce.status, 400);
		assert.equal(bounce.headers.get('location'), null);

		const params = authorizeParams(clientId, pkcePair().challenge, { redirect_uri: 'https://attacker.example/callback' });
		const attempt = await submitPassword(server.baseUrl, params, PASSWORD);
		assert.equal(attempt.status, 400);
		assert.equal(attempt.headers.get('location'), null);

		const local = await submitPassword(server.baseUrl, authorizeParams(clientId, pkcePair().challenge), PASSWORD);
		assert.equal(local.status, 302);
	});

	it('refuses to sign in a client that was registered before the allowlist', async () => {
		const clientId = 'registered-before-the-allowlist';
		const redirectUri = 'https://attacker.example/callback';
		server.db.saveOAuthClient(clientId, JSON.stringify({ client_id: clientId, redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }));
		const params = authorizeParams(clientId, pkcePair().challenge, { redirect_uri: redirectUri });

		const page = await fetch(`${server.baseUrl}/authorize?${params}`, { redirect: 'manual' });
		assert.equal(page.status, 400);
		assert.equal(page.headers.get('location'), null);

		const malformed = new URLSearchParams(params);
		malformed.set('response_type', 'invalid');
		const bounce = await fetch(`${server.baseUrl}/authorize?${malformed}`, { redirect: 'manual' });
		assert.equal(bounce.status, 400);
		assert.equal(bounce.headers.get('location'), null);

		const res = await submitPassword(server.baseUrl, params, PASSWORD);
		assert.equal(res.status, 400);
		assert.equal(res.headers.get('location'), null);
	});

	it('shows where you will return, and asks you to sign in only if you started it', async () => {
		const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
		const clientId = await registerClient(server.baseUrl, redirectUri);
		const page = await fetch(`${server.baseUrl}/authorize?${authorizeParams(clientId, pkcePair().challenge, { redirect_uri: redirectUri })}`);
		const html = await page.text();
		assert.match(html, /return to <strong>claude\.ai<\/strong>/);
		assert.match(html, /If someone sent you this link, close this page/);

		const localClient = await registerClient(server.baseUrl);
		const localPage = await (await fetch(`${server.baseUrl}/authorize?${authorizeParams(localClient, pkcePair().challenge)}`)).text();
		assert.match(localPage, /return to <strong>an app on this computer<\/strong>/);
	});
});

describe('sign-in log', () => {
	it('records each successful sign-in with the app, its client id and where it returned', async () => {
		const logged: string[] = [];
		const server = await startTestServer({ log: line => logged.push(line) });
		try {
			const { clientId } = await signIn(server.baseUrl);
			assert.deepEqual(logged, [`Signed in: client ${clientId}, returning to an app on this computer, app "Test Client"`]);
		} finally {
			await server.close();
		}
	});

	it('cannot be forged with line breaks, quotes, terminal codes or right-to-left marks in an app name', async () => {
		const logged: string[] = [];
		const server = await startTestServer({ log: line => logged.push(line) });
		try {
			const res = await fetch(`${server.baseUrl}/register`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					client_name: 'Claude", returning to claude.ai\nSigned in: client 1\u001b[2K\u202e',
					redirect_uris: [CLIENT_REDIRECT_URI],
					token_endpoint_auth_method: 'none',
				}),
			});
			const { client_id: clientId } = await res.json() as { client_id: string };
			const { challenge } = pkcePair();
			await submitPassword(server.baseUrl, authorizeParams(clientId, challenge), PASSWORD);

			assert.equal(logged.length, 1);
			assert.doesNotMatch(logged[0], /[\u0000-\u001f\u202e]/);
			// The server's own fields come first and can't be displaced by the name.
			assert.ok(logged[0].startsWith(`Signed in: client ${clientId}, returning to an app on this computer, app "`), logged[0]);
			assert.match(logged[0], /app "Claude\\", returning/, 'the quote in the name is escaped');
		} finally {
			await server.close();
		}
	});
});
