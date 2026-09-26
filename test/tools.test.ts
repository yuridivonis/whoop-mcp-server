// A server clock west of UTC is where both date bugs showed: labels by UTC date, and
// formatting in the server's timezone. Set before anything formats a date.
process.env.TZ = 'America/Los_Angeles';

import { after, before, describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PendingAuthStates } from '../src/auth-states.js';
import { createMcpServer } from '../src/tools.js';
import { WhoopClient } from '../src/whoop-client.js';
import type { WhoopCycle, WhoopRecovery, WhoopSleep, WhoopWorkout } from '../src/types.js';
import { FakeWhoop } from './fake-whoop.js';
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

interface Connected {
	client: Client;
	whoop: FakeWhoop;
	/** Calls a tool and returns its text, and whether it's marked as an error. */
	call(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

/** An MCP client connected to the tools, with a fake WHOOP behind them. */
async function connect(t: TestContext, { connected = true, mode = 'http' }: { connected?: boolean; mode?: 'http' | 'stdio' } = {}): Promise<Connected> {
	const db = memoryDb(t);
	if (connected) db.saveTokens({ access_token: 'whoop-access', refresh_token: 'whoop-refresh', expires_at: Date.now() + HOUR });
	const whoop = new FakeWhoop();
	const server = createMcpServer({
		client: new WhoopClient({ clientId: 'id', clientSecret: 'secret', redirectUri: 'http://localhost:3000/callback', store: db.whoopTokens, fetch: whoop.fetch }),
		authStates: new PendingAuthStates(),
		redirectUri: 'http://localhost:3000/callback',
		mode,
	});
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await server.connect(serverSide);
	const client = new Client({ name: 'test', version: '0' });
	await client.connect(clientSide);
	t.after(() => client.close());
	return {
		client,
		whoop,
		call: async (name, args = {}) => {
			const result = await client.callTool({ name, arguments: args });
			return { text: (result.content as { text: string }[])[0].text, isError: result.isError === true };
		},
	};
}

describe('data tools', () => {
	let server: TestServer;
	let accessToken: string;

	before(async () => {
		server = await startTestServer();
		accessToken = (await signIn(server.baseUrl)).tokens.access_token;
		server.db.saveTokens({ access_token: 'whoop-access', refresh_token: 'whoop-refresh', expires_at: Date.now() + HOUR });

		// Synthetic records, as WHOOP would return them. Fell asleep at 23:30 yesterday in Singapore (15:30 UTC): that cycle is today.
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
				// 7 hours asleep in 7h 50m in bed: 30 minutes awake, and 20 minutes the strap recorded no data.
				stage_summary: {
					total_in_bed_time_milli: 28_200_000, total_awake_time_milli: 1_800_000, total_no_data_time_milli: 1_200_000,
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
		server.whoop.records.cycles.push(cycle);
		server.whoop.records.sleeps.push(sleep);
		server.whoop.records.recoveries.push(recovery);
		server.whoop.records.workouts.push(workout, pending);
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

	it('counts time asleep, not the time the strap recorded no data', async () => {
		const today = await callTool(server, accessToken, 'get_today');
		assert.match(today, /\*\*Total Sleep\*\*: 7h 0m/);

		const sleep = await callTool(server, accessToken, 'get_sleep_analysis', { days: 14 });
		assert.match(sleep, /\| 7\.0h \|/);
		assert.match(sleep, /\*\*Duration\*\*: 7\.0 hours/);
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

describe('tool definitions', () => {
	it('give each tool a title, guidance on when to use it, and honest annotations', async t => {
		const { tools } = await (await connect(t)).client.listTools();
		const names = tools.map(tool => tool.name);
		assert.equal(tools.length, 6);

		for (const tool of tools) {
			assert.ok(tool.title, `${tool.name} has a title`);
			assert.ok((tool.description ?? '').length > 250, `${tool.name} explains what it returns and when to use it`);
			assert.ok(
				names.some(other => other !== tool.name && tool.description?.includes(other)),
				`${tool.name} points to a sibling tool`,
			);
			assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', `${tool.name} says whether it changes anything`);
			const days = tool.inputSchema.properties?.days as Record<string, unknown> | undefined;
			if (days) {
				assert.deepEqual(
					{ type: days.type, minimum: days.minimum, maximum: days.maximum, default: days.default },
					{ type: 'integer', minimum: 1, maximum: 90, default: 14 },
					`${tool.name} states the days limits`,
				);
				assert.match(tool.description ?? '', /7 for the last week/, `${tool.name} says how to choose days`);
			}
		}

		for (const name of ['get_today', 'get_recovery_trends', 'get_sleep_analysis', 'get_strain_history', 'get_workouts']) {
			const description = tools.find(tool => tool.name === name)?.description ?? '';
			assert.match(description, /live from WHOOP on every call and keeps no copy/, `${name} says it fetches live`);
			assert.match(description, /get_auth_url/, `${name} says what to do when WHOOP isn't connected`);
		}

		const readOnly = tools.filter(tool => tool.annotations?.readOnlyHint).map(tool => tool.name).sort();
		assert.deepEqual(readOnly, ['get_auth_url', 'get_recovery_trends', 'get_sleep_analysis', 'get_strain_history', 'get_today', 'get_workouts']);
	});

	it('still clamps days on the server, whatever a client sends', async t => {
		const { call } = await connect(t);
		const reply = async (days: unknown) => (await call('get_workouts', { days })).text;

		assert.match(await reply(0), /last 14 days/);
		assert.match(await reply(91), /last 90 days/);
		assert.match(await reply('7'), /last 7 days/);
	});

	it('tells clients how the tools fit together when they connect', async t => {
		const instructions = (await connect(t)).client.getInstructions() ?? '';
		assert.match(instructions, /get_today/);
		assert.match(instructions, /get_auth_url/);
		assert.match(instructions, /live from WHOOP/);
		assert.doesNotMatch(instructions, /sync_data/);
	});
});

describe('time asleep', () => {
	it('shows N/A rather than a partial total when a sleep stage is missing', async t => {
		const { whoop, call } = await connect(t, { mode: 'stdio' });
		const fellAsleep = new Date(utcMidnight(-1) + 15.5 * HOUR).toISOString();
		const wokeUp = new Date(utcMidnight(-1) + 23 * HOUR).toISOString();
		// Whoop left out the REM stage.
		whoop.records.sleeps.push({
			id: 'sleep-partial', user_id: 1, created_at: wokeUp, updated_at: wokeUp, start: fellAsleep, end: wokeUp,
			timezone_offset: '+08:00', nap: false, score_state: 'SCORED',
			score: {
				stage_summary: {
					total_in_bed_time_milli: 27_000_000, total_awake_time_milli: 1_800_000, total_no_data_time_milli: 0,
					total_light_sleep_time_milli: 12_000_000, total_slow_wave_sleep_time_milli: 7_000_000,
				},
				sleep_performance_percentage: 95,
			},
		} as unknown as WhoopSleep);

		assert.match((await call('get_today')).text, /\*\*Total Sleep\*\*: N\/A/);
		assert.match((await call('get_sleep_analysis', { days: 7 })).text, /\| N\/Ah \| 95% \|/);
	});
});

describe('stdio mode', () => {
	it('explains how to connect Whoop instead of issuing a link it can\'t receive', async t => {
		const { call } = await connect(t, { mode: 'stdio' });
		const { text } = await call('get_auth_url');
		assert.match(text, /running the server in http mode/);
		assert.doesNotMatch(text, /Visit:/);
	});
});

/** A synthetic night and its recovery, dated `daysAgo` days back: asleep 23:00–07:00 in Singapore. */
function night(daysAgo: number, recoveryScore: number): { cycle: WhoopCycle; sleep: WhoopSleep; recovery: WhoopRecovery } {
	const start = new Date(utcMidnight(-daysAgo - 1) + 15 * HOUR).toISOString();
	const end = new Date(utcMidnight(-daysAgo - 1) + 23 * HOUR).toISOString();
	const id = 100 + daysAgo;
	return {
		cycle: { id, user_id: 1, start, end: null, timezone_offset: '+08:00', score_state: 'SCORED',
			score: { strain: 10, kilojoule: 8000, average_heart_rate: 60, max_heart_rate: 150 } },
		sleep: { id: `sleep-${id}`, user_id: 1, created_at: end, updated_at: end, start, end, timezone_offset: '+08:00', nap: false,
			score_state: 'SCORED', score: {
				stage_summary: { total_in_bed_time_milli: 28_800_000, total_awake_time_milli: 1_800_000, total_no_data_time_milli: 0,
					total_light_sleep_time_milli: 14_000_000, total_slow_wave_sleep_time_milli: 6_000_000, total_rem_sleep_time_milli: 7_000_000,
					sleep_cycle_count: 5, disturbance_count: 2 },
				sleep_needed: { baseline_milli: 27_000_000, need_from_sleep_debt_milli: 0, need_from_recent_strain_milli: 0, need_from_recent_nap_milli: 0 },
				respiratory_rate: 14, sleep_performance_percentage: 90, sleep_consistency_percentage: 80, sleep_efficiency_percentage: 94,
			} },
		recovery: { cycle_id: id, sleep_id: `sleep-${id}`, user_id: 1, created_at: end, updated_at: end, score_state: 'SCORED',
			score: { user_calibrating: false, recovery_score: recoveryScore, resting_heart_rate: 52, hrv_rmssd_milli: 60 } },
	};
}

function addNights(whoop: FakeWhoop, nights: ReturnType<typeof night>[]): void {
	for (const { cycle, sleep, recovery } of nights) {
		whoop.records.cycles.push(cycle);
		whoop.records.sleeps.push(sleep);
		whoop.records.recoveries.push(recovery);
	}
}

describe('live data', () => {
	it('answers from WHOOP on every call, so a change at WHOOP shows up at once', async t => {
		const { whoop, call } = await connect(t);
		const today = night(0, 85);
		addNights(whoop, [today]);
		assert.match((await call('get_today')).text, /## Recovery: 85%/);

		// WHOOP rescored the recovery. Nothing was kept from the last call, so it shows.
		today.recovery.score!.recovery_score = 40;
		assert.match((await call('get_today')).text, /## Recovery: 40%/);
		assert.equal(whoop.count('/v2/recovery'), 2);
	});

	it('shows the latest recovery, sleep and strain even when they are weeks old', async t => {
		const { whoop, call } = await connect(t);
		addNights(whoop, [night(30, 55), night(31, 60)]);
		const { text } = await call('get_today');
		assert.match(text, /## Recovery: 55%/);
		assert.match(text, /\*\*Total Sleep\*\*: 7h 30m/);
		assert.match(text, /\*\*Day Strain\*\*: 10\.0/);
	});

	it("skips naps for last night's sleep", async t => {
		const { whoop, call } = await connect(t);
		const { sleep } = night(0, 70);
		const nap: WhoopSleep = { ...sleep, id: 'nap', nap: true, start: new Date(Date.parse(sleep.end) + 6 * HOUR).toISOString(),
			end: new Date(Date.parse(sleep.end) + 7 * HOUR).toISOString(),
			score: { ...sleep.score!, stage_summary: { ...sleep.score!.stage_summary, total_light_sleep_time_milli: 1_800_000,
				total_slow_wave_sleep_time_milli: 0, total_rem_sleep_time_milli: 0 } } };
		whoop.records.sleeps.push(sleep, nap);
		assert.match((await call('get_today')).text, /\*\*Total Sleep\*\*: 7h 30m/);
	});

	it('covers exactly the days asked for, reading every page WHOOP returns', async t => {
		const { whoop, call } = await connect(t);
		addNights(whoop, Array.from({ length: 40 }, (_, daysAgo) => night(daysAgo, 50 + (daysAgo % 40))));

		const month = (await call('get_recovery_trends', { days: 30 })).text;
		assert.equal(month.match(/^\| (?!Date|-)/gm)?.length, 30, 'the 30 days up to today');
		assert.ok(whoop.count('/v2/recovery') >= 2, 'more than one page of 25');

		const week = (await call('get_sleep_analysis', { days: 7 })).text;
		assert.equal(week.match(/^\| (?!Date|-)/gm)?.length, 7);
	});

	it("dates a recovery by its cycle's day even when the cycle began the day before the period", async t => {
		const { whoop, call } = await connect(t);
		// A night shift in Hawaii: asleep 10:00 to 18:00 local time, which ends after midnight UTC.
		const { cycle, sleep, recovery } = night(0, 64);
		cycle.start = sleep.start = new Date(utcMidnight(-8) + 20 * HOUR).toISOString();
		recovery.created_at = sleep.end = new Date(utcMidnight(-7) + 4 * HOUR).toISOString();
		cycle.timezone_offset = sleep.timezone_offset = '-10:00';
		addNights(whoop, [{ cycle, sleep, recovery }]);

		const week = (await call('get_recovery_trends', { days: 7 })).text;
		assert.match(week, new RegExp(`\\| ${label(utcMidnight(-8))} \\| 64% \\|`), 'the local day the shift worker woke up');
	});

	it('shares one request between tools that need the same data at the same moment', async t => {
		const { whoop, call } = await connect(t);
		addNights(whoop, [night(0, 80), night(1, 70)]);
		whoop.delayMs = 20;

		const [recovery, strain] = await Promise.all([
			call('get_recovery_trends', { days: 14 }),
			call('get_strain_history', { days: 14 }),
		]);
		assert.match(recovery.text, /\| 80% \|/);
		assert.match(strain.text, /\| 10\.0 \|/);
		assert.equal(whoop.count('/v2/cycle'), 1, 'both need cycles for the same days');

		// Nothing is kept once the request is done: the next call asks WHOOP again.
		await call('get_strain_history', { days: 14 });
		assert.equal(whoop.count('/v2/cycle'), 2);
	});

	it("asks to connect WHOOP, without calling WHOOP, when it isn't connected", async t => {
		const { whoop, call } = await connect(t, { connected: false });
		const reply = await call('get_recovery_trends');
		assert.match(reply.text, /Not authenticated with Whoop\. Use the get_auth_url tool/);
		assert.equal(reply.isError, false, 'guidance for the agent, not a failure');
		assert.equal(whoop.requests.length, 0);
	});

	it('says WHOOP is unavailable instead of showing older data, and logs it', async t => {
		const logged: string[] = [];
		t.mock.method(process.stderr, 'write', (chunk: string) => {
			logged.push(chunk);
			return true;
		});
		const { whoop, call } = await connect(t);
		addNights(whoop, [night(0, 85)]);
		whoop.failWith = 503;

		const reply = await call('get_today');
		assert.equal(reply.isError, true);
		assert.match(reply.text, /WHOOP is unavailable right now/);
		assert.doesNotMatch(reply.text, /85%/);
		assert.ok(logged.some(line => /^get_today failed: WHOOP is unavailable/.test(line)), 'the operator can see it in the log');
	});
});

describe('the database', () => {
	it('never holds the WHOOP data the tools answer with', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'whoop-mcp-test-'));
		const dbPath = join(dir, 'whoop.db');
		const server = await startTestServer({ dbPath });
		try {
			const { tokens } = await signIn(server.baseUrl);
			server.db.saveTokens({ access_token: 'whoop-access', refresh_token: 'whoop-refresh', expires_at: Date.now() + HOUR });
			const { cycle, sleep, recovery } = night(0, 77);
			sleep.id = 'synthetic-sleep-6f1c0a93';
			server.whoop.records.cycles.push(cycle);
			server.whoop.records.sleeps.push(sleep);
			server.whoop.records.recoveries.push(recovery);

			for (const name of ['get_today', 'get_recovery_trends', 'get_sleep_analysis', 'get_strain_history', 'get_workouts']) {
				await callTool(server, tokens.access_token, name);
			}
			assert.match(await callTool(server, tokens.access_token, 'get_today'), /## Recovery: 77%/);

			for (const file of [dbPath, `${dbPath}-wal`]) {
				if (existsSync(file)) {
					assert.ok(!readFileSync(file).includes('synthetic-sleep-6f1c0a93'), `${file} has no WHOOP record in it`);
				}
			}
		} finally {
			await server.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
