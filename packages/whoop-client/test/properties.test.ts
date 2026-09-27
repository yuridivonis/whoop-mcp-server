/**
 * Property-based tests: fast-check generates many inputs, including races between
 * concurrent requests, and shrinks any failure to a minimal counterexample. On a failure
 * it prints the seed that reproduces it. All data is synthetic.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { WhoopAuthError, WhoopClient, localDate, wakeDay, type StoredWhoopTokens, type TokenStore, type WhoopCycle } from '../src/index.js';
import { FakeWhoop } from './fake-whoop.js';

const HOUR = 60 * 60 * 1000;
const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';

// --- The refresh rules under random races -------------------------------------------------

/** What WHOOP's token endpoint does with one refresh request. */
type TokenOutcome = 'ok' | 'refused' | 'rate-limited' | 'never-sent' | 'failed-before-rotating' | 'failed-after-rotating';
/** What WHOOP's API does with one data request (on top of rejecting stale access tokens). */
type ApiOutcome = 'ok' | 'rejected' | 'unavailable';

/** Refresh tokens are `refresh-<grant>-<n>`: a reconnect starts a newer grant. */
function order(refreshToken: string): [number, number] {
	const [, grant, n] = refreshToken.split('-');
	return [Number(grant), Number(n)];
}

/** The grant an access token (`access-<grant>-<n>`) belongs to. */
function grantOf(accessToken: string | undefined): number {
	return Number(accessToken?.split('-')[1]);
}

/** What a revoke covers: every grant the user has for the app so far, or only the one presented. */
type RevokeModel = 'user' | 'grant';

/**
 * A WHOOP whose every response is delivered when the scheduler decides, so requests from
 * several clients interleave in every order. It rotates refresh tokens like the real one and
 * records a violation whenever a refresh token is presented again after WHOOP has read it:
 * the one thing the refresh rules must never do, because it can end the authorization.
 * Tokens turned away unread (rate limited, or never sent) may be presented again.
 *
 * It also answers revokes, and enforces them: every token of a revoked grant is refused
 * from then on. It keeps a book of which grants are revoked or dead, so the store can tell
 * whether clearing some tokens erased a live authorization.
 */
class ScheduledWhoop {
	readonly violations: string[] = [];
	/** Grants a revoke (a 2xx DELETE) covered. */
	private readonly revoked = new Set<number>();
	/** Grants WHOOP declared dead: a refused refresh token, or its newest access token rejected. */
	private readonly dead = new Set<number>();
	/** Refresh tokens issued by a new authorization (a reconnect), not by a refresh. */
	readonly authorizations = new Set<string>();
	private readonly read = new Set<string>();
	private grants = 0;
	private issued = 0;
	/** Each grant's newest access token: the only one of that grant WHOOP accepts. Older grants stay valid until revoked. */
	private readonly latestAccess = new Map<number, string>();
	private tokenOutcomes: TokenOutcome[];
	private apiOutcomes: ApiOutcome[];
	readonly fetch: typeof fetch;

	constructor(
		s: fc.Scheduler,
		first: StoredWhoopTokens,
		tokenOutcomes: TokenOutcome[],
		apiOutcomes: ApiOutcome[],
		private readonly revokeModel: RevokeModel,
	) {
		this.latestAccess.set(grantOf(first.access_token), first.access_token);
		this.tokenOutcomes = [...tokenOutcomes];
		this.apiOutcomes = [...apiOutcomes];
		this.fetch = s.scheduleFunction((input: string | URL | Request, init?: RequestInit) => this.respond(input, init)) as typeof fetch;
	}

	/** Whether tokens with this refresh token belong to a grant that's neither revoked nor dead. */
	live(refreshToken: string): boolean {
		const [grant] = order(refreshToken);
		return !this.revoked.has(grant) && !this.dead.has(grant);
	}

	/** From now on WHOOP behaves (revoked grants stay revoked). */
	heal(): void {
		this.tokenOutcomes = [];
		this.apiOutcomes = [];
	}

	private issue(grant: number): Response {
		this.issued++;
		const access = `access-${grant}-${this.issued}`;
		this.latestAccess.set(grant, access);
		return Response.json({ access_token: access, refresh_token: `refresh-${grant}-${this.issued}`, expires_in: 3600 });
	}

	private async respond(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		const url = String(input instanceof Request ? input.url : input);
		if (url === TOKEN_URL) {
			const form = new URLSearchParams(init?.body as URLSearchParams);
			if (form.get('grant_type') === 'authorization_code') {
				const response = this.issue(++this.grants);
				this.authorizations.add(`refresh-${this.grants}-${this.issued}`);
				return response;
			}
			const presented = form.get('refresh_token') ?? '';
			if (this.revoked.has(order(presented)[0])) {
				if (this.read.has(presented)) this.violations.push(`presented ${presented} again`);
				this.read.add(presented);
				return Response.json({ error: 'invalid_grant' }, { status: 400 });
			}
			const outcome = this.tokenOutcomes.shift() ?? 'ok';
			if (outcome === 'never-sent') {
				throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
			}
			if (outcome === 'rate-limited') return Response.json({ error: 'rate_limited' }, { status: 429 });
			if (this.read.has(presented)) this.violations.push(`presented ${presented} again`);
			this.read.add(presented);
			if (outcome === 'refused') {
				this.dead.add(order(presented)[0]);
				return Response.json({ error: 'invalid_grant' }, { status: 400 });
			}
			if (outcome === 'failed-before-rotating') return Response.json({ error: 'server_error' }, { status: 502 });
			const rotated = this.issue(order(presented)[0]);
			// The new tokens were issued, but the response never arrived.
			if (outcome === 'failed-after-rotating') return Response.json({ error: 'server_error' }, { status: 502 });
			return rotated;
		}
		const bearer = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '');
		if (this.revoked.has(grantOf(bearer))) return Response.json({}, { status: 401 });
		const newest = bearer === this.latestAccess.get(grantOf(bearer));
		const outcome = this.apiOutcomes.shift() ?? 'ok';
		if (outcome === 'rejected' && newest) this.dead.add(grantOf(bearer));
		if (outcome === 'rejected' || !newest) return Response.json({}, { status: 401 });
		if (outcome === 'unavailable') return Response.json({}, { status: 503 });
		if (init?.method === 'DELETE') {
			if (this.revokeModel === 'user') {
				for (let grant = 0; grant <= this.grants; grant++) this.revoked.add(grant);
			} else {
				this.revoked.add(grantOf(bearer));
			}
			return new Response(null, { status: 204 });
		}
		return Response.json({ records: [] });
	}
}

/** One stored row, shared by every client, like a database. Saves and clears can be made to fail. */
class Row {
	readonly violations: string[] = [];
	private locked: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly s: fc.Scheduler,
		public tokens: StoredWhoopTokens | null,
		private saveFailures: boolean[],
		private readonly authorizations: Set<string>,
		private readonly live: (refreshToken: string) => boolean,
	) {}

	heal(): void {
		this.saveFailures = [];
	}

	/** A store object over this row. Separate objects stand for separate processes. */
	store(): TokenStore {
		return {
			load: this.s.scheduleFunction(async () => this.tokens && { ...this.tokens }),
			save: this.s.scheduleFunction(async (saved: StoredWhoopTokens) => {
				if (this.saveFailures.shift()) throw new Error('disk full');
				if (this.tokens) {
					const [grantBefore, nBefore] = order(this.tokens.refresh_token);
					const [grantAfter, nAfter] = order(saved.refresh_token);
					// Two reconnects that finish in the opposite order save in the order they finish:
					// both are the owner's own, fresh authorizations. Anything else going back to older
					// tokens (a refresh or a mark over a reconnect, or an older token of the same
					// authorization) would present a spent token sooner or later.
					const reconnect = this.authorizations.has(saved.refresh_token) && saved.refresh_started_at === undefined;
					const backwards = grantAfter === grantBefore ? nAfter < nBefore : grantAfter < grantBefore && !reconnect;
					if (backwards) this.violations.push(`saved ${saved.refresh_token} over newer ${this.tokens.refresh_token}`);
				}
				this.tokens = { ...saved };
			}),
			clear: this.s.scheduleFunction(async () => {
				if (this.saveFailures.shift()) throw new Error('disk full');
				// Only tokens WHOOP has revoked or declared dead may be forgotten: erasing a live
				// authorization, such as a reconnect made during the revoke, would sign the user out.
				if (this.tokens && this.live(this.tokens.refresh_token)) this.violations.push(`cleared live ${this.tokens.refresh_token}`);
				this.tokens = null;
			}),
			withLock: <T>(task: () => Promise<T>): Promise<T> => {
				const run = this.locked.then(task);
				this.locked = run.catch(() => {});
				return run;
			},
		};
	}
}

const tokenOutcome = fc.constantFrom<TokenOutcome>('ok', 'ok', 'refused', 'rate-limited', 'never-sent', 'failed-before-rotating', 'failed-after-rotating');
const apiOutcome = fc.constantFrom<ApiOutcome>('ok', 'ok', 'rejected', 'unavailable');

describe('the refresh rules, under random races and failures', () => {
	it('never present a refresh token WHOOP may have spent, never go back to older tokens, never forget a live authorization, and always settle', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.scheduler(),
				fc.boolean(),
				fc.array(fc.record({ client: fc.constantFrom('A', 'B', 'C'), kind: fc.constantFrom('read', 'read', 'reconnect', 'revoke') }), { minLength: 1, maxLength: 6 }),
				fc.array(tokenOutcome, { maxLength: 6 }),
				fc.array(apiOutcome, { maxLength: 8 }),
				fc.array(fc.boolean(), { maxLength: 6 }),
				fc.constantFrom<RevokeModel>('user', 'grant'),
				async (s, expiring, calls, tokenOutcomes, apiOutcomes, saveFailures, revokeModel) => {
					// Expiry is an hour either side of the refresh margin, so the real clock can't matter.
					const first: StoredWhoopTokens = { access_token: 'access-0-0', refresh_token: 'refresh-0-0', expires_at: Date.now() + (expiring ? -HOUR : HOUR) };
					const whoop = new ScheduledWhoop(s, first, tokenOutcomes, apiOutcomes, revokeModel);
					const row = new Row(s, first, saveFailures, whoop.authorizations, token => whoop.live(token));
					const client = (store: TokenStore) =>
						new WhoopClient({ clientId: 'id', clientSecret: 'secret', redirectUri: 'http://localhost:3000/callback', store, fetch: whoop.fetch });
					// A and B share one store object (one process); C has its own, as another process would.
					const shared = row.store();
					const clients = { A: client(shared), B: client(shared), C: client(row.store()) };

					const run = { read: (c: WhoopClient) => c.cycles(), reconnect: (c: WhoopClient) => c.connect('code'), revoke: (c: WhoopClient) => c.revokeAccess() };
					const settled = calls.map(({ client: name, kind }) => run[kind](clients[name]).then(() => 'ok', (error: unknown) => error));
					await s.waitFor(Promise.all(settled));

					// Afterwards, with WHOOP and the disk healthy, a request succeeds or asks to reconnect.
					// Under the user-wide model, a reconnect WHOOP processed before a revoke is revoked
					// with it: its tokens are kept (not a violation), and this asks to reconnect.
					whoop.heal();
					row.heal();
					const after = client(row.store()).cycles().then(() => 'ok', (error: unknown) => error);
					const outcome = await s.waitFor(after);

					assert.deepEqual(whoop.violations, []);
					assert.deepEqual(row.violations, []);
					assert.ok(outcome === 'ok' || outcome instanceof WhoopAuthError, `after recovery: ${String(outcome)}`);
				},
			),
			// A stalled call fails the run (and is shrunk) instead of hanging the suite. Each run takes
			// well under a millisecond, and some races need thousands of schedules to show up.
			{ numRuns: 3000, timeout: 2_000 },
		);
	});
});

// --- Paging and shared requests -----------------------------------------------------------

function cycles(count: number): WhoopCycle[] {
	return Array.from({ length: count }, (_, i) => ({
		id: i + 1, user_id: 1, start: new Date(Date.UTC(2026, 0, 1) + i * HOUR).toISOString(), end: null,
		timezone_offset: '+00:00', score_state: 'SCORED' as const, score: { strain: 5, kilojoule: 1000, average_heart_rate: 60, max_heart_rate: 120 },
	}));
}

function clientFor(whoop: FakeWhoop): WhoopClient {
	let tokens: StoredWhoopTokens | null = { access_token: 'a', refresh_token: 'r', expires_at: Date.now() + HOUR };
	return new WhoopClient({
		clientId: 'id', clientSecret: 'secret', redirectUri: 'http://localhost:3000/callback', fetch: whoop.fetch,
		store: { load: async () => tokens, save: async saved => { tokens = saved; } },
	});
}

describe('paging', () => {
	it('returns exactly the newest min(limit, total) records, in as few requests as pages allow', async () => {
		await fc.assert(
			fc.asyncProperty(fc.integer({ min: 0, max: 80 }), fc.option(fc.integer({ min: 1, max: 80 }), { nil: undefined }), async (total, limit) => {
				const whoop = new FakeWhoop();
				whoop.records.cycles.push(...cycles(total));
				const got = await clientFor(whoop).cycles(limit === undefined ? {} : { limit });
				const expected = Math.min(limit ?? total, total);
				assert.equal(got.length, expected);
				assert.deepEqual(got.map(cycle => cycle.id), Array.from({ length: expected }, (_, i) => total - i));
				assert.equal(whoop.requests.length, Math.max(1, Math.ceil(expected / 25)));
			}),
			{ numRuns: 150 },
		);
	});
});

describe('requests in flight', () => {
	it('are shared between identical queries, never between different ones, and each caller gets its own array', async () => {
		const query = fc.record({ start: fc.constantFrom(undefined, '2026-01-01T00:00:00.000Z', '2026-01-01T05:00:00.000Z'), limit: fc.constantFrom(undefined, 1, 3) });
		await fc.assert(
			fc.asyncProperty(fc.array(query, { minLength: 1, maxLength: 8 }), async queries => {
				const whoop = new FakeWhoop();
				whoop.records.cycles.push(...cycles(10));
				const client = clientFor(whoop);
				const results = await Promise.all(queries.map(q => client.cycles({ ...(q.start ? { start: q.start } : {}), ...(q.limit ? { limit: q.limit } : {}) })));
				const distinct = new Set(queries.map(q => `${q.start}|${q.limit}`));
				assert.equal(whoop.requests.length, distinct.size);
				assert.equal(new Set(results).size, results.length, 'no two callers share an array');
				queries.forEach((q, i) => {
					const expected = cycles(10).filter(c => !q.start || c.start >= q.start).reverse().slice(0, q.limit ?? 10);
					assert.deepEqual(results[i].map(c => c.id), expected.map(c => c.id));
				});
			}),
			{ numRuns: 150 },
		);
	});
});

// --- Days ----------------------------------------------------------------------------------

describe('local days', () => {
	// Offsets as WHOOP sends them, from UTC-12 to UTC+14, with and without a colon.
	const offset = fc.integer({ min: -12 * 60, max: 14 * 60 }).map(minutes => {
		const abs = Math.abs(minutes);
		return `${minutes < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
	});
	const instant = fc.integer({ min: Date.UTC(1971, 0, 1), max: Date.UTC(2100, 0, 1) }).map(ms => new Date(ms).toISOString());

	it('are the date where the record happened, however the offset is written', () => {
		fc.assert(fc.property(instant, offset, (iso, off) => {
			const day = localDate(iso, off);
			assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
			const [, sign, hours, minutes] = /^([+-])(\d\d):(\d\d)$/.exec(off) ?? [];
			const shiftMs = (sign === '-' ? -1 : 1) * (Number(hours) * 60 + Number(minutes)) * 60_000;
			assert.equal(localDate(new Date(Date.parse(iso) + shiftMs).toISOString(), '+00:00'), day);
			assert.equal(localDate(iso, off.replace(':', '')), day, '+0800 and +08:00 mean the same');
			assert.equal(wakeDay(iso, off), localDate(new Date(Date.parse(iso) + 12 * HOUR).toISOString(), off));
		}));
	});
});
