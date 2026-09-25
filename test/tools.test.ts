// A server clock west of UTC is where both date bugs showed: labels by UTC date, and
// formatting in the server's timezone. Set before anything formats a date.
process.env.TZ = 'America/Los_Angeles';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { WhoopCycle, WhoopWorkout } from '../src/types.js';
import { mcpRequest, readRpc, signIn, startTestServer, type TestServer } from './helpers.js';

const HOUR = 60 * 60 * 1000;

function utcMidnight(daysFromToday: number): number {
	const now = new Date();
	return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysFromToday);
}

function label(utcDay: number): string {
	return new Date(utcDay).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

async function callTool(server: TestServer, accessToken: string, name: string, args: object = {}): Promise<string> {
	const res = await mcpRequest(server.baseUrl, accessToken, { method: 'tools/call', params: { name, arguments: args } });
	const body = await readRpc<{ result: { content: { text: string }[] } }>(res);
	return body.result.content[0].text;
}

describe('data tools', () => {
	let server: TestServer;
	let accessToken: string;

	before(async () => {
		server = await startTestServer();
		accessToken = (await signIn(server.baseUrl)).tokens.access_token;
		server.db.saveTokens({ access_token: 'whoop-access', refresh_token: 'whoop-refresh', expires_at: Date.now() + HOUR });

		// Fell asleep at 23:30 yesterday in Singapore (15:30 UTC): that cycle is today.
		const cycle: WhoopCycle = {
			id: 1,
			user_id: 1,
			start: new Date(utcMidnight(-1) + 15.5 * HOUR).toISOString(),
			end: null,
			timezone_offset: '+08:00',
			score_state: 'SCORED',
			score: { strain: 9.5, kilojoule: 8368, average_heart_rate: 60, max_heart_rate: 150 },
		};
		// A 45-minute session at 18:00 yesterday, Singapore time.
		const workout: WhoopWorkout = {
			id: 'workout-1',
			user_id: 1,
			created_at: new Date(utcMidnight(-1) + 11 * HOUR).toISOString(),
			updated_at: new Date(utcMidnight(-1) + 11 * HOUR).toISOString(),
			start: new Date(utcMidnight(-1) + 10 * HOUR).toISOString(),
			end: new Date(utcMidnight(-1) + 10.75 * HOUR).toISOString(),
			timezone_offset: '+08:00',
			sport_id: 71,
			sport_name: 'functional-fitness',
			score_state: 'SCORED',
			score: {
				strain: 8.2,
				average_heart_rate: 135,
				max_heart_rate: 171,
				kilojoule: 2092,
				percent_recorded: 100,
				zone_durations: {
					zone_zero_milli: 0,
					zone_one_milli: 600_000,
					zone_two_milli: 900_000,
					zone_three_milli: 300_000,
					zone_four_milli: 600_000,
					zone_five_milli: 300_000,
				},
			},
		};
		server.db.upsertCycles([cycle]);
		server.db.upsertWorkouts([workout]);
	});

	after(async () => {
		await server.close();
	});

	it('dates strain by the local day you woke up into', async () => {
		const history = await callTool(server, accessToken, 'get_strain_history', { days: 14 });
		assert.match(history, new RegExp(`\\| ${label(utcMidnight(0))} \\| 9\\.5 \\|`));
		assert.doesNotMatch(history, new RegExp(label(utcMidnight(-1))), 'must not use the UTC date the cycle started');
	});

	it('lists workouts with activity, duration, strain and heart-rate zones', async () => {
		const workouts = await callTool(server, accessToken, 'get_workouts', { days: 7 });
		assert.match(workouts, new RegExp(`\\| ${label(utcMidnight(-1))} \\| Functional fitness \\| 0h 45m \\| 8\\.2 \\| 135 bpm \\| 171 bpm \\| 500 kcal \\|`));
		assert.match(workouts, /\*\*Workouts\*\*: 1/);
		assert.match(workouts, /zones 4–5\*\*: 0h 15m/);
	});

	it('asks Whoop only for the data the tools use', async () => {
		const reply = await callTool(server, accessToken, 'get_auth_url');
		const link = new URL(reply.match(/Visit: (\S+)/)?.[1] ?? '');
		assert.deepEqual(link.searchParams.get('scope')?.split(' '), ['read:cycles', 'read:recovery', 'read:sleep', 'read:workout', 'offline']);
	});
});
