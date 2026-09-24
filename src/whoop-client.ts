import type {
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
// A 90-day sync needs a handful of pages per data type. Reaching this cap means the
// cursor is stuck, and following it further would only hammer the WHOOP API.
const MAX_PAGES = 100;

interface WhoopClientConfig {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	onTokenRefresh?: (tokens: WhoopTokens) => void;
}

interface DateRange {
	start?: string;
	end?: string;
}

/** WHOOP rejected the stored tokens; the user has to authorize again. */
export class WhoopAuthError extends Error {
	constructor(message = 'Whoop authorization expired. Use the get_auth_url tool to reconnect.') {
		super(message);
		this.name = 'WhoopAuthError';
	}
}

export class WhoopClient {
	private tokens: WhoopTokens | null = null;
	private readonly clientId: string;
	private readonly clientSecret: string;
	private readonly redirectUri: string;
	private readonly onTokenRefresh?: (tokens: WhoopTokens) => void;
	/**
	 * WHOOP rotates the refresh token on every refresh, so presenting one twice fails and
	 * logs the user out. A sync fires four requests in parallel; this makes them share a
	 * single refresh instead of each starting their own.
	 */
	private refreshInFlight: Promise<void> | null = null;

	constructor(config: WhoopClientConfig) {
		this.clientId = config.clientId;
		this.clientSecret = config.clientSecret;
		this.redirectUri = config.redirectUri;
		this.onTokenRefresh = config.onTokenRefresh;
	}

	setTokens(tokens: WhoopTokens): void {
		this.tokens = tokens;
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

	async exchangeCodeForTokens(code: string): Promise<WhoopTokens> {
		this.tokens = await this.requestTokens({
			grant_type: 'authorization_code',
			code,
			redirect_uri: this.redirectUri,
		});
		return this.tokens;
	}

	private refreshTokens(): Promise<void> {
		this.refreshInFlight ??= this.doRefreshTokens().finally(() => {
			this.refreshInFlight = null;
		});
		return this.refreshInFlight;
	}

	private async doRefreshTokens(): Promise<void> {
		if (!this.tokens?.refresh_token) {
			throw new WhoopAuthError();
		}

		this.tokens = await this.requestTokens({
			grant_type: 'refresh_token',
			refresh_token: this.tokens.refresh_token,
		});
		this.onTokenRefresh?.(this.tokens);
	}

	private async requestTokens(grant: Record<string, string>): Promise<WhoopTokens> {
		const response = await fetch(`${WHOOP_AUTH_BASE}/token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ ...grant, client_id: this.clientId, client_secret: this.clientSecret }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});

		if (!response.ok) {
			throw new Error(`Whoop token request failed: ${response.status} ${await response.text()}`);
		}

		const data = await response.json() as { access_token: string; refresh_token: string; expires_in: number };
		return {
			access_token: data.access_token,
			refresh_token: data.refresh_token,
			expires_at: Date.now() + data.expires_in * 1000,
		};
	}

	private async request<T>(path: string, params?: Record<string, string>): Promise<T> {
		if (!this.tokens) {
			throw new WhoopAuthError('Not authenticated with Whoop. Use the get_auth_url tool to connect.');
		}

		if (this.tokens.expires_at - Date.now() < 5 * 60 * 1000) {
			try {
				await this.refreshTokens();
			} catch {
				// The current token may still be accepted; a 401 below retries the refresh.
			}
		}

		const url = new URL(`${WHOOP_API_BASE}${path}`);
		if (params) {
			for (const [key, value] of Object.entries(params)) {
				url.searchParams.set(key, value);
			}
		}

		const sentToken = this.tokens.access_token;
		let response = await this.fetchWithToken(url);

		if (response.status === 401) {
			// One refresh and one retry, never more. If a parallel request already refreshed
			// while this one was in flight, retry with its token instead of rotating again.
			if (this.tokens.access_token === sentToken) {
				try {
					await this.refreshTokens();
				} catch {
					throw new WhoopAuthError();
				}
			}
			response = await this.fetchWithToken(url);
			if (response.status === 401) {
				throw new WhoopAuthError();
			}
		}

		if (response.status === 429) {
			throw new Error('Whoop rate limit reached. Try again in a minute.');
		}

		if (!response.ok) {
			throw new Error(`Whoop API request failed: ${response.status} ${await response.text()}`);
		}

		return response.json() as Promise<T>;
	}

	private fetchWithToken(url: URL): Promise<Response> {
		return fetch(url, {
			headers: { Authorization: `Bearer ${this.tokens?.access_token}` },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	}

	private async fetchAll<T>(path: string, range: DateRange = {}): Promise<T[]> {
		const results: T[] = [];
		const seenCursors = new Set<string>();
		let nextToken: string | undefined;

		for (let page = 0; page < MAX_PAGES; page++) {
			const params: Record<string, string> = { limit: String(PAGE_SIZE) };
			if (range.start) params.start = range.start;
			if (range.end) params.end = range.end;
			if (nextToken) params.nextToken = nextToken;

			const response = await this.request<WhoopPaginatedResponse<T>>(path, params);
			results.push(...response.records);
			nextToken = response.next_token;

			if (!nextToken) return results;
			if (seenCursors.has(nextToken)) {
				throw new Error(`Whoop returned the same page cursor twice for ${path}; stopping.`);
			}
			seenCursors.add(nextToken);
		}

		throw new Error(`Whoop pagination for ${path} did not finish after ${MAX_PAGES} pages; stopping.`);
	}

	async getAllCycles(range?: DateRange): Promise<WhoopCycle[]> {
		return this.fetchAll<WhoopCycle>('/v2/cycle', range);
	}

	async getAllRecoveries(range?: DateRange): Promise<WhoopRecovery[]> {
		return this.fetchAll<WhoopRecovery>('/v2/recovery', range);
	}

	async getAllSleeps(range?: DateRange): Promise<WhoopSleep[]> {
		return this.fetchAll<WhoopSleep>('/v2/activity/sleep', range);
	}

	async getAllWorkouts(range?: DateRange): Promise<WhoopWorkout[]> {
		return this.fetchAll<WhoopWorkout>('/v2/activity/workout', range);
	}
}
