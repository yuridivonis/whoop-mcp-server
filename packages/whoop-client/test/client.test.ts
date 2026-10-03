import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	WhoopAuthError,
	WhoopClient,
	WhoopError,
	WhoopProtocolError,
	WhoopRateLimitError,
	WhoopRequestError,
	WhoopUnavailableError,
	type StoredWhoopTokens,
	type TokenStore,
	type WhoopAuthReason,
} from '../src/index.js';

const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const HOUR = 60 * 60 * 1000;

type ApiHandler = (url: URL, bearer: string, method: string) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const empty = (): Response => json({ records: [] });
/** WHOOP's answer to a revoke: 204, which must have no body. */
const noContent = (): Response => new Response(null, { status: 204 });
/** A successful answer to any API request: an empty page, or 204 for a revoke. */
const ok = (method: string): Response => (method === 'DELETE' ? noContent() : empty());

/** Rejects with a WhoopAuthError for this reason. */
const authError = (reason: WhoopAuthReason) => (error: unknown) => error instanceof WhoopAuthError && error.reason === reason;

/**
 * A fake WHOOP whose token endpoint rotates refresh tokens the way WHOOP does: each one
 * works once, and presenting a spent one is recorded as a replay and refused. Its API
 * accepts the latest access token by default.
 */
class FakeWhoop {
	/** Every form sent to the token endpoint. */
	readonly tokenCalls: URLSearchParams[] = [];
	readonly apiCalls: URL[] = [];
	/** The HTTP method of each API call. */
	readonly apiMethods: string[] = [];
	/** Spent refresh tokens that were presented again. */
	readonly replays: string[] = [];
	/** The HTTP status the token endpoint answers with, when not 200. */
	tokenStatus = 200;
	/** The OAuth error code it answers a 400 or 401 with. */
	tokenError = 'invalid_grant';
	/** When set, calls to the token endpoint fail with this instead of answering. */
	tokenThrows?: Error;
	/** How long the tokens it issues last, in seconds. */
	expiresIn = 3600;
	/** When set, replaces the token endpoint's body (200 or an error status), to test malformed answers. */
	tokenBody?: string;
	private readonly spent = new Set<string>();
	private issued = 0;
	private latestAccess = 'access-0';

	constructor(private readonly api: ApiHandler = (_url, bearer, method) => (bearer === this.latestAccess ? ok(method) : json({}, 401))) {}

	readonly fetch: typeof fetch = async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : input);
		if (url.href === TOKEN_URL) {
			const form = new URLSearchParams(init?.body as URLSearchParams);
			this.tokenCalls.push(form);
			// Keep the refresh in flight long enough for parallel callers to pile up.
			await new Promise(resolve => setTimeout(resolve, 20));
			if (this.tokenThrows) throw this.tokenThrows;
			if (this.tokenBody !== undefined && this.tokenStatus !== 200) return new Response(this.tokenBody, { status: this.tokenStatus });
			if (this.tokenStatus !== 200) return json({ error: this.tokenStatus < 500 ? this.tokenError : 'server_error' }, this.tokenStatus);
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
			if (this.tokenBody !== undefined) return new Response(this.tokenBody, { headers: { 'Content-Type': 'application/json' } });
			return json({ access_token: this.latestAccess, refresh_token: `refresh-${this.issued}`, expires_in: this.expiresIn });
		}
		this.apiCalls.push(url);
		this.apiMethods.push(init?.method ?? 'GET');
		const bearer = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? '';
		return this.api(url, bearer, init?.method ?? 'GET');
	};
}

/** A store in memory, like one row in a database. Saves and clears can be made to fail. */
class MemoryStore implements TokenStore {
	tokens: StoredWhoopTokens | null;
	readonly saves: StoredWhoopTokens[] = [];
	/** How many of the next saves fail. */
	failSaves = 0;
	/** How many times clear() ran, and how many of the next ones fail. */
	clears = 0;
	failClears = 0;
	/** Whether a lock is held right now, and whether clear() ran under one. */
	private locked = false;
	clearedUnderLock?: boolean;

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

	async clear(): Promise<void> {
		if (this.failClears > 0) {
			this.failClears--;
			throw new Error('disk full');
		}
		this.clears++;
		this.clearedUnderLock = this.locked;
		this.tokens = null;
	}

	async withLock<T>(task: () => Promise<T>): Promise<T> {
		this.locked = true;
		try {
			return await task();
		} finally {
			this.locked = false;
		}
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

		await assert.rejects(client.cycles(), authError('authorization_ended'));
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

		await assert.rejects(newClient(whoop, store).cycles(), authError('refresh_interrupted'));
		assert.equal(whoop.tokenCalls.length, 0);
	});

	it('keeps the mark when WHOOP fails mid-refresh, and asks to reconnect', async () => {
		const whoop = new FakeWhoop();
		whoop.tokenStatus = 502;
		const store = new MemoryStore(tokens(-1));
		const client = newClient(whoop, store);

		await assert.rejects(client.cycles(), authError('refresh_interrupted'));
		await assert.rejects(client.cycles(), authError('refresh_interrupted'));
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

	it('clears the mark when WHOOP refuses the app credentials, and says which OAuth error it gave', async () => {
		const whoop = new FakeWhoop();
		whoop.tokenStatus = 401;
		whoop.tokenError = 'invalid_client';
		const store = new MemoryStore(tokens(-1));
		const client = newClient(whoop, store);

		await assert.rejects(client.cycles(), (error: unknown) => error instanceof WhoopRequestError && error.oauthError === 'invalid_client' && !/WHOOP_CLIENT/.test(error.message));
		assert.equal(store.tokens?.refresh_started_at, undefined);

		// The operator fixes the secret: no reconnect needed.
		whoop.tokenStatus = 200;
		await client.cycles();
		assert.equal(store.tokens?.refresh_token, 'refresh-1');
	});

	it("clears the mark when the refresh never left the server, such as when WHOOP's address can't be looked up", async () => {
		const whoop = new FakeWhoop();
		whoop.tokenThrows = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.prod.whoop.com'), { code: 'ENOTFOUND' }) });
		const store = new MemoryStore(tokens(-1));
		const client = newClient(whoop, store);

		await assert.rejects(client.cycles(), (error: unknown) => error instanceof WhoopUnavailableError && /ENOTFOUND/.test(error.message));
		assert.equal(store.tokens?.refresh_started_at, undefined);

		whoop.tokenThrows = undefined;
		await client.cycles();
		assert.equal(store.tokens?.refresh_token, 'refresh-1');
	});

	it('keeps the mark when the connection failed after the refresh may have been sent', async () => {
		const whoop = new FakeWhoop();
		whoop.tokenThrows = new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
		const store = new MemoryStore(tokens(-1));

		await assert.rejects(newClient(whoop, store).cycles(), authError('refresh_interrupted'));
		assert.equal(typeof store.tokens?.refresh_started_at, 'number');
	});

	it("still clears the mark after a turned-away refresh when the first attempt to save that fails", async () => {
		const whoop = new FakeWhoop();
		whoop.tokenStatus = 429;
		const store = new MemoryStore(tokens(-1));
		const client = newClient(whoop, store);
		const save = store.save.bind(store);
		let saves = 0;
		store.save = async saved => {
			if (++saves >= 2 && saves <= 3) throw new Error('disk full'); // both attempts to clear the mark
			return save(saved);
		};

		await assert.rejects(client.cycles(), /disk full/);
		assert.equal(typeof store.tokens?.refresh_started_at, 'number');

		whoop.tokenStatus = 200;
		await client.cycles();
		assert.equal(store.tokens?.refresh_token, 'refresh-1', 'the unspent token was presented, not a reconnect demanded');
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
		await assert.rejects(other.cycles(), authError('refresh_interrupted'));

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

		await client.connect('code-from-whoop');
		assert.equal(whoop.tokenCalls[0].get('code'), 'code-from-whoop');
		assert.deepEqual(store.tokens && { ...store.tokens, expires_at: 0 }, { access_token: 'access-1', refresh_token: 'refresh-1', expires_at: 0 });

		// The new authorization may be another WHOOP account, so the old tokens aren't used again.
		await client.cycles();
		assert.deepEqual(bearers, ['access-0', 'access-1']);
		assert.equal(whoop.tokenCalls.length, 1);
	});

	it("keeps the tokens it has when a new authorization can't be saved", async () => {
		const whoop = new FakeWhoop((_url, bearer) => (bearer === 'access-0' ? empty() : json({}, 401)));
		const store = new MemoryStore(tokens(HOUR));
		const client = newClient(whoop, store);
		await client.cycles();
		store.failSaves = 2;

		await assert.rejects(client.connect('code-from-whoop'), /disk full/);
		await client.cycles();
		assert.equal(whoop.tokenCalls.length, 1, 'only the code exchange');
		assert.equal(store.tokens?.refresh_token, 'refresh-0');
	});

	it('never lets a slow first load overwrite a refresh that happened meanwhile on the same client', async () => {
		// Nothing held yet, and the stored token has expired. cycles() loads, refreshes and saves;
		// sleeps() started at the same time, but its load answers only after WHOOP has rotated the
		// token, while the new tokens are still being saved. That stale load must not bring back
		// refresh-0, which WHOOP has already spent.
		const whoop = new FakeWhoop();
		const store = new MemoryStore(tokens(-1));
		const load = store.load.bind(store);
		const save = store.save.bind(store);
		// Staged: sleeps()'s first load answers only once the refreshed tokens start saving, and
		// that save finishes only after it has answered. With the fix, that load waits for the
		// lock instead, runs before the refresh, and would wait forever; a fallback timer far
		// longer than the fake's 20 ms token delay lets it go on, and the save then doesn't wait.
		let refreshedSaveStarted!: () => void;
		const refreshedSaving = new Promise<void>(resolve => { refreshedSaveStarted = resolve; });
		let staleLoadAnswered!: () => void;
		const staleLoadDone = new Promise<void>(resolve => { staleLoadAnswered = resolve; });
		let loads = 0;
		store.load = async () => {
			const loaded = await load();
			if (++loads === 2) {
				await Promise.race([refreshedSaving, new Promise(resolve => setTimeout(resolve, 250))]);
				queueMicrotask(staleLoadAnswered);
			}
			return loaded;
		};
		store.save = async saved => {
			if (saved.refresh_token === 'refresh-1') {
				refreshedSaveStarted();
				if (loads >= 2) await staleLoadDone;
			}
			return save(saved);
		};
		const client = newClient(whoop, store);

		await Promise.all([client.cycles(), client.sleeps()]);

		assert.deepEqual(whoop.replays, [], 'no spent refresh token is presented again');
		assert.equal(whoop.tokenCalls.length, 1);
		assert.equal(store.tokens?.refresh_token, 'refresh-1');
	});

	it("says WHOOP isn't connected without calling it, then picks up tokens saved later", async () => {
		const whoop = new FakeWhoop();
		const store = new MemoryStore(null);
		const client = newClient(whoop, store);

		await assert.rejects(client.cycles(), authError('not_connected'));
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
		// Retries off: with them on, the 503 would be retried and succeed, which is its own test.
		const client = new WhoopClient({ clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://localhost:3000/callback', store: new MemoryStore(tokens(HOUR)), fetch: whoop.fetch, retry: false });

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

		await assert.rejects(client.workouts(), (error: unknown) => error instanceof WhoopProtocolError && /same page cursor/.test(error.message));
		assert.equal(whoop.apiCalls.length, 2);
	});

	it('stops after 100 pages', async () => {
		let page = 0;
		const whoop = new FakeWhoop(() => json({ records: [], next_token: `page-${++page}` }));
		const client = newClient(whoop, new MemoryStore(tokens(HOUR)));

		await assert.rejects(client.cycles(), (error: unknown) => error instanceof WhoopProtocolError && /after 100 pages/.test(error.message));
		assert.equal(whoop.apiCalls.length, 100);
	});
});

describe('WhoopClient authorization URL', () => {
	it('carries the state it was given', () => {
		const client = newClient(new FakeWhoop(), new MemoryStore(null));
		const url = new URL(client.authorizationUrl({ scopes: ['read:sleep', 'offline'], state: 'issued-state' }));
		assert.equal(url.searchParams.get('state'), 'issued-state');
		assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:3000/callback');
	});
});

describe('WhoopClient revokeAccess', () => {
	/** Revoked, cleared exactly once under the lock, and a later call says not connected. */
	async function assertRevoked(client: WhoopClient, store: MemoryStore): Promise<void> {
		assert.equal(store.clears, 1);
		assert.equal(store.clearedUnderLock, true);
		assert.equal(store.tokens, null);
		await assert.rejects(client.cycles(), authError('not_connected'));
	}

	it('revokes on first use, clears the store and forgets the tokens', async () => {
		const whoop = new FakeWhoop();
		const store = new MemoryStore(tokens(HOUR));
		const client = newClient(whoop, store);

		await client.revokeAccess();
		assert.deepEqual(whoop.apiMethods, ['DELETE']);
		assert.equal(whoop.apiCalls[0].pathname, '/developer/v2/user/access');
		await assertRevoked(client, store);
	});

	it('clears the grant it refreshed on the way, after a 401', async () => {
		// access-0 is refused; the refresh issues access-1, which the DELETE carries.
		const whoop = new FakeWhoop((_url, bearer, method) => (bearer === 'access-1' ? ok(method) : json({}, 401)));
		const store = new MemoryStore(tokens(HOUR));
		const client = newClient(whoop, store);

		await client.revokeAccess();
		assert.equal(whoop.tokenCalls.length, 1);
		await assertRevoked(client, store);
	});

	it('clears the grant it refreshed first, when the token was about to expire', async () => {
		const whoop = new FakeWhoop();
		const store = new MemoryStore(tokens(60_000));
		const client = newClient(whoop, store);

		await client.revokeAccess();
		assert.equal(whoop.tokenCalls.length, 1);
		await assertRevoked(client, store);
	});

	it('counts an authorization WHOOP already ended as revoked, when the refresh is refused', async () => {
		const whoop = new FakeWhoop();
		whoop.tokenStatus = 400; // invalid_grant
		const store = new MemoryStore(tokens(-1)); // expired, so it must refresh before sending
		const client = newClient(whoop, store);

		await client.revokeAccess();
		assert.equal(whoop.apiCalls.length, 0);
		await assertRevoked(client, store);
	});

	it('counts an authorization WHOOP already ended as revoked, when the retry gets a 401 too', async () => {
		const whoop = new FakeWhoop(() => json({}, 401));
		const store = new MemoryStore(tokens(HOUR));
		const client = newClient(whoop, store);

		await client.revokeAccess();
		assert.equal(whoop.apiCalls.length, 2);
		await assertRevoked(client, store);
	});

	it("clears nothing when WHOOP's refusal can't be read, since the grant may still be live", async () => {
		// A 401 with an HTML body (a proxy, say) is classed as the authorization ending for reads,
		// but a revoke mustn't forget tokens on that evidence alone: no DELETE was ever sent.
		const whoop = new FakeWhoop();
		whoop.tokenStatus = 401;
		whoop.tokenBody = '<html>maintenance</html>';
		const store = new MemoryStore(tokens(-1));
		const client = newClient(whoop, store);

		await assert.rejects(client.revokeAccess(), (error: unknown) => authError('authorization_ended')(error) && (error as WhoopAuthError).oauthError === undefined);
		assert.equal(whoop.apiCalls.length, 0);
		assert.equal(store.clears, 0);
		assert.equal(store.tokens?.refresh_token, 'refresh-0');
	});

	it("asks to reconnect, and clears nothing, when the grant is gone but the token hadn't expired", async () => {
		// The proactive refresh is refused, which leaves the mark; the DELETE then gets a 401.
		const whoop = new FakeWhoop(() => json({}, 401));
		whoop.tokenStatus = 400;
		const store = new MemoryStore(tokens(60_000));
		const client = newClient(whoop, store);

		await assert.rejects(client.revokeAccess(), authError('refresh_interrupted'));
		assert.equal(store.clears, 0);
	});

	it('clears nothing, and keeps the tokens, when WHOOP is rate limited or unavailable', async () => {
		for (const status of [429, 503]) {
			const whoop = new FakeWhoop((_url, _bearer, method) => (method === 'DELETE' ? json({}, status) : empty()));
			const store = new MemoryStore(tokens(HOUR));
			const client = newClient(whoop, store);

			await assert.rejects(client.revokeAccess(), status === 429 ? WhoopRateLimitError : WhoopUnavailableError);
			assert.equal(store.clears, 0);
			assert.equal(store.tokens?.refresh_token, 'refresh-0');
			await client.cycles(); // still connected
		}
	});

	it("says it isn't connected when there's nothing to revoke", async () => {
		const whoop = new FakeWhoop();
		const store = new MemoryStore(null);

		await assert.rejects(newClient(whoop, store).revokeAccess(), authError('not_connected'));
		assert.equal(whoop.apiCalls.length, 0);
		assert.equal(store.clears, 0);
	});

	it("forgets the tokens even when the store can't clear them, and says so", async () => {
		const whoop = new FakeWhoop();
		const store = new MemoryStore(tokens(HOUR));
		store.failClears = 2;
		const client = newClient(whoop, store);

		await assert.rejects(client.revokeAccess(), /disk full/);
		assert.equal(store.tokens?.refresh_token, 'refresh-0', 'the store kept them');
		// The client dropped its copy: with the store emptied, it has nothing left to send.
		store.tokens = null;
		await assert.rejects(client.cycles(), authError('not_connected'));
		assert.deepEqual(whoop.apiMethods, ['DELETE']);
	});

	it('retries a failed clear once', async () => {
		const whoop = new FakeWhoop();
		const store = new MemoryStore(tokens(HOUR));
		store.failClears = 1;
		const client = newClient(whoop, store);

		await client.revokeAccess();
		await assertRevoked(client, store);
	});

	it('works with a store that has no clear(): the client forgets, the store keeps a revoked copy', async () => {
		const whoop = new FakeWhoop();
		const row: { tokens: StoredWhoopTokens | null } = { tokens: tokens(HOUR) };
		const store: TokenStore = { load: async () => row.tokens && { ...row.tokens }, save: async saved => { row.tokens = { ...saved }; } };
		const client = newClient(whoop, store);

		await client.revokeAccess();
		assert.equal(row.tokens?.refresh_token, 'refresh-0');
	});

	it('drops the body of a revoke answered 200 with one, as for 204', async () => {
		const whoop = new FakeWhoop((_url, _bearer, method) => (method === 'DELETE' ? json({ revoked: true }) : empty()));
		const store = new MemoryStore(tokens(HOUR));
		const client = newClient(whoop, store);

		await client.revokeAccess();
		await assertRevoked(client, store);
	});

	it('keeps a reconnect made on another client while the revoke was in flight', async () => {
		let release!: () => void;
		const held = new Promise<void>(resolve => { release = resolve; });
		const whoop = new FakeWhoop(async (_url, _bearer, method) => {
			if (method === 'DELETE') await held;
			return ok(method);
		});
		const store = new MemoryStore(tokens(HOUR));
		const revoking = newClient(whoop, store);
		const other = newClient(whoop, store);

		const revoke = revoking.revokeAccess();
		await new Promise(resolve => setTimeout(resolve, 10)); // the DELETE is in flight
		await other.connect('code-from-whoop');
		release();
		await revoke;

		assert.equal(store.clears, 0, 'the new authorization is kept');
		assert.equal(store.tokens?.refresh_token, 'refresh-1');
		await revoking.cycles();
		assert.equal(whoop.apiCalls.at(-1)?.pathname, '/developer/v2/cycle');
	});

	it('keeps a reconnect made on the same client while the revoke was in flight', async () => {
		let release!: () => void;
		const held = new Promise<void>(resolve => { release = resolve; });
		// WHOOP still accepts the old token for the DELETE, which is in flight while the user reconnects.
		const whoop = new FakeWhoop(async (_url, _bearer, method) => {
			if (method === 'DELETE') await held;
			return ok(method);
		});
		const store = new MemoryStore(tokens(HOUR));
		const client = newClient(whoop, store);

		const revoke = client.revokeAccess();
		await new Promise(resolve => setTimeout(resolve, 10));
		await client.connect('code-from-whoop');
		release();
		await revoke;

		assert.equal(store.clears, 0, 'the reconnect is not the grant that was revoked');
		assert.equal(store.tokens?.refresh_token, 'refresh-1');
		await client.cycles();
		assert.deepEqual(whoop.apiMethods, ['DELETE', 'GET'], 'still connected, with the new authorization');
	});
});

describe('WhoopClient token responses', () => {
	const malformed: [string, string][] = [
		['no access token', JSON.stringify({ refresh_token: 'r', expires_in: 3600 })],
		['an empty refresh token', JSON.stringify({ access_token: 'a', refresh_token: '', expires_in: 3600 })],
		['expires_in as text', JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: '3600' })],
		['a zero expires_in', JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 0 })],
		['a body that is not JSON', 'access_token=a&refresh_token=r'],
	];

	for (const [what, body] of malformed) {
		it(`refuses ${what} on connect, and saves nothing`, async () => {
			const whoop = new FakeWhoop();
			whoop.tokenBody = body;
			const store = new MemoryStore(null);

			await assert.rejects(newClient(whoop, store).connect('code'), WhoopProtocolError);
			assert.equal(store.saves.length, 0);
		});

		it(`keeps the mark and asks to reconnect for ${what} on a refresh`, async () => {
			const whoop = new FakeWhoop();
			whoop.tokenBody = body;
			const store = new MemoryStore(tokens(-1));

			await assert.rejects(
				newClient(whoop, store).cycles(),
				(error: unknown) => error instanceof WhoopAuthError && error.reason === 'refresh_interrupted' && error.cause instanceof WhoopProtocolError,
			);
			assert.equal(typeof store.tokens?.refresh_started_at, 'number');
			assert.equal(store.tokens?.refresh_token, 'refresh-0');
		});
	}

	it("names the 'offline' scope when WHOOP returns no refresh token", async () => {
		const whoop = new FakeWhoop();
		whoop.tokenBody = JSON.stringify({ access_token: 'a', expires_in: 3600 });

		await assert.rejects(newClient(whoop, new MemoryStore(null)).connect('code'), /'offline' scope/);
	});
});

describe('WhoopClient argument checks', () => {
	const noRedirect = (whoop: FakeWhoop) =>
		new WhoopClient({ clientId: 'client-id', clientSecret: 'client-secret', store: new MemoryStore(null), fetch: whoop.fetch });

	it('needs redirectUri to build a sign-in link or connect, and says so before calling WHOOP', async () => {
		const whoop = new FakeWhoop();
		assert.throws(() => noRedirect(whoop).authorizationUrl({ scopes: ['offline'], state: 'long-enough' }), TypeError);
		await assert.rejects(noRedirect(whoop).connect('code'), TypeError);
		assert.equal(whoop.tokenCalls.length, 0);
	});

	it("needs the 'offline' scope, and a state of at least 8 characters", () => {
		const client = newClient(new FakeWhoop(), new MemoryStore(null));
		assert.throws(() => client.authorizationUrl({ scopes: ['read:sleep'], state: 'long-enough' }), /'offline'/);
		assert.throws(() => client.authorizationUrl({ scopes: ['offline'], state: '1234567' }), /at least 8/);
		assert.doesNotThrow(() => client.authorizationUrl({ scopes: ['offline'], state: '12345678' }));
		assert.doesNotThrow(() => client.authorizationUrl({ scopes: ['offline', 'read:some_future_scope'], state: '12345678' }));
	});
});

describe('WhoopClient error details', () => {
	it("reads the rate limit's reset time when WHOOP sends a usable one", async () => {
		const limited = (reset: string | null) => newClient(
			new FakeWhoop(() => new Response('{}', { status: 429, headers: reset === null ? {} : { 'X-RateLimit-Reset': reset } })),
			new MemoryStore(tokens(HOUR)),
		);
		for (const [reset, expected] of [['42', 42], ['0', 0], [null, undefined], ['', undefined], ['soon', undefined], ['-5', undefined]] as const) {
			await assert.rejects(limited(reset).cycles(), (error: unknown) => error instanceof WhoopRateLimitError && error.resetSeconds === expected);
		}
	});

	it('gives every error class a stable name', () => {
		assert.equal(new WhoopError('x').name, 'WhoopError');
		assert.equal(new WhoopAuthError('not_connected').name, 'WhoopAuthError');
		assert.equal(new WhoopRateLimitError().name, 'WhoopRateLimitError');
		assert.equal(new WhoopUnavailableError('x').name, 'WhoopUnavailableError');
		assert.equal(new WhoopRequestError('x', 404).name, 'WhoopRequestError');
		assert.equal(new WhoopProtocolError('x').name, 'WhoopProtocolError');
	});

	it('gives each authorization failure a reason and a neutral message', () => {
		for (const reason of ['not_connected', 'refresh_interrupted', 'authorization_ended'] as const) {
			const error = new WhoopAuthError(reason);
			assert.equal(error.reason, reason);
			assert.doesNotMatch(error.message, /get_auth_url|WHOOP_CLIENT/);
		}
	});

	it('uses the configured timeout', async () => {
		const client = new WhoopClient({
			clientId: 'client-id',
			clientSecret: 'client-secret',
			store: new MemoryStore(tokens(HOUR)),
			timeoutMs: 20,
			fetch: (_input, init) => new Promise((_resolve, reject) => {
				// AbortSignal.timeout's own timer doesn't keep the event loop alive (Node 22 then ends
				// the test with the promise pending), so hold a real timer until the abort fires.
				const keepAlive = setTimeout(() => reject(new Error('the timeout never fired')), 5_000);
				init?.signal?.addEventListener('abort', () => {
					clearTimeout(keepAlive);
					reject(init.signal?.reason);
				});
			}),
		});
		await assert.rejects(client.cycles(), (error: unknown) => error instanceof WhoopUnavailableError && /within 0\.02 seconds/.test(error.message));
	});
});

describe('WhoopClient retries', () => {
	/** A WHOOP whose first N API answers come from `answers`, then empty pages. Records every wait the client asks for. */
	function flaky(...answers: (() => Response)[]) {
		let call = 0;
		const whoop = new FakeWhoop((_url, _bearer, method) => (call < answers.length ? answers[call++]() : ok(method)));
		const waits: number[] = [];
		const client = new WhoopClient({
			clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://localhost:3000/callback',
			store: new MemoryStore(tokens(HOUR)), fetch: whoop.fetch, retry: { wait: async ms => { waits.push(ms); } },
		});
		return { whoop, client, waits };
	}
	const limited = (headers: Record<string, string> = {}) => () => new Response('{}', { status: 429, headers });
	const down = (status = 503, headers: Record<string, string> = {}) => () => new Response('{}', { status, headers });

	it('waits the seconds a 429 names, plus one, then sends the read once more', async () => {
		const { whoop, client, waits } = flaky(limited({ 'X-RateLimit-Reset': '3' }));
		assert.deepEqual(await client.cycles(), []);
		assert.deepEqual(waits, [4000]);
		assert.equal(whoop.apiCalls.length, 2);
	});

	it('reads Retry-After when X-RateLimit-Reset is missing, and waits a second when neither is there', async () => {
		const a = flaky(limited({ 'Retry-After': '2' }));
		await a.client.cycles();
		assert.deepEqual(a.waits, [3000]);
		const b = flaky(limited());
		await b.client.cycles();
		assert.deepEqual(b.waits, [1000]);
	});

	it("doesn't wait out a 429 naming more than 10 seconds: the error carries the number and the message says it", async () => {
		const { whoop, client, waits } = flaky(limited({ 'X-RateLimit-Reset': '45' }));
		await assert.rejects(client.cycles(), (error: unknown) => error instanceof WhoopRateLimitError && error.resetSeconds === 45 && error.message.includes('Try again in 45 seconds.'));
		assert.deepEqual(waits, []);
		assert.equal(whoop.apiCalls.length, 1);
		const long = flaky(limited({ 'X-RateLimit-Reset': '3600' }));
		await assert.rejects(long.client.cycles(), (error: unknown) => error instanceof WhoopRateLimitError && error.message.includes('in 60 minutes'));
	});

	it('retries 500, 502, 503 and 504 once after a second (or Retry-After), and gives up on a second failure saying so', async () => {
		for (const status of [500, 502, 503, 504]) {
			const { client, waits } = flaky(down(status));
			await client.cycles();
			assert.deepEqual(waits, [1000], String(status));
		}
		const after = flaky(down(503, { 'Retry-After': '4' }));
		await after.client.cycles();
		assert.deepEqual(after.waits, [5000]);
		const twice = flaky(down(503), down(502));
		await assert.rejects(twice.client.cycles(), (error: unknown) => error instanceof WhoopUnavailableError && error.status === 502 && error.message.includes('answered 502 after a retry'));
		assert.equal(twice.whoop.apiCalls.length, 2);
	});

	it('ignores X-RateLimit-Reset on a 5xx: only Retry-After names its wait', async () => {
		const { client, waits } = flaky(down(503, { 'X-RateLimit-Reset': '60' }));
		await client.cycles();
		assert.deepEqual(waits, [1000], 'a second, not the rate-limit header, and no refusal for being over the cap');
	});

	it("doesn't wait out a 5xx whose Retry-After is over the cap, and says how long WHOOP asked for", async () => {
		const { whoop, client, waits } = flaky(down(503, { 'Retry-After': '90' }));
		await assert.rejects(client.cycles(), (error: unknown) => error instanceof WhoopUnavailableError && error.message.includes('Try again in 90 seconds.'));
		assert.deepEqual(waits, []);
		assert.equal(whoop.apiCalls.length, 1);
	});

	it('reads a decimal reset, treats a reset over a day or a Retry-After date as unknown, and sits exactly on the cap', async () => {
		const decimal = flaky(limited({ 'X-RateLimit-Reset': '2.5' }));
		await decimal.client.cycles();
		assert.deepEqual(decimal.waits, [3500]);
		const huge = flaky(limited({ 'X-RateLimit-Reset': '99999999' }));
		await huge.client.cycles();
		assert.deepEqual(huge.waits, [1000]);
		const date = flaky(limited({ 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }));
		await date.client.cycles();
		assert.deepEqual(date.waits, [1000]);
		const ten = flaky(limited({ 'X-RateLimit-Reset': '10' }));
		await ten.client.cycles();
		assert.deepEqual(ten.waits, [11000]);
		const eleven = flaky(limited({ 'X-RateLimit-Reset': '11' }));
		await assert.rejects(eleven.client.cycles(), WhoopRateLimitError);
		assert.deepEqual(eleven.waits, []);
	});

	it('reports a 429 after a retried 5xx as the rate limit, in its own words', async () => {
		const { client } = flaky(down(503), limited({ 'X-RateLimit-Reset': '30' }));
		await assert.rejects(client.cycles(), (error: unknown) => error instanceof WhoopRateLimitError && error.message === "WHOOP's rate limit was reached. Try again in 30 seconds.");
	});

	it('shares one retry between callers that joined the same read', async () => {
		const { whoop, client, waits } = flaky(down(503));
		await Promise.all([client.cycles(), client.cycles()]);
		assert.deepEqual(waits, [1000]);
		assert.equal(whoop.apiCalls.length, 2);
	});

	it('resends with the token that is current after the wait, and refreshes against that one on a 401', async () => {
		// During the wait, another request on the same client refreshes the tokens.
		let call = 0;
		const whoop = new FakeWhoop((_url, bearer, method) => {
			call++;
			if (call === 1) return json({}, 503);
			if (call === 2) return json({}, 401); // the resend, answered 401
			return bearer === 'access-2' ? ok(method) : json({}, 401);
		});
		const store = new MemoryStore(tokens(60_000)); // inside the refresh window: the first request refreshes to access-1
		let client: WhoopClient;
		client = new WhoopClient({
			clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://localhost:3000/callback', store, fetch: whoop.fetch,
			retry: { wait: async () => {} },
		});
		await client.cycles();
		assert.equal(whoop.tokenCalls.length, 2, 'one refresh before the first send, one after the 401 on the resend');
		assert.deepEqual(whoop.replays, [], 'no refresh token presented twice');
	});

	it('retries only once: a 429 after the retry is reported, not waited out again', async () => {
		const { whoop, client, waits } = flaky(down(503), limited({ 'X-RateLimit-Reset': '1' }));
		await assert.rejects(client.cycles(), (error: unknown) => error instanceof WhoopRateLimitError && error.resetSeconds === 1 && error.message.includes('in a moment'));
		assert.deepEqual(waits, [1000]);
		assert.equal(whoop.apiCalls.length, 2);
	});

	it('still refreshes after a retried read comes back 401, against the token it sent', async () => {
		const { whoop, client } = flaky(down(503), () => json({}, 401));
		await client.cycles();
		assert.equal(whoop.tokenCalls.length, 1);
		assert.equal(whoop.apiCalls.length, 3);
	});

	it('resends the same page: no record twice, none skipped', async () => {
		const page = (records: number[], next?: string) => () => json({ records: records.map(id => ({ id })), ...(next ? { next_token: next } : {}) });
		const { whoop, client } = flaky(page([1, 2], 'p2'), down(503), page([3, 4]));
		const records = await client.cycles() as unknown as { id: number }[];
		assert.deepEqual(records.map(r => r.id), [1, 2, 3, 4]);
		const cursors = whoop.apiCalls.map(url => url.searchParams.get('nextToken'));
		assert.deepEqual(cursors, [null, 'p2', 'p2']);
	});

	it('never retries the token endpoint or a revoke', async () => {
		const whoop = new FakeWhoop((_url, _bearer, method) => (method === 'DELETE' ? json({}, 503) : ok(method)));
		whoop.tokenStatus = 503;
		const waits: number[] = [];
		const client = new WhoopClient({
			clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://localhost:3000/callback',
			store: new MemoryStore(tokens(60_000)), fetch: whoop.fetch, retry: { wait: async ms => { waits.push(ms); } },
		});
		await assert.rejects(client.revokeAccess(), WhoopUnavailableError);
		assert.deepEqual(waits, []);
		assert.equal(whoop.tokenCalls.length, 1);
		assert.equal(whoop.apiMethods.filter(m => m === 'DELETE').length, 1);
	});

	it("gives up at once when retries are off, and tells the user not to connect when the connection went during the wait", async () => {
		const off = new WhoopClient({
			clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://localhost:3000/callback',
			store: new MemoryStore(tokens(HOUR)), fetch: new FakeWhoop(() => json({}, 503)).fetch, retry: false,
		});
		await assert.rejects(off.cycles(), (error: unknown) => error instanceof WhoopUnavailableError && !error.message.includes('after a retry'));

		let calls = 0;
		const whoop = new FakeWhoop((_url, _bearer, method) => (calls++ === 0 ? json({}, 503) : ok(method)));
		let client: WhoopClient;
		client = new WhoopClient({
			clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'http://localhost:3000/callback',
			store: new MemoryStore(tokens(HOUR)), fetch: whoop.fetch, retry: { wait: async () => { await client.revokeAccess(); } },
		});
		await assert.rejects(client.cycles(), authError('not_connected'));
	});

	it('uses a real timer by default', async () => {
		let call = 0;
		const whoop = new FakeWhoop((_url, _bearer, method) => (call++ === 0 ? new Response('{}', { status: 429, headers: { 'X-RateLimit-Reset': '0' } }) : ok(method)));
		const client = newClient(whoop, new MemoryStore(tokens(HOUR)));
		const started = Date.now();
		await client.cycles();
		assert.ok(Date.now() - started >= 900, 'waited about a second');
		assert.equal(whoop.apiCalls.length, 2);
	});
});

describe('WhoopClient protocol errors on data reads', () => {
	const serving = (response: () => Response) => newClient(new FakeWhoop(() => response()), new MemoryStore(tokens(HOUR)));

	it("wraps a 200 that isn't JSON, naming the endpoint and the content type but never the body", async () => {
		const client = serving(() => new Response('<html>secret-body</html>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
		await assert.rejects(client.sleeps(), (error: unknown) =>
			error instanceof WhoopProtocolError && error.message === "WHOOP answered GET /v2/activity/sleep with something that isn't JSON (content-type: text/html; charset=utf-8)." && !error.message.includes('secret'));
	});

	it('wraps a JSON body without a records array, and one whose next_token is not a string', async () => {
		await assert.rejects(serving(() => json({ records: {} })).cycles(), (error: unknown) => error instanceof WhoopProtocolError && error.message === "WHOOP's answer to GET /v2/cycle has no records array.");
		await assert.rejects(serving(() => json([])).cycles(), WhoopProtocolError);
		assert.deepEqual(await serving(() => json({})).cycles(), [], "a page without records is an empty page: WHOOP's spec doesn't require the key");
		await assert.rejects(serving(() => json({ records: [], next_token: 7 })).cycles(), (error: unknown) => error instanceof WhoopProtocolError && /next_token that isn't a string/.test(error.message));
	});

	it('reports a body cut off mid-read as WHOOP being unavailable, not as a protocol error', async () => {
		const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"records":[')); controller.error(new Error('reset')); } });
		const client = serving(() => new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json' } }));
		await assert.rejects(client.cycles(), (error: unknown) => error instanceof WhoopUnavailableError && error.reachedWhoop && /was cut off/.test(error.message));
	});
});
