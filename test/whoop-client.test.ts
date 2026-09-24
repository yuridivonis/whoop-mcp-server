import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { WhoopAuthError, WhoopClient } from '../src/whoop-client.js';
import type { WhoopTokens } from '../src/types.js';

const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';

type ApiHandler = (url: URL, bearer: string) => Response | Promise<Response>;

interface FakeWhoop {
	tokenCalls: number;
	apiCalls: URL[];
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Replaces fetch with a fake WHOOP: the token endpoint issues "new-access", the API calls `api`. */
function fakeWhoop(api: ApiHandler, tokenStatus = 200): FakeWhoop {
	const fake: FakeWhoop = { tokenCalls: 0, apiCalls: [] };
	mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
		const url = new URL(input);
		if (url.href === TOKEN_URL) {
			fake.tokenCalls++;
			// Keep the refresh in flight long enough for parallel callers to pile up.
			await new Promise(resolve => setTimeout(resolve, 20));
			return tokenStatus === 200
				? json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 })
				: json({ error: 'invalid_grant' }, tokenStatus);
		}
		fake.apiCalls.push(url);
		const bearer = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? '';
		return api(url, bearer);
	});
	return fake;
}

function clientWithTokens(expiresInMs: number): { client: WhoopClient; saved: WhoopTokens[] } {
	const saved: WhoopTokens[] = [];
	const client = new WhoopClient({
		clientId: 'client-id',
		clientSecret: 'client-secret',
		redirectUri: 'http://localhost:3000/callback',
		onTokenRefresh: tokens => saved.push(tokens),
	});
	client.setTokens({ access_token: 'old-access', refresh_token: 'old-refresh', expires_at: Date.now() + expiresInMs });
	return { client, saved };
}

const HOUR = 60 * 60 * 1000;
const empty = (): Response => json({ records: [] });

describe('WhoopClient token refresh', () => {
	afterEach(() => mock.restoreAll());

	it('shares one refresh between the four parallel requests of a sync', async () => {
		const fake = fakeWhoop(empty);
		const { client, saved } = clientWithTokens(60_000); // inside the 5-minute refresh window

		await Promise.all([
			client.getAllCycles(),
			client.getAllRecoveries(),
			client.getAllSleeps(),
			client.getAllWorkouts(),
		]);

		assert.equal(fake.tokenCalls, 1);
		assert.equal(saved.length, 1);
		assert.equal(saved[0].refresh_token, 'new-refresh');
	});

	it('refreshes once and retries once after a 401', async () => {
		const fake = fakeWhoop((_url, bearer) => (bearer === 'new-access' ? json({ records: [{ id: 1 }] }) : json({}, 401)));
		const { client } = clientWithTokens(HOUR);

		const cycles = await client.getAllCycles();

		assert.equal(cycles.length, 1);
		assert.equal(fake.tokenCalls, 1);
		assert.equal(fake.apiCalls.length, 2);
	});

	it('gives up with WhoopAuthError when the retry is rejected too', async () => {
		const fake = fakeWhoop(() => json({}, 401));
		const { client } = clientWithTokens(HOUR);

		await assert.rejects(client.getAllCycles(), WhoopAuthError);
		assert.equal(fake.tokenCalls, 1);
		assert.equal(fake.apiCalls.length, 2);
	});

	it('asks the user to reconnect when WHOOP refuses the refresh token', async () => {
		fakeWhoop(() => json({}, 401), 400);
		const { client } = clientWithTokens(HOUR);

		await assert.rejects(client.getAllCycles(), /get_auth_url/);
	});
});

describe('WhoopClient pagination', () => {
	afterEach(() => mock.restoreAll());

	it('follows next_token until the last page', async () => {
		const fake = fakeWhoop(url => {
			const page = Number(url.searchParams.get('nextToken') ?? 0);
			return json({ records: [{ id: page }], ...(page < 2 ? { next_token: String(page + 1) } : {}) });
		});
		const { client } = clientWithTokens(HOUR);

		const sleeps = await client.getAllSleeps({ start: '2026-01-01T00:00:00.000Z' });

		assert.equal(sleeps.length, 3);
		assert.equal(fake.apiCalls.length, 3);
		assert.equal(fake.apiCalls[0].searchParams.get('start'), '2026-01-01T00:00:00.000Z');
	});

	it('stops when WHOOP returns the same cursor twice', async () => {
		const fake = fakeWhoop(() => json({ records: [], next_token: 'stuck' }));
		const { client } = clientWithTokens(HOUR);

		await assert.rejects(client.getAllWorkouts(), /same page cursor/);
		assert.equal(fake.apiCalls.length, 2);
	});

	it('stops after 100 pages', async () => {
		let page = 0;
		const fake = fakeWhoop(() => json({ records: [], next_token: `page-${++page}` }));
		const { client } = clientWithTokens(HOUR);

		await assert.rejects(client.getAllCycles(), /after 100 pages/);
		assert.equal(fake.apiCalls.length, 100);
	});
});

describe('WhoopClient authorization URL', () => {
	it('carries the state it was given', () => {
		const { client } = clientWithTokens(HOUR);
		const url = new URL(client.getAuthorizationUrl(['read:sleep'], 'issued-state'));
		assert.equal(url.searchParams.get('state'), 'issued-state');
		assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:3000/callback');
	});
});
