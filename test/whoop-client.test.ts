import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WhoopAuthError, WhoopClient, WhoopRateLimitError, WhoopRequestError, WhoopUnavailableError } from '../src/whoop-client.js';
import type { StoredWhoopTokens, TokenStore } from '../src/types.js';

const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const HOUR = 60 * 60 * 1000;

type ApiHandler = (url: URL, bearer: string) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const empty = (): Response => json({ records: [] });

/**
 * A fake WHOOP whose token endpoint rotates refresh tokens the way WHOOP does: each one
 * works once, and presenting a spent one is recorded as a replay and refused. Its API
 * accepts the latest access token by default.
 */
class FakeWhoop {
	/** Every form sent to the token endpoint. */
	readonly tokenCalls: URLSearchParams[] = [];
	readonly apiCalls: URL[] = [];
	/** Spent refresh tokens that were presented again. */
	readonly replays: string[] = [];
	/** The HTTP status the token endpoint answers with, when not 200. */
	tokenStatus = 200;
	/** How long the tokens it issues last, in seconds. */
	expiresIn = 3600;
	private readonly spent = new Set<string>();
	private issued = 0;
	private latestAccess = 'access-0';

	constructor(private readonly api: ApiHandler = (_url, bearer) => (bearer === this.latestAccess ? empty() : json({}, 401))) {}

	readonly fetch: typeof fetch = async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : input);
		if (url.href === TOKEN_URL) {
			const form = new URLSearchParams(init?.body as URLSearchParams);
			this.tokenCalls.push(form);
			// Keep the refresh in flight long enough for parallel callers to pile up.
			await new Promise(resolve => setTimeout(resolve, 20));
			if (this.tokenStatus !== 200) return json({ error: 'failed' }, this.tokenStatus);
			const presented = form.get('refresh_token');
			if (presented !== null) {
				if (this.spent.has(presented)) {
					this.replays.push(presented);
					return json({ error: 'invalid_grant' }, 400);
				}
				this.spent.add(presented);
			}
			this.issued++;
			this.latestAccess = `access-${this.issued}`;
			return json({ access_token: this.latestAccess, refresh_token: `refresh-${this.issued}`, expires_in: this.expiresIn });
		}
		this.apiCalls.push(url);
		const bearer = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? '';
		return this.api(url, bearer);
	};
}

/** A store in memory, like one row in a database. Saves can be made to fail. */
class MemoryStore implements TokenStore {
	tokens: StoredWhoopTokens | null;
	readonly saves: StoredWhoopTokens[] = [];
	/** How many of the next saves fail. */
	failSaves = 0;

	constructor(tokens: StoredWhoopTokens | null) {
		this.tokens = tokens;
	}

	async load(): Promise<StoredWhoopTokens | null> {
		return this.tokens && { ...this.tokens };
	}

	async save(tokens: StoredWhoopTokens): Promise<void> {
		if (this.failSaves > 0) {
			this.failSaves--;
			throw new Error('disk full');
		}
		this.tokens = { ...tokens };
		this.saves.push({ ...tokens });
	}
}

function tokens(expiresInMs: number, n = 0): StoredWhoopTokens {
	return { access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_at: Date.now() + expiresInMs };
}

function newClient(whoop: FakeWhoop, store: TokenStore): WhoopClient {
	return new WhoopClient({ clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://localhost:3000/callback', store, fetch: whoop.fetch });
}

describe('WhoopClient token refresh', () => {
	it('shares one refresh between parallel requests', async () => {
		const whoop = new FakeWhoop();
		const store = new MemoryStore(tokens(60_000)); // inside the 5-minute refresh window
		const client = newClient(whoop, store);

		await Promise.all([client.cycles(), client.recoveries(), client.sleeps(), client.workouts()]);

		assert.equal(whoop.tokenCalls.length, 1);
		assert.equal(store.tokens?.refresh_token, 'refresh-1');
	});

	it('refreshes once and retries once after a 401', async () => {
		const whoop = new FakeWhoop((_url, bearer) => (bearer === 'access-1' ? json({ records: [{ id: 1 }] }) : json({}, 401)));
		const client = newClient(whoop, new MemoryStore(tokens(HOUR)));

		const cycles = await client.cycles();

		assert.equal(cycles.length, 1);
		assert.equal(whoop.tokenCalls.length, 1);
		assert.equal(whoop.apiCalls.length, 2);
	});

	it('gives up with WhoopAuthError when the retry is rejected too', async () => {
		const whoop = new FakeWhoop(() => json({}, 401));
		const client = newClient(whoop, new MemoryStore(tokens(HOUR)));

		await assert.rejects(client.cycles(), WhoopAuthError);
		assert.equal(whoop.tokenCalls.length, 1);
		assert.equal(whoop.apiCalls.length, 2);
	});

	it('asks the user to reconnect when WHOOP refuses the refresh token', async () => {
		const whoop = new FakeWhoop(() => json({}, 401));
		whoop.tokenStatus = 400;
		const client = newClient(whoop, new MemoryStore(tokens(HOUR)));

		await assert.rejects(client.cycles(), /authorization expired\. Use the get_auth_url tool/);
	});

	it('refreshes once when two clients sharing one store both get a 401', async () => {
		// Both clients start with access-0, which WHOOP no longer accepts.
		const whoop = new FakeWhoop((_url, bearer) => (bearer === 'access-0' ? json({}, 401) : empty()));
		const store = new MemoryStore(tokens(HOUR));
		const first = newClient(whoop, store);
		const second = newClient(whoop, store);

		await Promise.all([first.cycles(), second.cycles()]);

		assert.equal(whoop.tokenCalls.length, 1, "the second client adopts the first one's tokens");
		assert.deepEqual(whoop.replays, []);
		assert.equal(store.tokens?.refresh_token, 'refresh-1');
	});

	it('refreshes once across processes that share the tokens through withLock', async () => {
		const whoop = new FakeWhoop();
		// Two processes: separate store objects over the same row, with a lock between them.
		const row: { tokens: StoredWhoopTokens | null } = { tokens: tokens(60_000) };
		let queue: Promise<unknown> = Promise.resolve();
		const processStore = (): TokenStore => ({
			load: async () => row.tokens && { ...row.tokens },
			save: async saved => {
				row.tokens = { ...saved };
			},
			withLock: task => {
				const run = queue.then(task);
				queue = run.catch(() => {});
				return run;
			},
		});
		const first = newClient(whoop, processStore());
		const second = newClient(whoop, processStore());

		await Promise.all([first.cycles(), second.cycles()]);

		assert.equal(whoop.tokenCalls.length, 1);
		assert.deepEqual(whoop.replays, []);
		assert.equal(row.tokens?.refresh_token, 'refresh-1');
	});

	it('adopts tokens saved by a reconnect instead of refreshing or overwriting them', async () => {
		let accepted = 'access-0';
		const whoop = new FakeWhoop((_url, bearer) => (bearer === accepted ? empty() : json({}, 401)));
		const store = new MemoryStore(tokens(HOUR));
		const client = newClient(whoop, store);
		await client.cycles();

		// The user reconnects from another process, and WHOOP stops accepting access-0.
		store.tokens = tokens(HOUR, 9);
		accepted = 'access-9';
		await client.cycles();

		assert.equal(whoop.tokenCalls.length, 0);
		assert.equal(store.tokens.refresh_token, 'refresh-9', 'the reconnect is kept');
	});

	it('refreshes an adopted token that is about to expire, with its own refresh token', async () => {
		let accepted = 'access-0';
		const whoop = new FakeWhoop((_url, bearer) => (bearer === accepted ? empty() : json({}, 401)));
		const store = new MemoryStore(tokens(HOUR));
		const client = newClient(whoop, store);
		await client.cycles();

		// Another process refreshed: the store holds access-7, nearly expired, and WHOOP no longer accepts access-0.
		store.tokens = { access_token: 'access-7', refresh_token: 'refresh-7', expires_at: Date.now() + 60_000 };
		accepted = 'access-1';
		await client.cycles();

		assert.equal(whoop.tokenCalls.length, 1);
		assert.equal(whoop.tokenCalls[0].get('refresh_token'), 'refresh-7');
	});

	it('marks the stored tokens before presenting the refresh token, and clears the mark with the result', async () => {
		const whoop = new FakeWhoop();
		const store = new MemoryStore(tokens(60_000));
		await newClient(whoop, store).cycles();

		assert.equal(store.saves.length, 2);
		assert.equal(store.saves[0].refresh_token, 'refresh-0');
		assert.equal(typeof store.saves[0].refresh_started_at, 'number');
		assert.equal(store.saves[1].refresh_token, 'refresh-1');
		assert.equal(store.saves[1].refresh_started_at, undefined);
	});

	it("doesn't call WHOOP when the mark can't be saved", async () => {
		const whoop = new FakeWhoop();
		const store = new MemoryStore(tokens(-1)); // expired
		store.failSaves = 2;

		await assert.rejects(newClient(whoop, store).cycles(), /disk full/);
		assert.equal(whoop.tokenCalls.length, 0);
	});

	it('never presents a refresh token whose refresh was interrupted', async () => {
		const whoop = new FakeWhoop();
		const store = new MemoryStore({ ...tokens(-1), refresh_started_at: Date.now() - 60_000 });

		await assert.rejects(newClient(whoop, store).cycles(), /refresh didn't finish.*get_auth_url/);
		assert.equal(whoop.tokenCalls.length, 0);
	});

	it('keeps the mark when WHOOP fails mid-refresh, and asks to reconnect', async () => {
		const whoop = new FakeWhoop();
		whoop.tokenStatus = 502;
		const store = new MemoryStore(tokens(-1));
		const client = newClient(whoop, store);

		await assert.rejects(client.cycles(), /refresh didn't finish.*get_auth_url/);
		await assert.rejects(client.cycles(), /refresh didn't finish/);
		assert.equal(whoop.tokenCalls.length, 1, 'the possibly spent refresh token is presented only once');
		assert.equal(typeof store.tokens?.refresh_started_at, 'number');
	});

	it("clears the mark when WHOOP's rate limit turns the refresh away", async () => {
		const whoop = new FakeWhoop();
		whoop.tokenStatus = 429;
		const store = new MemoryStore(tokens(-1));
		const client = newClient(whoop, store);

		await assert.rejects(client.cycles(), WhoopRateLimitError);
		assert.equal(store.tokens?.refresh_started_at, undefined);

		whoop.tokenStatus = 200;
		await client.cycles();
		assert.equal(store.tokens?.refresh_token, 'refresh-1');
	});

	it('keeps using a token that has not expired yet when WHOOP fails to refresh it', async () => {
		const whoop = new FakeWhoop();
		whoop.tokenStatus = 503;
		const client = newClient(whoop, new MemoryStore(tokens(60_000)));

		await client.cycles();
		assert.equal(whoop.tokenCalls.length, 1);
		assert.equal(whoop.apiCalls.length, 1);
	});

	it('saves tokens whose save failed before anything else, and never replays the spent one', async () => {
		const whoop = new FakeWhoop();
		const store = new MemoryStore(tokens(60_000));
		const client = newClient(whoop, store);
		// The mark saves; then both attempts to save WHOOP's new tokens fail.
		const save = store.save.bind(store);
		let saves = 0;
		store.save = async saved => {
			if (++saves >= 2 && saves <= 3) throw new Error('disk full');
			return save(saved);
		};

		await assert.rejects(client.cycles(), /disk full/);
		assert.equal(store.tokens?.refresh_token, 'refresh-0');

		// Another process sharing the store must not present refresh-0: WHOOP has spent it.
		const other = newClient(whoop, store);
		await assert.rejects(other.cycles(), /refresh didn't finish/);

		// The client holding the new tokens saves them, which clears the mark, and carries on.
		await client.cycles();
		assert.equal(store.tokens?.refresh_token, 'refresh-1');
		assert.equal(store.tokens?.refresh_started_at, undefined);
		assert.equal(whoop.tokenCalls.length, 1);
		assert.deepEqual(whoop.replays, []);
	});

	it('refreshes tokens whose save failed, once they are saved, when they are about to expire', async () => {
		const whoop = new FakeWhoop();
		whoop.expiresIn = 60; // WHOOP's new tokens are already inside the refresh window
		const store = new MemoryStore(tokens(60_000));
		const client = newClient(whoop, store);
		const save = store.save.bind(store);
		let saves = 0;
		store.save = async saved => {
			if (++saves >= 2 && saves <= 3) throw new Error('disk full');
			return save(saved);
		};
		await assert.rejects(client.cycles(), /disk full/);

		await client.cycles();
		assert.deepEqual(whoop.tokenCalls.map(form => form.get('refresh_token')), ['refresh-0', 'refresh-1']);
		assert.equal(store.tokens?.refresh_token, 'refresh-2');
	});

	it("doesn't bring back a mark another process has cleared", async () => {
		let accepted = 'access-0';
		const whoop = new FakeWhoop((_url, bearer) => (bearer === accepted ? empty() : json({}, 401)));
		const store = new MemoryStore(tokens(HOUR));
		const client = newClient(whoop, store);
		await client.cycles();

		// Another process is mid-refresh: it has marked the tokens it's about to replace.
		store.tokens = { ...tokens(HOUR, 5), refresh_started_at: Date.now() };
		accepted = 'access-5';
		await client.cycles(); // adopts access-5

		// That refresh was turned away, so it cleared the mark; then WHOOP stops accepting access-5.
		store.tokens = tokens(HOUR, 5);
		accepted = 'none';
		whoop.tokenStatus = 429;
		await assert.rejects(client.cycles(), WhoopRateLimitError);
		assert.equal(store.tokens.refresh_started_at, undefined);
	});

	it('retries a failed save once', async () => {
		const whoop = new FakeWhoop();
		const store = new MemoryStore(tokens(60_000));
		store.failSaves = 1;

		await newClient(whoop, store).cycles();
		assert.equal(store.tokens?.refresh_token, 'refresh-1');
	});

	it('saves the tokens from a new authorization, clearing any mark, and switches to them at once', async () => {
		const bearers: string[] = [];
		const whoop = new FakeWhoop((_url, bearer) => {
			bearers.push(bearer);
			return empty();
		});
		const store = new MemoryStore({ ...tokens(HOUR), refresh_started_at: Date.now() });
		const client = newClient(whoop, store);
		await client.cycles();

		await client.exchangeCodeForTokens('code-from-whoop');
		assert.equal(whoop.tokenCalls[0].get('code'), 'code-from-whoop');
		assert.deepEqual(store.tokens && { ...store.tokens, expires_at: 0 }, { access_token: 'access-1', refresh_token: 'refresh-1', expires_at: 0 });

		// The new authorization may be another WHOOP account, so the old tokens aren't used again.
		await client.cycles();
		assert.deepEqual(bearers, ['access-0', 'access-1']);
		assert.equal(whoop.tokenCalls.length, 1);
	});

	it("says WHOOP isn't connected without calling it, then picks up tokens saved later", async () => {
		const whoop = new FakeWhoop();
		const store = new MemoryStore(null);
		const client = newClient(whoop, store);

		await assert.rejects(client.cycles(), /Not authenticated/);
		assert.equal(whoop.apiCalls.length, 0);

		store.tokens = tokens(HOUR);
		await client.cycles();
		assert.equal(whoop.apiCalls.length, 1);
	});
});

describe('WhoopClient errors', () => {
	const failing = (status: number) => newClient(new FakeWhoop(() => json({ error: 'nope' }, status)), new MemoryStore(tokens(HOUR)));

	it("tell WHOOP's rate limit, an outage and a refused request apart", async () => {
		await assert.rejects(failing(429).cycles(), WhoopRateLimitError);
		await assert.rejects(failing(503).cycles(), (error: unknown) => error instanceof WhoopUnavailableError && error.status === 503);
		await assert.rejects(failing(404).cycles(), (error: unknown) => error instanceof WhoopRequestError && error.status === 404);
	});

	it('report a request that timed out as WHOOP being unavailable', async () => {
		const client = new WhoopClient({
			clientId: 'client-id',
			clientSecret: 'client-secret',
			redirectUri: 'http://localhost:3000/callback',
			store: new MemoryStore(tokens(HOUR)),
			fetch: async () => {
				throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
			},
		});
		await assert.rejects(client.cycles(), (error: unknown) => error instanceof WhoopUnavailableError && /within 15 seconds/.test(error.message));
	});
});

describe('WhoopClient in-flight sharing', () => {
	function slowWhoop(): FakeWhoop {
		return new FakeWhoop(async () => {
			await new Promise(resolve => setTimeout(resolve, 20));
			return json({ records: [{ id: 1 }] });
		});
	}

	it('shares identical requests while they run, then forgets them', async () => {
		const whoop = slowWhoop();
		const client = newClient(whoop, new MemoryStore(tokens(HOUR)));
		const query = { start: '2026-09-01T00:00:00.000Z' };

		const [first, second] = await Promise.all([client.cycles(query), client.cycles(query)]);
		assert.equal(whoop.apiCalls.length, 1);
		assert.deepEqual(first, second);
		assert.notEqual(first, second, 'each caller gets its own array');

		await client.cycles(query);
		assert.equal(whoop.apiCalls.length, 2, 'nothing is kept once the request is done');
	});

	it("doesn't share requests for different data", async () => {
		const whoop = slowWhoop();
		const client = newClient(whoop, new MemoryStore(tokens(HOUR)));

		await Promise.all([
			client.cycles({ start: '2026-09-01T00:00:00.000Z' }),
			client.cycles({ start: '2026-09-02T00:00:00.000Z' }),
			client.cycles({ start: '2026-09-01T00:00:00.000Z', limit: 1 }),
			client.sleeps({ start: '2026-09-01T00:00:00.000Z' }),
		]);
		assert.equal(whoop.apiCalls.length, 4);
	});

	it('gives a shared failure to every caller, and tries again next time', async () => {
		let calls = 0;
		const whoop = new FakeWhoop(async () => {
			calls++;
			await new Promise(resolve => setTimeout(resolve, 20));
			return calls === 1 ? json({}, 503) : empty();
		});
		const client = newClient(whoop, new MemoryStore(tokens(HOUR)));

		const results = await Promise.allSettled([client.cycles(), client.cycles()]);
		assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected']);
		await client.cycles();
		assert.equal(calls, 2);
	});
});

describe('WhoopClient pagination', () => {
	it('follows next_token until the last page', async () => {
		const whoop = new FakeWhoop(url => {
			const page = Number(url.searchParams.get('nextToken') ?? 0);
			return json({ records: [{ id: page }], ...(page < 2 ? { next_token: String(page + 1) } : {}) });
		});
		const client = newClient(whoop, new MemoryStore(tokens(HOUR)));

		const sleeps = await client.sleeps({ start: '2026-01-01T00:00:00.000Z' });

		assert.equal(sleeps.length, 3);
		assert.equal(whoop.apiCalls.length, 3);
		assert.equal(whoop.apiCalls[0].searchParams.get('start'), '2026-01-01T00:00:00.000Z');
	});

	it('asks for no more than the limit, and stops once it has them', async () => {
		const whoop = new FakeWhoop(url => {
			const size = Number(url.searchParams.get('limit'));
			return json({ records: Array.from({ length: size }, (_, id) => ({ id })), next_token: `after-${url.searchParams.get('nextToken') ?? 0}` });
		});
		const client = newClient(whoop, new MemoryStore(tokens(HOUR)));

		assert.equal((await client.cycles({ limit: 1 })).length, 1);
		assert.deepEqual(whoop.apiCalls.map(url => url.searchParams.get('limit')), ['1']);

		assert.equal((await client.cycles({ limit: 30 })).length, 30);
		assert.deepEqual(whoop.apiCalls.slice(1).map(url => url.searchParams.get('limit')), ['25', '5']);
	});

	it('stops when WHOOP returns the same cursor twice', async () => {
		const whoop = new FakeWhoop(() => json({ records: [], next_token: 'stuck' }));
		const client = newClient(whoop, new MemoryStore(tokens(HOUR)));

		await assert.rejects(client.workouts(), /same page cursor/);
		assert.equal(whoop.apiCalls.length, 2);
	});

	it('stops after 100 pages', async () => {
		let page = 0;
		const whoop = new FakeWhoop(() => json({ records: [], next_token: `page-${++page}` }));
		const client = newClient(whoop, new MemoryStore(tokens(HOUR)));

		await assert.rejects(client.cycles(), /after 100 pages/);
		assert.equal(whoop.apiCalls.length, 100);
	});
});

describe('WhoopClient authorization URL', () => {
	it('carries the state it was given', () => {
		const client = newClient(new FakeWhoop(), new MemoryStore(null));
		const url = new URL(client.getAuthorizationUrl(['read:sleep'], 'issued-state'));
		assert.equal(url.searchParams.get('state'), 'issued-state');
		assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:3000/callback');
	});
});
