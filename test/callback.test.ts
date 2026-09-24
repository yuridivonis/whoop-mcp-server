import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mcpRequest, readRpc, signIn, startTestServer, type TestServer } from './helpers.js';

describe('WHOOP authorization callback', () => {
	let server: TestServer;

	before(async () => {
		server = await startTestServer();
	});

	after(async () => {
		await server.close();
	});

	it('rejects a callback without state', async () => {
		const res = await fetch(`${server.baseUrl}/callback?code=attacker-code`);
		assert.equal(res.status, 400);
		assert.deepEqual(server.exchangedCodes, []);
	});

	it('rejects a state this server never issued', async () => {
		const res = await fetch(`${server.baseUrl}/callback?code=attacker-code&state=made-up`);
		assert.equal(res.status, 400);
		assert.deepEqual(server.exchangedCodes, []);
	});

	it('reports a denied authorization without exchanging anything', async () => {
		const state = server.authStates.issue();
		const res = await fetch(`${server.baseUrl}/callback?error=access_denied&state=${state}`);
		assert.equal(res.status, 400);
		assert.deepEqual(server.exchangedCodes, []);
	});

	it('accepts the link from get_auth_url exactly once', async () => {
		const { tokens } = await signIn(server.baseUrl);
		const call = await mcpRequest(server.baseUrl, tokens.access_token, {
			method: 'tools/call',
			params: { name: 'get_auth_url', arguments: {} },
		});
		const body = await readRpc<{ result: { content: { text: string }[] } }>(call);
		const link = body.result.content[0].text.match(/Visit: (\S+)/)?.[1] ?? '';
		const state = new URL(link).searchParams.get('state') ?? '';
		assert.ok(state.length >= 32, 'state should be long and random');

		const first = await fetch(`${server.baseUrl}/callback?code=owner-code&state=${state}`);
		assert.equal(first.status, 200);
		assert.deepEqual(server.exchangedCodes, ['owner-code']);
		assert.ok(server.db.getTokens(), 'WHOOP tokens should be saved');

		const replay = await fetch(`${server.baseUrl}/callback?code=second-code&state=${state}`);
		assert.equal(replay.status, 400);
		assert.deepEqual(server.exchangedCodes, ['owner-code']);
	});
});
