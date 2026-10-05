import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WhoopCycle, WhoopRecovery, WhoopSleep, WhoopWorkout } from '@yuridivonis/whoop-client';
import { PASSWORD, startTestServer, type TestServer } from './helpers.js';

const SCRIPT = new URL('../scripts/live-check.mjs', import.meta.url).pathname;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** A night in Singapore `daysAgo` days back, with its cycle and recovery, and a morning run. */
function day(daysAgo: number): { cycle: WhoopCycle; sleep: WhoopSleep; recovery: WhoopRecovery; workout: WhoopWorkout } {
	const midnight = Math.floor(Date.now() / DAY) * DAY - daysAgo * DAY;
	const start = new Date(midnight - 9 * HOUR).toISOString(); // 23:00 the evening before, +08:00
	const end = new Date(midnight - 1 * HOUR).toISOString(); // 07:00
	const id = 500 + daysAgo;
	const stages = { total_in_bed_time_milli: 8 * HOUR, total_awake_time_milli: 30 * 60_000, total_no_data_time_milli: 0,
		total_light_sleep_time_milli: 4 * HOUR, total_slow_wave_sleep_time_milli: 1.5 * HOUR, total_rem_sleep_time_milli: 2 * HOUR, sleep_cycle_count: 5, disturbance_count: 3 };
	return {
		cycle: { id, user_id: 1, created_at: start, updated_at: end, start, end: daysAgo === 0 ? null : new Date(midnight + 15 * HOUR).toISOString(), timezone_offset: '+08:00',
			score_state: 'SCORED', score: { strain: 9.5 + daysAgo, kilojoule: 8000 + 100 * daysAgo, average_heart_rate: 62, max_heart_rate: 160 } },
		sleep: { id: `sleep-${id}`, cycle_id: id, user_id: 1, created_at: end, updated_at: end, start, end, timezone_offset: '+08:00', nap: false, score_state: 'SCORED',
			score: { stage_summary: stages, sleep_needed: { baseline_milli: 7.5 * HOUR, need_from_sleep_debt_milli: 20 * 60_000, need_from_recent_strain_milli: 5 * 60_000, need_from_recent_nap_milli: 0 },
				respiratory_rate: 14.2, sleep_performance_percentage: 88, sleep_consistency_percentage: 75, sleep_efficiency_percentage: 93 } },
		recovery: { cycle_id: id, sleep_id: `sleep-${id}`, user_id: 1, created_at: end, updated_at: end, score_state: 'SCORED',
			score: { user_calibrating: false, recovery_score: 40 + daysAgo, resting_heart_rate: 51, hrv_rmssd_milli: 58.4, spo2_percentage: 96.5, skin_temp_celsius: 33.1 } },
		workout: { id: `run-${id}`, v1_id: id, user_id: 1, created_at: end, updated_at: end, start: new Date(midnight).toISOString(), end: new Date(midnight + HOUR).toISOString(),
			timezone_offset: '+08:00', sport_name: 'running', score_state: 'SCORED',
			score: { strain: 10.1, average_heart_rate: 150, max_heart_rate: 178, kilojoule: 2500, percent_recorded: 0.99, distance_meter: 10_000, altitude_gain_meter: 50, altitude_change_meter: 0,
				zone_durations: { zone_zero_milli: 0, zone_one_milli: 5 * 60_000, zone_two_milli: 15 * 60_000, zone_three_milli: 25 * 60_000, zone_four_milli: 10 * 60_000, zone_five_milli: 5 * 60_000 } } },
	};
}

/** Runs the script in its own process (asynchronously: the test server answering it lives in this one). */
async function script(env: Record<string, string>): Promise<{ status: number; out: string }> {
	try {
		const { stdout, stderr } = await promisify(execFile)(process.execPath, [SCRIPT], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
		return { status: 0, out: stdout + stderr };
	} catch (error) {
		const failed = error as { code?: number; stdout?: string; stderr?: string };
		return { status: failed.code ?? -1, out: (failed.stdout ?? '') + (failed.stderr ?? '') };
	}
}

async function run(server: TestServer, env: Record<string, string>): Promise<{ status: number; out: string; report: string }> {
	const report = join(mkdtempSync(join(tmpdir(), 'live-check-')), 'report.md');
	const result = await script({ LIVE_CHECK_URL: server.baseUrl, LIVE_CHECK_PASSWORD: PASSWORD, LIVE_CHECK_REPORT: report, ...env });
	let written = '';
	try { written = readFileSync(report, 'utf8'); } catch { /* not written */ }
	return { ...result, report: written };
}

describe('the live check script', () => {
	let server: TestServer;
	let dbPath: string;

	before(async () => {
		dbPath = join(mkdtempSync(join(tmpdir(), 'live-check-db-')), 'whoop.db');
		server = await startTestServer({ dbPath });
		server.db.saveTokens({ access_token: 'whoop-access', refresh_token: 'whoop-refresh', expires_at: Date.now() + HOUR });
		for (let daysAgo = 0; daysAgo < 40; daysAgo++) {
			const { cycle, sleep, recovery, workout } = day(daysAgo);
			server.whoop.records.cycles.push(cycle);
			server.whoop.records.sleeps.push(sleep);
			server.whoop.records.recoveries.push(recovery);
			if (daysAgo % 3 === 0) server.whoop.records.workouts.push(workout);
		}
	});
	after(() => server.close());

	it('signs in like an MCP app, asks every question, applies the rules, and reports without the answers', async () => {
		const { status, out, report } = await run(server, {});
		assert.equal(status, 0, out);
		assert.match(report, /^## Live check, \d{4}-\d{2}-\d{2}/);
		assert.match(report, /Server version \d+\.\d+\.\d+\./, 'the version from initialize, matching this checkout');
		assert.match(report, /9 of 9 answers received; the rules pass on all of them\./);
		assert.match(report, /All clear\./);
		assert.doesNotMatch(out, /\| (Sun|Mon|Tue|Wed|Thu|Fri|Sat), /, 'no table row from an answer is printed');
		assert.doesNotMatch(out, /58\.4|96\.5|33\.1/, 'no value from an answer is printed');
		assert.equal(out.trim(), report.trim(), 'stdout is the report');
	});

	it('reports a server it cannot sign in to, without the password, and exits 2', async () => {
		const { status, out, report } = await run(server, { LIVE_CHECK_PASSWORD: 'not the password' });
		assert.equal(status, 2, out);
		assert.match(report, /the server could not be asked: sign-in answered \d+ without a code/);
		assert.doesNotMatch(out, /not the password/);
	});

	it('fails when the server is not connected to WHOOP, instead of passing empty answers', async t => {
		const disconnected = await startTestServer();
		t.after(() => disconnected.close());

		const { status, out, report } = await run(disconnected, {});
		assert.equal(status, 1, out);
		assert.equal(report.match(/: the server is not connected to WHOOP$/gm)?.length, 9, 'every question');
		assert.match(report, /0 of 9 answers received/);
		assert.doesNotMatch(report, /All clear/);
	});

	it('reports a tool error by the server\'s own first words only', async t => {
		const failing = await startTestServer();
		t.after(() => failing.close());
		failing.db.saveTokens({ access_token: 'whoop-access', refresh_token: 'whoop-refresh', expires_at: Date.now() + HOUR });
		failing.whoop.failWith = 503;

		const { status, out, report } = await run(failing, {});
		assert.equal(status, 1, out);
		assert.match(report, /- get_today: the tool answered an error: WHOOP is unavailable right now \(/, "the server's own first words");
		assert.doesNotMatch(out, /Error: Error|\. Try again/, 'not the word Error alone, and nothing past the first clause');
	});

	it('does nothing without a server to ask', async () => {
		const { status, out } = await script({});
		assert.equal(status, 0);
		assert.match(out, /nothing to check/);
	});
});
