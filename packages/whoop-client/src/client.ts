import {
	WhoopAuthError,
	WhoopError,
	WhoopProtocolError,
	WhoopRateLimitError,
	WhoopRequestError,
	WhoopUnavailableError,
} from './errors.js';
import type {
	StoredWhoopTokens,
	TokenStore,
	WhoopCycle,
	WhoopPage,
	WhoopQuery,
	WhoopRecovery,
	WhoopScope,
	WhoopSleep,
	WhoopTokens,
	WhoopWorkout,
} from './types.js';

const WHOOP_API_BASE = 'https://api.prod.whoop.com/developer';
const WHOOP_AUTH_BASE = 'https://api.prod.whoop.com/oauth/oauth2';

const DEFAULT_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 25;
// 90 days need a handful of pages per data type. Reaching this cap means the cursor is
// stuck, and following it further would only hammer the WHOOP API.
const MAX_PAGES = 100;
// An access token this close to expiry is refreshed before it's used.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
// WHOOP's documented length for a state the app generates itself; longer works too.
const MIN_STATE_LENGTH = 8;

export interface WhoopClientOptions {
	clientId: string;
	clientSecret: string;
	/** Where the tokens are kept. Clients that share a store object refresh one at a time. */
	store: TokenStore;
	/** Where WHOOP sends the user back after sign-in. Needed by authorizationUrl() and connect(). */
	redirectUri?: string;
	/** Replaces the global fetch, for example with a fake WHOOP in tests. */
	fetch?: typeof fetch;
	/** How long each request to WHOOP may take, in milliseconds. Default 15 000. */
	timeoutMs?: number;
}

/** What one request presented to WHOOP, filled in as it goes, so revokeAccess() knows which grant it revoked. */
interface Sent {
	tokens?: WhoopTokens;
}

// Network errors that mean the request never left this machine.
const NOT_SENT = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

/** Seconds until WHOOP's rate limit resets, from X-RateLimit-Reset, if it's a readable number. */
function resetSeconds(response: Response): number | undefined {
	const value = response.headers.get('x-ratelimit-reset')?.trim();
	const seconds = value ? Number(value) : NaN;
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

async function failure(response: Response, what: string): Promise<Error> {
	if (response.status === 429) return new WhoopRateLimitError({ resetSeconds: resetSeconds(response) });
	if (response.status >= 500) {
		return new WhoopUnavailableError(`WHOOP is unavailable right now (${what} answered ${response.status}). Try again in a minute.`, { status: response.status });
	}
	return new WhoopRequestError(`WHOOP refused the request (${what} answered ${response.status}): ${(await response.text()).slice(0, 200)}`, response.status);
}

/** The OAuth `error` code in a token endpoint's answer, if it has one. */
async function oauthError(response: Response): Promise<string | undefined> {
	try {
		const body = await response.json() as { error?: unknown };
		return typeof body.error === 'string' ? body.error : undefined;
	} catch {
		return undefined;
	}
}

/** WHOOP's new tokens from a token endpoint's 200. Anything missing or malformed is a WhoopProtocolError. */
async function readTokens(response: Response): Promise<WhoopTokens> {
	let body: unknown;
	try {
		body = await response.json();
	} catch (error) {
		throw new WhoopProtocolError("WHOOP's token endpoint answered with something that isn't JSON.", { cause: error });
	}
	const { access_token: access, refresh_token: refresh, expires_in: expiresIn } = (body ?? {}) as Record<string, unknown>;
	if (typeof access !== 'string' || !access) {
		throw new WhoopProtocolError("WHOOP's token endpoint returned no access token.");
	}
	if (typeof refresh !== 'string' || !refresh) {
		throw new WhoopProtocolError("WHOOP's token endpoint returned no refresh token. WHOOP only issues one when the authorization asks for the 'offline' scope.");
	}
	if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
		throw new WhoopProtocolError("WHOOP's token endpoint returned no usable expires_in.");
	}
	return { access_token: access, refresh_token: refresh, expires_at: Date.now() + expiresIn * 1000 };
}

function expiresSoon(tokens: WhoopTokens): boolean {
	return tokens.expires_at - Date.now() < REFRESH_MARGIN_MS;
}

/** The tokens alone, without the store's mark. */
function tokensOf(stored: StoredWhoopTokens | null): WhoopTokens | null {
	return stored && { access_token: stored.access_token, refresh_token: stored.refresh_token, expires_at: stored.expires_at };
}

/** Runs a store write, retrying it once. Throws the store's error if both attempts fail. */
async function twice(write: () => Promise<void>): Promise<void> {
	try {
		await write();
	} catch {
		await write();
	}
}

/**
 * Refreshes run one at a time for each store object, across every client that shares it.
 * The next one then finds the new tokens in the store instead of refreshing again.
 */
const refreshQueues = new WeakMap<TokenStore, Promise<unknown>>();

function oneAtATime<T>(store: TokenStore, task: () => Promise<T>): Promise<T> {
	const run = (refreshQueues.get(store) ?? Promise.resolve()).then(task, task);
	refreshQueues.set(store, run.catch(() => {}));
	return run;
}

/**
 * A client for the WHOOP API v2. It keeps nothing but the tokens: every call fetches
 * from WHOOP.
 *
 * WHOOP replaces the refresh token on every refresh, and presenting a used one can end
 * the whole authorization. So refreshes follow one set of rules, inside the store's lock:
 * 1. Re-read the store. If its refresh token isn't the one this client last read or
 *    saved, another client refreshed or the user reconnected: use those tokens.
 * 2. Otherwise, if saving earlier tokens failed, save them now.
 * 3. Then refresh only if the access token held now is the one WHOOP just rejected, or
 *    is about to expire:
 *    - if the stored tokens carry a mark, an earlier refresh never finished and the
 *      refresh token may be spent, so ask the user to reconnect instead;
 *    - otherwise mark them, present the refresh token held now, then save the result
 *      (which clears the mark) and use it.
 *    A failure that leaves it unclear whether WHOOP replaced the token keeps the mark.
 *    When WHOOP certainly didn't use the token (it turned the request away, or never
 *    received it), the mark is cleared.
 */
export class WhoopClient {
	private readonly clientId: string;
	private readonly clientSecret: string;
	private readonly redirectUri?: string;
	private readonly store: TokenStore;
	private readonly fetch: typeof fetch;
	private readonly timeoutMs: number;
	/** The tokens this client sends. */
	private tokens: WhoopTokens | null = null;
	/** The refresh token this client last read from or saved to the store. */
	private storedRefreshToken: string | null = null;
	/** The tokens held were issued by WHOOP but couldn't be saved yet. */
	private unsaved = false;
	/**
	 * Identical requests in flight, shared by everyone who asks while they run. Each is
	 * removed when it settles, so nothing is kept.
	 */
	private readonly inFlight = new Map<string, Promise<unknown[]>>();

	constructor(options: WhoopClientOptions) {
		this.clientId = options.clientId;
		this.clientSecret = options.clientSecret;
		this.redirectUri = options.redirectUri;
		this.store = options.store;
		this.fetch = options.fetch ?? globalThis.fetch;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	/**
	 * The WHOOP sign-in link. `state` is yours to generate, keep and check on the way back.
	 * Throws TypeError without the redirectUri option, without the `offline` scope (WHOOP
	 * then issues no refresh token), or for a state under 8 characters.
	 */
	authorizationUrl({ scopes, state }: { scopes: readonly (WhoopScope | (string & {}))[]; state: string }): string {
		const redirectUri = this.requireRedirectUri('authorizationUrl');
		if (!scopes.includes('offline')) {
			throw new TypeError("authorizationUrl() needs the 'offline' scope: without it WHOOP issues no refresh token.");
		}
		if (state.length < MIN_STATE_LENGTH) {
			throw new TypeError(`authorizationUrl() needs a state of at least ${MIN_STATE_LENGTH} characters, as WHOOP requires.`);
		}
		const params = new URLSearchParams({
			client_id: this.clientId,
			redirect_uri: redirectUri,
			response_type: 'code',
			scope: scopes.join(' '),
			state,
		});
		return `${WHOOP_AUTH_BASE}/auth?${params}`;
	}

	/**
	 * Exchanges the code from WHOOP's sign-in for tokens, saves them and uses them from now
	 * on. Throws TypeError without the redirectUri option.
	 */
	async connect(code: string): Promise<void> {
		const redirectUri = this.requireRedirectUri('connect');
		const tokens = await this.requestTokens({
			grant_type: 'authorization_code',
			code,
			redirect_uri: redirectUri,
		});
		// Under the lock, like every other write, so a refresh can't interleave with it.
		await this.underLock(async () => {
			await this.save(tokens);
			this.tokens = tokens;
		});
	}

	cycles(query?: WhoopQuery): Promise<WhoopCycle[]> {
		return this.collection<WhoopCycle>('/v2/cycle', query);
	}

	recoveries(query?: WhoopQuery): Promise<WhoopRecovery[]> {
		return this.collection<WhoopRecovery>('/v2/recovery', query);
	}

	sleeps(query?: WhoopQuery): Promise<WhoopSleep[]> {
		return this.collection<WhoopSleep>('/v2/activity/sleep', query);
	}

	workouts(query?: WhoopQuery): Promise<WhoopWorkout[]> {
		return this.collection<WhoopWorkout>('/v2/activity/workout', query);
	}

	/**
	 * Revokes this app's access at WHOOP, then forgets the tokens: the client's own, and the
	 * store's if it implements clear(). WHOOP may revoke all of the user's tokens for the
	 * app, not just these.
	 *
	 * Tokens someone saved while the revoke was in flight, such as a reconnect, are kept and
	 * used instead: they may be a new, live authorization. If WHOOP had already ended the
	 * authorization, that counts as revoked. Not connected, or any other failure, rejects and
	 * forgets nothing, so it can be retried.
	 */
	async revokeAccess(): Promise<void> {
		const sent: Sent = {};
		try {
			const response = await this.request('DELETE', '/v2/user/access', {}, sent);
			// A 204 has no body; anything else is read and dropped, so it can't hold the connection.
			await response.body?.cancel().catch(() => {});
		} catch (error) {
			if (!(error instanceof WhoopAuthError && error.reason === 'authorization_ended')) throw error;
		}
		// The grant revoked is the one the DELETE carried, not whatever this client holds now:
		// a connect() on this client can replace its tokens while the DELETE is in flight.
		const revoked = sent.tokens?.refresh_token ?? null;
		await this.underLock(async () => {
			const stored = await this.store.load();
			if (stored && stored.refresh_token !== revoked) {
				// Saved after the DELETE was sent, perhaps a reconnect: keep it, as rule 1 does.
				this.tokens = tokensOf(stored);
				this.storedRefreshToken = stored.refresh_token;
				this.unsaved = false;
				return;
			}
			// Forgotten here first, so a store that can't clear still leaves this client disconnected.
			this.tokens = null;
			this.storedRefreshToken = null;
			this.unsaved = false;
			const clear = this.store.clear?.bind(this.store);
			if (clear) await twice(clear);
		});
	}

	private requireRedirectUri(method: string): string {
		if (!this.redirectUri) throw new TypeError(`${method}() needs the redirectUri option.`);
		return this.redirectUri;
	}

	private collection<T>(path: string, query: WhoopQuery = {}): Promise<T[]> {
		const key = JSON.stringify([path, query.start ?? null, query.end ?? null, query.limit ?? null]);
		let shared = this.inFlight.get(key) as Promise<T[]> | undefined;
		if (!shared) {
			shared = this.fetchAll<T>(path, query).finally(() => this.inFlight.delete(key));
			this.inFlight.set(key, shared);
		}
		// Each caller gets its own array, so one can't reorder another's. The records themselves are shared.
		return shared.then(records => [...records]);
	}

	private underLock<T>(task: () => Promise<T>): Promise<T> {
		return oneAtATime(this.store, () => (this.store.withLock ? this.store.withLock(task) : task()));
	}

	/** Saves tokens, retrying once. Throws the store's error if both attempts fail. */
	private async save(tokens: StoredWhoopTokens): Promise<void> {
		await twice(() => this.store.save(tokens));
		this.storedRefreshToken = tokens.refresh_token;
		this.unsaved = false;
	}

	/**
	 * Applies the refresh rules above. `rejected` is an access token WHOOP just refused.
	 * When WHOOP ends the authorization, `sent` records the tokens it refused.
	 */
	private refresh(rejected?: string, sent?: Sent): Promise<void> {
		return this.underLock(async () => {
			const stored = await this.store.load();
			let interrupted = stored?.refresh_started_at != null;
			if ((stored?.refresh_token ?? null) !== this.storedRefreshToken) {
				this.tokens = tokensOf(stored);
				this.storedRefreshToken = stored?.refresh_token ?? null;
				this.unsaved = false;
			} else if (this.unsaved && this.tokens) {
				// Tokens WHOOP hasn't spent, so saving them also clears any mark.
				await this.save(this.tokens);
				interrupted = false;
			}

			if (!this.tokens) throw new WhoopAuthError('not_connected');
			if (this.tokens.access_token !== rejected && !expiresSoon(this.tokens)) return;
			if (interrupted) throw new WhoopAuthError('refresh_interrupted');

			// If the mark can't be saved, WHOOP is never asked.
			const held = this.tokens;
			await this.save({ ...held, refresh_started_at: Date.now() });
			let fresh: WhoopTokens;
			try {
				fresh = await this.requestTokens({ grant_type: 'refresh_token', refresh_token: held.refresh_token });
			} catch (error) {
				// Refused: the authorization has ended.
				if (error instanceof WhoopAuthError) {
					if (sent) sent.tokens = held;
					throw error;
				}
				// Turned away, or never sent: the refresh token is unspent, so clear the mark. If
				// that save fails, step 2 retries it before anything else.
				const unspent = error instanceof WhoopRateLimitError || error instanceof WhoopRequestError ||
					(error instanceof WhoopUnavailableError && !error.reachedWhoop);
				if (unspent) {
					this.unsaved = true;
					await this.save(held);
					throw error;
				}
				// Anything else may have happened after WHOOP replaced the token.
				throw new WhoopAuthError('refresh_interrupted', undefined, { cause: error });
			}
			// Held before saving: the old refresh token is spent, so if the save fails, these
			// are the only tokens that still work. Step 2 saves them next time.
			this.tokens = fresh;
			this.unsaved = true;
			await this.save(fresh);
		});
	}

	private async send(url: string | URL, init: RequestInit): Promise<Response> {
		try {
			return await this.fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
		} catch (error) {
			if (error instanceof Error && error.name === 'TimeoutError') {
				throw new WhoopUnavailableError(`WHOOP didn't answer within ${this.timeoutMs / 1000} seconds. Try again in a minute.`, { cause: error });
			}
			const cause = error instanceof Error ? error.cause as { code?: unknown; message?: unknown } | undefined : undefined;
			const reason = typeof cause?.message === 'string' ? cause.message : error instanceof Error ? error.message : String(error);
			throw new WhoopUnavailableError(`Couldn't reach WHOOP (${reason}). Try again in a minute.`, {
				reachedWhoop: !NOT_SENT.has(String(cause?.code)),
				cause: error,
			});
		}
	}

	private async requestTokens(grant: Record<string, string>): Promise<WhoopTokens> {
		const response = await this.send(`${WHOOP_AUTH_BASE}/token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ ...grant, client_id: this.clientId, client_secret: this.clientSecret }),
		});

		if (response.status === 400 || response.status === 401) {
			const error = await oauthError(response);
			// WHOOP refused the code or refresh token itself: only a new authorization helps.
			if (error === 'invalid_grant' || error === undefined) throw new WhoopAuthError('authorization_ended');
			// Refused before the token was looked at, such as for a wrong client secret.
			throw new WhoopRequestError(`WHOOP refused the app's client credentials (${error}).`, response.status, { oauthError: error });
		}
		if (!response.ok) {
			throw await failure(response, 'the token endpoint');
		}
		return readTokens(response);
	}

	/**
	 * One request to the WHOOP API, with the refresh rules around it. `sent` records the
	 * tokens presented in each attempt.
	 */
	private async request(method: 'GET' | 'DELETE', path: string, params: Record<string, string> = {}, sent: Sent = {}): Promise<Response> {
		// Nothing held yet (first use, or not connected before): the store may have tokens now.
		// Read under the lock, and only if still nothing is held: another request on this client
		// may have loaded and refreshed meanwhile, and a copy read before that refresh would
		// bring back the refresh token WHOOP has just spent.
		if (!this.tokens) {
			await this.underLock(async () => {
				if (this.tokens) return;
				const stored = await this.store.load();
				this.tokens = tokensOf(stored);
				this.storedRefreshToken = stored?.refresh_token ?? null;
			});
		}
		if (!this.tokens) {
			throw new WhoopAuthError('not_connected');
		}

		if (this.unsaved || expiresSoon(this.tokens)) {
			try {
				await this.refresh(undefined, sent);
			} catch (error) {
				// WHOOP failing to refresh a token that hasn't expired yet isn't the end: the
				// token may still be accepted, and a 401 below retries the refresh.
				if (!(error instanceof WhoopError) || !this.tokens || this.tokens.expires_at <= Date.now()) throw error;
			}
		}

		const url = new URL(`${WHOOP_API_BASE}${path}`);
		for (const [key, value] of Object.entries(params)) {
			url.searchParams.set(key, value);
		}

		sent.tokens = this.tokens;
		const sentToken = this.tokens.access_token;
		let response = await this.send(url, { method, headers: { Authorization: `Bearer ${sentToken}` } });

		if (response.status === 401) {
			// One refresh and one retry, never more. If another request already refreshed
			// while this one was in flight, the refresh rules retry with its token instead.
			await this.refresh(sentToken, sent);
			sent.tokens = this.tokens;
			response = await this.send(url, { method, headers: { Authorization: `Bearer ${this.tokens.access_token}` } });
			if (response.status === 401) {
				throw new WhoopAuthError('authorization_ended');
			}
		}

		if (!response.ok) {
			throw await failure(response, `${method} ${path}`);
		}
		return response;
	}

	private async fetchAll<T>(path: string, { start, end, limit }: WhoopQuery): Promise<T[]> {
		const results: T[] = [];
		const seenCursors = new Set<string>();
		let nextToken: string | undefined;

		for (let page = 0; page < MAX_PAGES; page++) {
			const wanted = limit === undefined ? PAGE_SIZE : Math.min(PAGE_SIZE, limit - results.length);
			const params: Record<string, string> = { limit: String(wanted) };
			if (start) params.start = start;
			if (end) params.end = end;
			if (nextToken) params.nextToken = nextToken;

			const response = await (await this.request('GET', path, params)).json() as WhoopPage<T>;
			results.push(...response.records);
			nextToken = response.next_token;

			if (limit !== undefined && results.length >= limit) return results.slice(0, limit);
			if (!nextToken) return results;
			if (seenCursors.has(nextToken)) {
				throw new WhoopProtocolError(`Whoop returned the same page cursor twice for ${path}; stopping.`);
			}
			seenCursors.add(nextToken);
		}

		throw new WhoopProtocolError(`Whoop pagination for ${path} did not finish after ${MAX_PAGES} pages; stopping.`);
	}
}
