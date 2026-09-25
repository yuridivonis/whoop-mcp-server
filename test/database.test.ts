import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { WhoopDatabase } from '../src/database.js';
import { memoryDb } from './helpers.js';
import type { WhoopWorkout } from '../src/types.js';

/** Shaped like the workout example in WHOOP's v2 API reference. */
function v2Workout(overrides: Partial<WhoopWorkout> = {}): WhoopWorkout {
	return {
		id: 'ecfc6a15-4661-442f-a9a4-f160dd7afae8',
		user_id: 9012,
		created_at: '2026-09-22T11:25:44.774Z',
		updated_at: '2026-09-22T14:25:44.774Z',
		start: '2026-09-22T02:25:44.774Z',
		end: '2026-09-22T03:25:44.774Z',
		timezone_offset: '-05:00',
		sport_id: 1,
		score_state: 'SCORED',
		score: {
			strain: 8.2463,
			average_heart_rate: 123,
			max_heart_rate: 146,
			kilojoule: 1569.34,
			percent_recorded: 100,
			zone_durations: {
				zone_zero_milli: 300000,
				zone_one_milli: 600000,
				zone_two_milli: 900000,
				zone_three_milli: 900000,
				zone_four_milli: 600000,
				zone_five_milli: 300000,
			},
		},
		...overrides,
	};
}

describe('stored workouts', () => {
	it('keep the sport name and timezone from API v2', t => {
		const db = memoryDb(t);
		db.upsertWorkouts([v2Workout({ sport_name: 'functional-fitness' })]);
		const [stored] = db.getWorkouts('2026-09-01');
		assert.equal(stored.sport_name, 'functional-fitness');
		assert.equal(stored.timezone_offset, '-05:00');
	});

	it('are added to a 1.0.0 database, which then re-syncs 90 days and dates every table locally', t => {
		const dir = mkdtempSync(join(tmpdir(), 'whoop-mcp-test-'));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		const path = join(dir, 'whoop.db');

		// The data tables exactly as 1.0.0 created them, each with a row and a recent sync.
		const old = new Database(path);
		old.exec(`
			CREATE TABLE sync_state (id INTEGER PRIMARY KEY CHECK (id = 1), last_sync_at TEXT, oldest_synced_date TEXT, newest_synced_date TEXT);
			INSERT INTO sync_state (id, last_sync_at) VALUES (1, CURRENT_TIMESTAMP);
			CREATE TABLE cycles (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, start_time TEXT NOT NULL, end_time TEXT,
				score_state TEXT NOT NULL, strain REAL, kilojoule REAL, avg_hr INTEGER, max_hr INTEGER, synced_at TEXT DEFAULT CURRENT_TIMESTAMP);
			INSERT INTO cycles (id, user_id, start_time, score_state, strain) VALUES (7, 1, '2026-01-01T15:00:00.000Z', 'SCORED', 5);
			CREATE TABLE recovery (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, sleep_id TEXT, created_at TEXT NOT NULL,
				score_state TEXT NOT NULL, recovery_score INTEGER, resting_hr INTEGER, hrv_rmssd REAL, spo2 REAL, skin_temp REAL,
				synced_at TEXT DEFAULT CURRENT_TIMESTAMP);
			CREATE TABLE sleep (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, cycle_id INTEGER, start_time TEXT NOT NULL,
				end_time TEXT NOT NULL, is_nap INTEGER NOT NULL DEFAULT 0, score_state TEXT NOT NULL, total_in_bed_milli INTEGER,
				total_awake_milli INTEGER, total_light_milli INTEGER, total_deep_milli INTEGER, total_rem_milli INTEGER,
				sleep_performance REAL, sleep_efficiency REAL, sleep_consistency REAL, respiratory_rate REAL,
				sleep_needed_baseline_milli INTEGER, sleep_needed_debt_milli INTEGER, sleep_needed_strain_milli INTEGER,
				synced_at TEXT DEFAULT CURRENT_TIMESTAMP);
			CREATE TABLE workouts (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, sport_id INTEGER NOT NULL,
				start_time TEXT NOT NULL, end_time TEXT NOT NULL, score_state TEXT NOT NULL, strain REAL, avg_hr INTEGER,
				max_hr INTEGER, kilojoule REAL, zone_zero_milli INTEGER, zone_one_milli INTEGER, zone_two_milli INTEGER,
				zone_three_milli INTEGER, zone_four_milli INTEGER, zone_five_milli INTEGER, synced_at TEXT DEFAULT CURRENT_TIMESTAMP);
		`);
		old.close();

		const db = new WhoopDatabase(path);
		t.after(() => db.close());

		assert.equal(db.getSyncState().lastSyncAt, null, 'the next sync should pull the full 90 days again');

		// Last night, 23:30 to 07:10 in Singapore: sleep, recovery and strain all belong to today.
		const now = new Date();
		const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
		const fellAsleep = new Date(today.getTime() - 8.5 * 60 * 60 * 1000).toISOString();
		const wokeUp = new Date(today.getTime() - 50 * 60 * 1000).toISOString();
		const expected = today.toISOString().slice(0, 10);

		db.upsertCycles([{ id: 8, user_id: 1, start: fellAsleep, end: null, timezone_offset: '+08:00', score_state: 'SCORED',
			score: { strain: 6, kilojoule: 8000, average_heart_rate: 60, max_heart_rate: 140 } }]);
		db.upsertSleeps([{ id: 'sleep-8', user_id: 1, created_at: wokeUp, updated_at: wokeUp, start: fellAsleep, end: wokeUp,
			timezone_offset: '+08:00', nap: false, score_state: 'SCORED', score: {
				stage_summary: { total_in_bed_time_milli: 27_600_000, total_awake_time_milli: 1_800_000, total_no_data_time_milli: 0,
					total_light_sleep_time_milli: 12_000_000, total_slow_wave_sleep_time_milli: 7_000_000, total_rem_sleep_time_milli: 6_800_000,
					sleep_cycle_count: 5, disturbance_count: 3 },
				sleep_needed: { baseline_milli: 27_000_000, need_from_sleep_debt_milli: 0, need_from_recent_strain_milli: 0, need_from_recent_nap_milli: 0 },
				respiratory_rate: 13, sleep_performance_percentage: 95, sleep_consistency_percentage: 80, sleep_efficiency_percentage: 92,
			} }]);
		db.upsertRecoveries([{ cycle_id: 8, sleep_id: 'sleep-8', user_id: 1, created_at: wokeUp, updated_at: wokeUp, score_state: 'SCORED',
			score: { user_calibrating: false, recovery_score: 85, resting_heart_rate: 50, hrv_rmssd_milli: 69 } }]);
		db.upsertWorkouts([v2Workout({ sport_name: 'running' })]);

		assert.equal(db.getStrainTrends(14)[0].date, expected);
		assert.equal(db.getSleepTrends(14)[0].date, expected);
		assert.equal(db.getRecoveryTrends(14)[0].date, expected);
		assert.equal(db.getWorkouts('2026-09-01')[0].sport_name, 'running');
		const reader = new Database(path, { readonly: true });
		const { count } = reader.prepare('SELECT COUNT(*) AS count FROM cycles').get() as { count: number };
		reader.close();
		assert.equal(count, 2, 'the row from 1.0.0 is kept');
	});

	it('does not re-sync a database that already has the newer columns', t => {
		const dir = mkdtempSync(join(tmpdir(), 'whoop-mcp-test-'));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		const path = join(dir, 'whoop.db');

		const first = new WhoopDatabase(path);
		first.updateSyncState('2026-09-01', '2026-09-25');
		first.close();

		const reopened = new WhoopDatabase(path);
		t.after(() => reopened.close());
		assert.notEqual(reopened.getSyncState().lastSyncAt, null);
	});

	it('keep the heart-rate zones from a v2 workout', t => {
		const db = memoryDb(t);
		db.upsertWorkouts([v2Workout()]);

		const [stored] = db.getWorkouts('2026-09-01');
		assert.equal(stored.zone_zero_milli, 300000);
		assert.equal(stored.zone_five_milli, 300000);
		assert.equal(stored.strain, 8.2463);
	});

	it('are stored even when WHOOP sends no zone data', t => {
		const db = memoryDb(t);
		const workout = v2Workout();
		delete workout.score?.zone_durations;
		db.upsertWorkouts([workout]);

		const [stored] = db.getWorkouts('2026-09-01');
		assert.equal(stored.zone_zero_milli, null);
		assert.equal(stored.strain, 8.2463);
	});
});

const originalSecret = process.env.ENCRYPTION_SECRET;

describe('stored WHOOP tokens', () => {
	afterEach(() => {
		process.env.ENCRYPTION_SECRET = originalSecret;
	});

	it('read as "not connected" instead of crashing after the encryption key changes', t => {
		t.mock.method(process.stderr, 'write', () => true); // the expected "could not be decrypted" warning
		const db = memoryDb(t);
		process.env.ENCRYPTION_SECRET = 'key-before-rotation';
		db.saveTokens({ access_token: 'access', refresh_token: 'refresh', expires_at: Date.now() + 3_600_000 });

		process.env.ENCRYPTION_SECRET = 'key-after-rotation';
		assert.equal(db.getTokens(), null);

		// Reconnecting stores fresh tokens under the new key.
		db.saveTokens({ access_token: 'new-access', refresh_token: 'new-refresh', expires_at: Date.now() + 3_600_000 });
		assert.equal(db.getTokens()?.access_token, 'new-access');
	});
});
