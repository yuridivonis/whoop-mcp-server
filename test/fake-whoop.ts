import type { WhoopCycle, WhoopRecovery, WhoopSleep, WhoopWorkout } from '../src/types.js';

const API_PATH = '/developer';
const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';

/** Synthetic records, shaped like WHOOP API v2 responses. Never real data. */
export interface WhoopRecords {
	cycles: WhoopCycle[];
	recoveries: WhoopRecovery[];
	sleeps: WhoopSleep[];
	workouts: WhoopWorkout[];
}

// Each endpoint, the records it serves, and the time WHOOP filters and sorts them by.
const ENDPOINTS: Record<string, { records: keyof WhoopRecords; time: (record: never) => string }> = {
	'/v2/cycle': { records: 'cycles', time: (cycle: WhoopCycle) => cycle.start },
	'/v2/recovery': { records: 'recoveries', time: (recovery: WhoopRecovery) => recovery.created_at },
	'/v2/activity/sleep': { records: 'sleeps', time: (sleep: WhoopSleep) => sleep.start },
	'/v2/activity/workout': { records: 'workouts', time: (workout: WhoopWorkout) => workout.start },
};

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * A stand-in for the WHOOP API, for a WhoopClient's `fetch` option. It serves the records
 * the way WHOOP does: newest first, from `start` and before `end`, in pages of `limit`
 * with a next_token. Its token endpoint issues tokens for any code or refresh token.
 */
export class FakeWhoop {
	readonly records: WhoopRecords = { cycles: [], recoveries: [], sleeps: [], workouts: [] };
	/** Every API request, in order. */
	readonly requests: URL[] = [];
	/** The authorization codes exchanged at the token endpoint. */
	readonly exchangedCodes: string[] = [];
	/** When set, every API request fails with this HTTP status. */
	failWith?: number;
	/** When set, the token endpoint refuses the app's credentials with this HTTP status. */
	refuseClientWith?: number;
	/** How long each API request takes, so that requests made together overlap. */
	delayMs = 0;
	private issued = 0;

	readonly fetch: typeof fetch = async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : input);
		if (url.href === TOKEN_URL) {
			const form = new URLSearchParams(init?.body as URLSearchParams);
			if (form.get('grant_type') === 'authorization_code') this.exchangedCodes.push(form.get('code') ?? '');
			if (this.refuseClientWith) return json({ error: 'invalid_client' }, this.refuseClientWith);
			this.issued++;
			return json({ access_token: `whoop-access-${this.issued}`, refresh_token: `whoop-refresh-${this.issued}`, expires_in: 3600 });
		}

		this.requests.push(url);
		if (this.delayMs) await new Promise(resolve => setTimeout(resolve, this.delayMs));
		if (this.failWith) return json({ error: 'failed' }, this.failWith);

		const endpoint = ENDPOINTS[url.pathname.replace(API_PATH, '')];
		if (!endpoint) return json({ error: 'not found' }, 404);
		const time = endpoint.time as (record: unknown) => string;
		const start = url.searchParams.get('start');
		const end = url.searchParams.get('end');
		const limit = Number(url.searchParams.get('limit') ?? 10);
		const offset = Number(url.searchParams.get('nextToken') ?? 0);
		if (!(limit >= 1 && limit <= 25)) return json({ error: 'limit must be 1 to 25' }, 400);

		const matching = (this.records[endpoint.records] as unknown[])
			.filter(record => (!start || time(record) >= start) && (!end || time(record) < end))
			.sort((a, b) => Date.parse(time(b)) - Date.parse(time(a)));
		const page = matching.slice(offset, offset + limit);
		const more = offset + limit < matching.length;
		return json({ records: page, ...(more ? { next_token: String(offset + limit) } : {}) });
	};

	/** How many API requests went to one endpoint, such as "/v2/cycle". */
	count(path: string): number {
		return this.requests.filter(url => url.pathname.endsWith(path)).length;
	}
}
