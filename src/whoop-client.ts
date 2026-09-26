import type {
	StoredWhoopTokens,
	TokenStore,
	WhoopTokens,
	WhoopCycle,
	WhoopRecovery,
	WhoopSleep,
	WhoopWorkout,
	WhoopPaginatedResponse,
} from './types.js';

const WHOOP_API_BASE = 'https://api.prod.whoop.com/developer';
const WHOOP_AUTH_BASE = 'https://api.prod.whoop.com/oauth/oauth2';

const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 25;
// 90 days need a handful of pages per data type. Reaching this cap means the cursor is
// stuck, and following it further would only hammer the WHOOP API.
const MAX_PAGES = 100;
// An access token this close to expiry is refreshed before it's used.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const NOT_CONNECTED = 'Not authenticated with Whoop. Use the get_auth_url tool to connect.';
const REFRESH_INTERRUPTED =
	"A WHOOP token refresh didn't finish, so WHOOP may have replaced the token without this server getting the new one. " +
	'Use the get_auth_url tool to reconnect.';

interface WhoopClientConfig {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	/** Where the tokens are kept. Clients that share a store object refresh one at a time. */
	store: TokenStore;
	/** Replaces the global fetch, for example with a fake WHOOP in tests. */
	fetch?: typeof fetch;
}

/** Which records to fetch. WHOOP returns the newest first. */
export interface Query {
	/** Only records from this time on (ISO 8601). */
	start?: string;
	/** Only records before this time (ISO 8601). */
	end?: string;
	/** At most this many records. */
	limit?: number;
}

/** Anything that went wrong talking to WHOOP, as opposed to the token store. */
export class WhoopError extends Error {}

/** WHOOP isn't connected, or rejected the stored tokens: the user has to authorize again. */
export class WhoopAuthError extends WhoopError {
	constructor(message = 'Whoop authorization expired. Use the get_auth_url tool to reconnect.') {
		super(message);
		this.name = 'WhoopAuthError';
	}
}

/** WHOOP's rate limit was reached. */
export class WhoopRateLimitError extends WhoopError {
	constructor() {
		super("WHOOP's rate limit was reached. Try again in a minute.");
		this.name = 'WhoopRateLimitError';
	}
}

/** WHOOP failed (5xx), didn't answer in time, or couldn't be reached. */
export class WhoopUnavailableError extends WhoopError {
	/** WHOOP's HTTP status, when it answered at all. */
	readonly status?: number;
	readonly at = new Date();
	/** False when the request certainly never reached WHOOP, such as when its address couldn't be looked up. */
	readonly reachedWhoop: boolean;

	constructor(message: string, { status, reachedWhoop = true }: { status?: number; reachedWhoop?: boolean } = {}) {
		super(message);
		this.name = 'WhoopUnavailableError';
		this.status = status;
		this.reachedWhoop = reachedWhoop;
	}
}

/** WHOOP turned the request away (a 4xx that isn't about the user's authorization or the rate limit). */
export class WhoopRequestError extends WhoopError {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = 'WhoopRequestError';
		this.status = status;
	}
}

// Network errors that mean the request never left this server.
const NOT_SENT = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

async function failure(response: Response, what: string): Promise<Error> {
	if (response.status === 429) return new WhoopRateLimitError();
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

function expiresSoon(tokens: WhoopTokens): boolean {
	return tokens.expires_at - Date.now() < REFRESH_MARGIN_MS;
}

/** The tokens alone, without the store's mark. */
function tokensOf(stored: StoredWhoopTokens | null): WhoopTokens | null {
	return stored && { access_token: stored.access_token, refresh_token: stored.refresh_token, expires_at: stored.expires_at };
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
	private readonly redirectUri: string;
	private readonly store: TokenStore;
	private readonly fetch: typeof fetch;
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

	constructor(config: WhoopClientConfig) {
		this.clientId = config.clientId;
		this.clientSecret = config.clientSecret;
		this.redirectUri = config.redirectUri;
		this.store = config.store;
		this.fetch = config.fetch ?? globalThis.fetch;
	}

	getAuthorizationUrl(scopes: string[], state: string): string {
		const params = new URLSearchParams({
			client_id: this.clientId,
			redirect_uri: this.redirectUri,
			response_type: 'code',
			scope: scopes.join(' '),
			state,
		});
		return `${WHOOP_AUTH_BASE}/auth?${params}`;
	}

	/** Exchanges the code from WHOOP's login for tokens, saves them and uses them from now on. */
	async exchangeCodeForTokens(code: string): Promise<void> {
		const tokens = await this.requestTokens({
			grant_type: 'authorization_code',
			code,
			redirect_uri: this.redirectUri,
		});
		// Under the lock, like every other write, so a refresh can't interleave with it.
		await this.underLock(async () => {
			await this.save(tokens);
			this.tokens = tokens;
		});
	}

	cycles(query?: Query): Promise<WhoopCycle[]> {
		return this.collection<WhoopCycle>('/v2/cycle', query);
	}

	recoveries(query?: Query): Promise<WhoopRecovery[]> {
		return this.collection<WhoopRecovery>('/v2/recovery', query);
	}

	sleeps(query?: Query): Promise<WhoopSleep[]> {
		return this.collection<WhoopSleep>('/v2/activity/sleep', query);
	}

	workouts(query?: Query): Promise<WhoopWorkout[]> {
		return this.collection<WhoopWorkout>('/v2/activity/workout', query);
	}

	private collection<T>(path: string, query: Query = {}): Promise<T[]> {
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
		try {
			await this.store.save(tokens);
		} catch {
			await this.store.save(tokens);
		}
		this.storedRefreshToken = tokens.refresh_token;
		this.unsaved = false;
	}

	/** Applies the refresh rules above. `rejected` is an access token WHOOP just refused. */
	private refresh(rejected?: string): Promise<void> {
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

			if (!this.tokens) throw new WhoopAuthError(NOT_CONNECTED);
			if (this.tokens.access_token !== rejected && !expiresSoon(this.tokens)) return;
			if (interrupted) throw new WhoopAuthError(REFRESH_INTERRUPTED);

			// If the mark can't be saved, WHOOP is never asked.
			const held = this.tokens;
			await this.save({ ...held, refresh_started_at: Date.now() });
			let fresh: WhoopTokens;
			try {
				fresh = await this.requestTokens({ grant_type: 'refresh_token', refresh_token: held.refresh_token });
			} catch (error) {
				// Refused: the authorization has ended.
				if (error instanceof WhoopAuthError) throw error;
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
				throw new WhoopAuthError(REFRESH_INTERRUPTED);
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
			return await this.fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
		} catch (error) {
			if (error instanceof Error && error.name === 'TimeoutError') {
				throw new WhoopUnavailableError(`WHOOP didn't answer within ${REQUEST_TIMEOUT_MS / 1000} seconds. Try again in a minute.`);
			}
			const cause = error instanceof Error ? error.cause as { code?: unknown; message?: unknown } | undefined : undefined;
			const reason = typeof cause?.message === 'string' ? cause.message : error instanceof Error ? error.message : String(error);
			throw new WhoopUnavailableError(`Couldn't reach WHOOP (${reason}). Try again in a minute.`, {
				reachedWhoop: !NOT_SENT.has(String(cause?.code)),
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
			if (error === 'invalid_grant' || error === undefined) throw new WhoopAuthError();
			// Refused before the token was looked at, such as for a wrong client secret.
			throw new WhoopRequestError(
				`WHOOP refused this server's app credentials (${error}). Check WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET.`,
				response.status,
			);
		}
		if (!response.ok) {
			throw await failure(response, 'the token endpoint');
		}

		const data = await response.json() as { access_token: string; refresh_token: string; expires_in: number };
		return {
			access_token: data.access_token,
			refresh_token: data.refresh_token,
			expires_at: Date.now() + data.expires_in * 1000,
		};
	}

	private async request<T>(path: string, params: Record<string, string>): Promise<T> {
		// Nothing held yet (first use, or not connected before): the store may have tokens now.
		if (!this.tokens) {
			const stored = await this.store.load();
			this.tokens = tokensOf(stored);
			this.storedRefreshToken = stored?.refresh_token ?? null;
		}
		if (!this.tokens) {
			throw new WhoopAuthError(NOT_CONNECTED);
		}

		if (this.unsaved || expiresSoon(this.tokens)) {
			try {
				await this.refresh();
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

		const sentToken = this.tokens.access_token;
		let response = await this.send(url, { headers: { Authorization: `Bearer ${sentToken}` } });

		if (response.status === 401) {
			// One refresh and one retry, never more. If another request already refreshed
			// while this one was in flight, the refresh rules retry with its token instead.
			await this.refresh(sentToken);
			response = await this.send(url, { headers: { Authorization: `Bearer ${this.tokens.access_token}` } });
			if (response.status === 401) {
				throw new WhoopAuthError();
			}
		}

		if (!response.ok) {
			throw await failure(response, `GET ${path}`);
		}

		return response.json() as Promise<T>;
	}

	private async fetchAll<T>(path: string, { start, end, limit }: Query): Promise<T[]> {
		const results: T[] = [];
		const seenCursors = new Set<string>();
		let nextToken: string | undefined;

		for (let page = 0; page < MAX_PAGES; page++) {
			const wanted = limit === undefined ? PAGE_SIZE : Math.min(PAGE_SIZE, limit - results.length);
			const params: Record<string, string> = { limit: String(wanted) };
			if (start) params.start = start;
			if (end) params.end = end;
			if (nextToken) params.nextToken = nextToken;

			const response = await this.request<WhoopPaginatedResponse<T>>(path, params);
			results.push(...response.records);
			nextToken = response.next_token;

			if (limit !== undefined && results.length >= limit) return results.slice(0, limit);
			if (!nextToken) return results;
			if (seenCursors.has(nextToken)) {
				throw new Error(`Whoop returned the same page cursor twice for ${path}; stopping.`);
			}
			seenCursors.add(nextToken);
		}

		throw new Error(`Whoop pagination for ${path} did not finish after ${MAX_PAGES} pages; stopping.`);
	}
}
