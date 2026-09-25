// A server clock west of UTC is where both date bugs showed: labels by UTC date, and
// formatting in the server's timezone. Set before anything formats a date.
process.env.TZ = 'America/Los_Angeles';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PendingAuthStates } from '../src/auth-states.js';
import { createMcpServer } from '../src/tools.js';
import type { WhoopSync } from '../src/sync.js';
import type { WhoopClient } from '../src/whoop-client.js';
import type { WhoopCycle, WhoopRecovery, WhoopSleep, WhoopWorkout } from '../src/types.js';
import { memoryDb, mcpRequest, readRpc, signIn, startTestServer, type TestServer } from './helpers.js';

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
		// The sleep that started that cycle, up at 07:00 today, and its recovery.
		const wokeUp = new Date(utcMidnight(-1) + 23 * HOUR).toISOString();
		const sleep: WhoopSleep = {
			id: 'sleep-1',
			user_id: 1,
			created_at: wokeUp,
			updated_at: wokeUp,
			start: cycle.start,
			end: wokeUp,
			timezone_offset: '+08:00',
			nap: false,
			score_state: 'SCORED',
			score: {
				stage_summary: {
					total_in_bed_time_milli: 27_000_000, total_awake_time_milli: 1_800_000, total_no_data_time_milli: 0,
					total_light_sleep_time_milli: 12_000_000, total_slow_wave_sleep_time_milli: 7_000_000,
					total_rem_sleep_time_milli: 6_200_000, sleep_cycle_count: 5, disturbance_count: 3,
				},
				sleep_needed: { baseline_milli: 27_000_000, need_from_sleep_debt_milli: 0, need_from_recent_strain_milli: 0, need_from_recent_nap_milli: 0 },
				respiratory_rate: 13.2,
				sleep_performance_percentage: 95,
				sleep_consistency_percentage: 80,
				sleep_efficiency_percentage: 92,
			},
		};
		const recovery: WhoopRecovery = {
			cycle_id: 1,
			sleep_id: 'sleep-1',
			user_id: 1,
			created_at: wokeUp,
			updated_at: wokeUp,
			score_state: 'SCORED',
			score: { user_calibrating: false, recovery_score: 85, resting_heart_rate: 50, hrv_rmssd_milli: 69.3 },
		};
		// A 45-minute session at 00:30 yesterday, Singapore time: still the day before in UTC.
		const workout: WhoopWorkout = {
			id: 'workout-1',
			user_id: 1,
			created_at: new Date(utcMidnight(-2) + 17.5 * HOUR).toISOString(),
			updated_at: new Date(utcMidnight(-2) + 17.5 * HOUR).toISOString(),
			start: new Date(utcMidnight(-2) + 16.5 * HOUR).toISOString(),
			end: new Date(utcMidnight(-2) + 17.25 * HOUR).toISOString(),
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
		// A walk Whoop hasn't scored yet.
		const pending: WhoopWorkout = {
			...workout,
			id: 'workout-2',
			start: new Date(utcMidnight(-1) + 2 * HOUR).toISOString(),
			end: new Date(utcMidnight(-1) + 2.5 * HOUR).toISOString(),
			sport_name: 'walking',
			score_state: 'PENDING_SCORE',
			score: undefined,
		};
		server.db.upsertCycles([cycle]);
		server.db.upsertSleeps([sleep]);
		server.db.upsertRecoveries([recovery]);
		server.db.upsertWorkouts([workout, pending]);
	});

	after(async () => {
		await server.close();
	});

	it('dates the night\'s strain, sleep and recovery by the local day you woke up into', async () => {
		const today = label(utcMidnight(0));
		const nightBefore = new RegExp(label(utcMidnight(-1)));

		const strain = await callTool(server, accessToken, 'get_strain_history', { days: 14 });
		assert.match(strain, new RegExp(`\\| ${today} \\| 9\\.5 \\|`));
		assert.doesNotMatch(strain, nightBefore, 'must not use the UTC date the cycle started');

		const sleep = await callTool(server, accessToken, 'get_sleep_analysis', { days: 14 });
		assert.match(sleep, new RegExp(`\\| ${today} \\| 7\\.0h \\| 95% \\| 92% \\|`));

		const recovery = await callTool(server, accessToken, 'get_recovery_trends', { days: 14 });
		assert.match(recovery, new RegExp(`\\| ${today} \\| 85% \\| 69\\.3 ms \\| 50 bpm \\|`));
	});

	it('lists workouts with local date and time, activity, strain and time in zones 4–5', async () => {
		const workouts = await callTool(server, accessToken, 'get_workouts', { days: 7 });
		assert.match(workouts, new RegExp(`\\| ${label(utcMidnight(-1))} \\| 00:30 \\| Functional fitness \\| 0h 45m \\| 8\\.2 \\| 135 bpm \\| 171 bpm \\| 0h 15m \\| 500 kcal \\|`));
		assert.doesNotMatch(workouts, new RegExp(label(utcMidnight(-2))), 'must not use the UTC date');
		assert.match(workouts, /\| Walking \| 0h 30m \| unscored \|/);
		assert.match(workouts, /\*\*Workouts\*\*: 2/);
		assert.match(workouts, /\*\*Average Strain\*\*: 8\.2/, 'unscored workouts are left out of the average');
		assert.match(workouts, /zones 4–5\*\*: 0h 15m/);
	});

	it('asks Whoop only for the data the tools use', async () => {
		const reply = await callTool(server, accessToken, 'get_auth_url');
		const link = new URL(reply.match(/Visit: (\S+)/)?.[1] ?? '');
		assert.deepEqual(link.searchParams.get('scope')?.split(' '), ['read:cycles', 'read:recovery', 'read:sleep', 'read:workout', 'offline']);
	});
});

describe('stdio mode', () => {
	it('explains how to connect Whoop instead of issuing a link it can\'t receive', async t => {
		const server = createMcpServer({
			db: memoryDb(t),
			client: {} as WhoopClient,
			sync: {} as WhoopSync,
			authStates: new PendingAuthStates(),
			redirectUri: 'http://localhost:3000/callback',
			mode: 'stdio',
		});
		const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
		await server.connect(serverSide);
		const client = new Client({ name: 'test', version: '0' });
		await client.connect(clientSide);
		t.after(() => client.close());

		const result = await client.callTool({ name: 'get_auth_url', arguments: {} });
		assert.match(JSON.stringify(result.content), /running the server in http mode/);
		assert.doesNotMatch(JSON.stringify(result.content), /Visit:/);
	});
});
