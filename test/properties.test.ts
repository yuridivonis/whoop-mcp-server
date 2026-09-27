/**
 * Property-based tests: fast-check generates many inputs, including races between
 * concurrent requests, and shrinks any failure to a minimal counterexample. On a failure
 * it prints the seed that reproduces it. All data is synthetic.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { cleanName, consentText, renderLoginPage } from '../src/auth/login-page.js';
import { redirectAllowed } from '../src/auth/redirects.js';
import { decrypt, encrypt } from '../src/crypto.js';
import { localDate, wakeDay } from '../src/days.js';
import { isNewer } from '../src/updates.js';
import { WhoopAuthError, WhoopClient } from '../src/whoop-client.js';
import type { StoredWhoopTokens, TokenStore, WhoopCycle } from '../src/types.js';
import { FakeWhoop } from './fake-whoop.js';

process.env.ENCRYPTION_SECRET ??= 'test-encryption-secret';

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

/**
 * A WHOOP whose every response is delivered when the scheduler decides, so requests from
 * several clients interleave in every order. It rotates refresh tokens like the real one and
 * records a violation whenever a refresh token is presented again after WHOOP has read it:
 * the one thing the refresh rules must never do, because it can end the authorization.
 * Tokens turned away unread (rate limited, or never sent) may be presented again.
 */
class ScheduledWhoop {
	readonly violations: string[] = [];
	/** Refresh tokens issued by a new authorization (a reconnect), not by a refresh. */
	readonly authorizations = new Set<string>();
	private readonly read = new Set<string>();
	private grants = 0;
	private issued = 0;
	private latestAccess: string;
	private tokenOutcomes: TokenOutcome[];
	private apiOutcomes: ApiOutcome[];
	readonly fetch: typeof fetch;

	constructor(s: fc.Scheduler, first: StoredWhoopTokens, tokenOutcomes: TokenOutcome[], apiOutcomes: ApiOutcome[]) {
		this.latestAccess = first.access_token;
		this.tokenOutcomes = [...tokenOutcomes];
		this.apiOutcomes = [...apiOutcomes];
		this.fetch = s.scheduleFunction((input: string | URL | Request, init?: RequestInit) => this.respond(input, init)) as typeof fetch;
	}

	/** From now on WHOOP behaves. */
	heal(): void {
		this.tokenOutcomes = [];
		this.apiOutcomes = [];
	}

	private issue(grant: number): Response {
		this.issued++;
		this.latestAccess = `access-${grant}-${this.issued}`;
		return Response.json({ access_token: this.latestAccess, refresh_token: `refresh-${grant}-${this.issued}`, expires_in: 3600 });
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
			const outcome = this.tokenOutcomes.shift() ?? 'ok';
			if (outcome === 'never-sent') {
				throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
			}
			if (outcome === 'rate-limited') return Response.json({ error: 'rate_limited' }, { status: 429 });
			if (this.read.has(presented)) this.violations.push(`presented ${presented} again`);
			this.read.add(presented);
			if (outcome === 'refused') return Response.json({ error: 'invalid_grant' }, { status: 400 });
			if (outcome === 'failed-before-rotating') return Response.json({ error: 'server_error' }, { status: 502 });
			const rotated = this.issue(order(presented)[0]);
			// The new tokens were issued, but the response never arrived.
			if (outcome === 'failed-after-rotating') return Response.json({ error: 'server_error' }, { status: 502 });
			return rotated;
		}
		const bearer = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '');
		const outcome = this.apiOutcomes.shift() ?? 'ok';
		if (outcome === 'rejected' || bearer !== this.latestAccess) return Response.json({}, { status: 401 });
		if (outcome === 'unavailable') return Response.json({}, { status: 503 });
		return Response.json({ records: [] });
	}
}

/** One stored row, shared by every client, like a database. Saves can be made to fail. */
class Row {
	readonly violations: string[] = [];
	private locked: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly s: fc.Scheduler,
		public tokens: StoredWhoopTokens | null,
		private saveFailures: boolean[],
		private readonly authorizations: Set<string>,
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
	it('never present a refresh token WHOOP may have spent, never go back to older tokens, and always settle', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.scheduler(),
				fc.boolean(),
				fc.array(fc.record({ client: fc.constantFrom('A', 'B', 'C'), reconnect: fc.boolean() }), { minLength: 1, maxLength: 6 }),
				fc.array(tokenOutcome, { maxLength: 6 }),
				fc.array(apiOutcome, { maxLength: 8 }),
				fc.array(fc.boolean(), { maxLength: 6 }),
				async (s, expiring, calls, tokenOutcomes, apiOutcomes, saveFailures) => {
					// Expiry is an hour either side of the refresh margin, so the real clock can't matter.
					const first: StoredWhoopTokens = { access_token: 'access-0-0', refresh_token: 'refresh-0-0', expires_at: Date.now() + (expiring ? -HOUR : HOUR) };
					const whoop = new ScheduledWhoop(s, first, tokenOutcomes, apiOutcomes);
					const row = new Row(s, first, saveFailures, whoop.authorizations);
					const client = (store: TokenStore) =>
						new WhoopClient({ clientId: 'id', clientSecret: 'secret', redirectUri: 'http://localhost:3000/callback', store, fetch: whoop.fetch });
					// A and B share one store object (one process); C has its own, as another process would.
					const shared = row.store();
					const clients = { A: client(shared), B: client(shared), C: client(row.store()) };

					const settled = calls.map(({ client: name, reconnect }) =>
						(reconnect ? clients[name].exchangeCodeForTokens('code') : clients[name].cycles()).then(() => 'ok', (error: unknown) => error),
					);
					await s.waitFor(Promise.all(settled));

					// Afterwards, with WHOOP and the disk healthy, a request succeeds or asks to reconnect.
					whoop.heal();
					row.heal();
					const after = client(row.store()).cycles().then(() => 'ok', (error: unknown) => error);
					const outcome = await s.waitFor(after);

					assert.deepEqual(whoop.violations, []);
					assert.deepEqual(row.violations, []);
					assert.ok(outcome === 'ok' || outcome instanceof WhoopAuthError, `after recovery: ${String(outcome)}`);
				},
			),
			// A stalled call fails the run (and is shrunk) instead of hanging the suite.
			{ numRuns: 300, timeout: 2_000 },
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

// --- Versions, names, the sign-in page, redirects, days, encryption --------------------------

describe('isNewer', () => {
	const version = fc.tuple(fc.nat({ max: 1000 }), fc.nat({ max: 1000 }), fc.nat({ max: 1000 }));
	const text = ([a, b, c]: number[]) => `${a}.${b}.${c}`;
	const compare = (x: number[], y: number[]) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];

	it('orders versions by their numbers, strictly', () => {
		fc.assert(fc.property(version, version, (x, y) => {
			assert.equal(isNewer(text(x), text(y)), compare(x, y) > 0);
			assert.equal(isNewer(`v${text(x)}`, text(y)), compare(x, y) > 0, 'a leading v is allowed');
			assert.ok(!(isNewer(text(x), text(y)) && isNewer(text(y), text(x))), 'asymmetric');
		}));
	});

	it('never calls something that is not a version newer', () => {
		fc.assert(fc.property(fc.string(), version, (junk, y) => {
			fc.pre(!/^\s*v?\d+\.\d+\.\d+\s*$/.test(junk));
			assert.equal(isNewer(junk, text(y)), false);
		}));
	});
});

describe('app names from clients', () => {
	// The characters the sign-in page and the log must never show: controls and bidirectional marks.
	const REMOVED = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/;
	const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

	it('are cleaned of controls and bidirectional marks, capped at 80 characters, and stay well-formed', () => {
		// Names around the 80-character cut, with characters outside the basic plane, are the tricky ones.
		const name = fc.oneof(
			fc.string({ unit: 'binary', maxLength: 200 }),
			fc.tuple(fc.string({ unit: 'binary-ascii', minLength: 70, maxLength: 85 }), fc.string({ unit: 'binary', minLength: 1, maxLength: 10 })).map(([a, b]) => a + b),
		);
		fc.assert(fc.property(name, name => {
			const cleaned = cleanName(name);
			assert.doesNotMatch(cleaned, REMOVED);
			assert.ok([...cleaned].length <= 80);
			assert.doesNotMatch(cleaned, LONE_SURROGATE, 'no half of a surrogate pair is left behind');
			assert.equal(cleanName(cleaned), cleaned, 'cleaning twice changes nothing');
		}));
	});
});

describe('the sign-in page', () => {
	const attacker = fc.string({ unit: fc.constantFrom('<', '>', '"', "'", '&', 'a', ' ', '/', '=', '\u202e'), maxLength: 20 });
	const render = (name: string, state: string, scope: string, resource: string, destination: string) =>
		renderLoginPage({
			client: { client_id: 'client', client_name: name, redirect_uris: [] } as never,
			params: { redirectUri: 'https://claude.ai/cb', codeChallenge: 'challenge', state, scopes: scope ? [scope] : [], resource: new URL(`https://mcp.example/${encodeURIComponent(resource)}`) } as never,
			destination,
		});
	const unescape = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

	it('lets nothing an app or a link controls add markup, and posts every field back unchanged', () => {
		const benign = render('x', 'x', 'x', 'x', 'x');
		const count = (html: string, char: string) => html.split(char).length - 1;
		fc.assert(fc.property(attacker, attacker, attacker, attacker, attacker, (name, state, scope, resource, destination) => {
			const html = render(name || 'x', state || 'x', scope || 'x', resource || 'x', destination || 'x');
			for (const char of ['<', '>', '"']) assert.equal(count(html, char), count(benign, char), `no extra ${char}`);
			const hidden = Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(([, key, value]) => [key, unescape(value)]));
			assert.equal(hidden.state, state || 'x');
			assert.equal(hidden.scope, scope || 'x');
			assert.equal(hidden.resource, new URL(`https://mcp.example/${encodeURIComponent(resource || 'x')}`).href);
			assert.ok(html.includes(consentText(destination || 'x').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')));
		}));
	});
});

describe('where sign-in codes may go', () => {
	const allowed = ['claude.ai', 'claude.com', 'chatgpt.com'];
	const other = fc.domain().filter(host => !allowed.includes(host) && !allowed.some(a => host.endsWith(`.${a}`)));

	it('only to an allowlisted https host, this computer over http, or a known desktop app', () => {
		const label = fc.stringMatching(/^[a-z0-9-]{1,12}$/);
		fc.assert(fc.property(other, fc.constantFrom(...allowed), fc.nat({ max: 65535 }), label, (host, good, port, prefix) => {
			for (const uri of [
				// Only the exact host: not a look-alike, not a subdomain, not a host that merely contains it.
				`https://${prefix}${good}/cb`, `https://${prefix}.${good}/cb`,
				`https://${good}.${host}/cb`, `https://${host}/${good}`, `https://${good}@${host}/cb`, `https://${host}/cb?next=${good}`,
				`https://${host}#${good}`, `http://${good}/cb`, `http://${host}:${port}/cb`, `ftp://${good}/cb`, `javascript:alert('${good}')`,
			]) {
				assert.equal(redirectAllowed(uri, allowed), false, uri);
			}
			for (const uri of [`https://${good}/cb`, `https://${good.toUpperCase()}/cb`, `http://127.0.0.1:${port}/cb`, `http://localhost:${port}`, 'cursor://anysphere.cursor-mcp/oauth/callback']) {
				assert.equal(redirectAllowed(uri, allowed), true, uri);
			}
		}));
	});
});

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

describe('token encryption', () => {
	it('gives back exactly what it encrypted', () => {
		fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: 300 }), secret => {
			assert.equal(decrypt(encrypt(secret)), secret);
		}));
	});

	it('refuses anything that was changed', () => {
		fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 50 }), fc.nat(), fc.nat({ max: 14 }), (secret, at, delta) => {
			const sealed = encrypt(secret);
			const index = at % sealed.length;
			fc.pre(sealed[index] !== ':');
			const flipped = ((Number.parseInt(sealed[index], 16) + delta + 1) % 16).toString(16);
			assert.throws(() => decrypt(sealed.slice(0, index) + flipped + sealed.slice(index + 1)));
		}));
	});
});
