import { afterEach, describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { encrypt } from '../src/crypto.js';
import { WhoopDatabase } from '../src/database.js';
import { memoryDb } from './helpers.js';

// The tables 1.2.0 created, the last version that kept a copy of the WHOOP data.
const SCHEMA_1_2_0 = `
	CREATE TABLE tokens (id INTEGER PRIMARY KEY CHECK (id = 1), access_token TEXT NOT NULL, refresh_token TEXT NOT NULL,
		expires_at INTEGER NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
	CREATE TABLE sync_state (id INTEGER PRIMARY KEY CHECK (id = 1), last_sync_at TEXT, oldest_synced_date TEXT, newest_synced_date TEXT);
	CREATE TABLE cycles (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, start_time TEXT NOT NULL, end_time TEXT,
		score_state TEXT NOT NULL, strain REAL, kilojoule REAL, avg_hr INTEGER, max_hr INTEGER, timezone_offset TEXT,
		synced_at TEXT DEFAULT CURRENT_TIMESTAMP);
	CREATE TABLE recovery (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, sleep_id TEXT, created_at TEXT NOT NULL,
		score_state TEXT NOT NULL, recovery_score INTEGER, resting_hr INTEGER, hrv_rmssd REAL, spo2 REAL, skin_temp REAL,
		synced_at TEXT DEFAULT CURRENT_TIMESTAMP);
	CREATE TABLE sleep (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, cycle_id INTEGER, start_time TEXT NOT NULL,
		end_time TEXT NOT NULL, is_nap INTEGER NOT NULL DEFAULT 0, score_state TEXT NOT NULL, total_in_bed_milli INTEGER,
		total_awake_milli INTEGER, total_light_milli INTEGER, total_deep_milli INTEGER, total_rem_milli INTEGER,
		sleep_performance REAL, sleep_efficiency REAL, sleep_consistency REAL, respiratory_rate REAL,
		sleep_needed_baseline_milli INTEGER, sleep_needed_debt_milli INTEGER, sleep_needed_strain_milli INTEGER,
		timezone_offset TEXT, synced_at TEXT DEFAULT CURRENT_TIMESTAMP);
	CREATE TABLE workouts (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, sport_id INTEGER NOT NULL, sport_name TEXT,
		timezone_offset TEXT, start_time TEXT NOT NULL, end_time TEXT NOT NULL, score_state TEXT NOT NULL, strain REAL,
		avg_hr INTEGER, max_hr INTEGER, kilojoule REAL, zone_zero_milli INTEGER, zone_one_milli INTEGER, zone_two_milli INTEGER,
		zone_three_milli INTEGER, zone_four_milli INTEGER, zone_five_milli INTEGER, synced_at TEXT DEFAULT CURRENT_TIMESTAMP);
	CREATE TABLE oauth_clients (client_id TEXT PRIMARY KEY, client_info TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
	CREATE TABLE oauth_codes (code_hash TEXT PRIMARY KEY, family_id TEXT NOT NULL, generation TEXT NOT NULL, client_id TEXT NOT NULL,
		code_challenge TEXT NOT NULL, redirect_uri TEXT NOT NULL, scopes TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER);
	CREATE TABLE oauth_tokens (token_hash TEXT PRIMARY KEY, family_id TEXT NOT NULL, generation TEXT NOT NULL,
		kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')), client_id TEXT NOT NULL, scopes TEXT NOT NULL,
		expires_at INTEGER NOT NULL, consumed_at INTEGER);
	CREATE INDEX idx_oauth_tokens_family ON oauth_tokens(family_id);
	CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	CREATE INDEX idx_cycles_start ON cycles(start_time);
	CREATE INDEX idx_recovery_created ON recovery(created_at);
	CREATE INDEX idx_sleep_start ON sleep(start_time);
	CREATE INDEX idx_workouts_start ON workouts(start_time);
	INSERT INTO sync_state (id, last_sync_at) VALUES (1, CURRENT_TIMESTAMP);
`;

// Synthetic values that would stand out in the file if any of the stored data were left.
const MARKER = 'synthetic-record-4be2d7c1';

function tempPath(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), 'whoop-mcp-test-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return join(dir, 'whoop.db');
}

describe('upgrading from a version that stored WHOOP data', () => {
	it('deletes the data, from the file too, and keeps the WHOOP connection and sign-ins', t => {
		const logged: string[] = [];
		t.mock.method(process.stderr, 'write', (chunk: string) => {
			logged.push(chunk);
			return true;
		});
		const path = tempPath(t);

		const old = new Database(path);
		old.pragma('journal_mode = WAL');
		old.exec(SCHEMA_1_2_0);
		const insert = old.transaction(() => {
			for (let day = 0; day < 90; day++) {
				const start = new Date(Date.UTC(2026, 6, 1 + day, 15)).toISOString();
				old.prepare('INSERT INTO cycles (id, user_id, start_time, score_state, strain, timezone_offset) VALUES (?, 1, ?, ?, 9.5, ?)')
					.run(day, start, 'SCORED', '+08:00');
				old.prepare('INSERT INTO recovery (id, user_id, sleep_id, created_at, score_state, recovery_score) VALUES (?, 1, ?, ?, ?, 85)')
					.run(day, `${MARKER}-sleep-${day}`, start, 'SCORED');
				old.prepare('INSERT INTO sleep (id, user_id, start_time, end_time, score_state) VALUES (?, 1, ?, ?, ?)')
					.run(`${MARKER}-sleep-${day}`, start, start, 'SCORED');
				old.prepare('INSERT INTO workouts (id, user_id, sport_id, sport_name, start_time, end_time, score_state) VALUES (?, 1, 1, ?, ?, ?, ?)')
					.run(`workout-${day}`, `${MARKER}-sport`, start, start, 'SCORED');
			}
		});
		insert();
		old.prepare('INSERT INTO tokens (id, access_token, refresh_token, expires_at) VALUES (1, ?, ?, ?)')
			.run(encrypt('whoop-access'), encrypt('whoop-refresh'), 1_900_000_000_000);
		old.prepare('INSERT INTO oauth_clients (client_id, client_info) VALUES (?, ?)').run('client-1', '{"client_id":"client-1"}');
		old.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('mcp_auth_password', 'password-record');
		// Records an earlier deletion left behind in free pages, which dropping the tables doesn't reach.
		old.exec('CREATE TABLE scratch (value TEXT)');
		old.prepare('INSERT INTO scratch VALUES (?)').run(`${MARKER}-leftover-${'x'.repeat(5000)}`);
		old.exec('DROP TABLE scratch');
		old.close();
		assert.ok(readFileSync(path).includes(`${MARKER}-leftover`), 'the leftover is really in the file');

		const db = new WhoopDatabase(path);
		t.after(() => db.close());

		const reader = new Database(path, { readonly: true });
		const tables = (reader.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(row => row.name);
		reader.close();
		assert.deepEqual(tables, ['oauth_clients', 'oauth_codes', 'oauth_tokens', 'settings', 'tokens']);
		for (const file of [path, `${path}-wal`]) {
			if (existsSync(file)) assert.ok(!readFileSync(file).includes(MARKER), `no stored record is left in ${file}`);
		}

		assert.deepEqual(db.getTokens(), { access_token: 'whoop-access', refresh_token: 'whoop-refresh', expires_at: 1_900_000_000_000 });
		assert.ok(db.getOAuthClient('client-1'));
		assert.equal(db.getSetting('mcp_auth_password'), 'password-record');
		assert.ok(logged.some(line => line.startsWith('Deleted the WHOOP data stored by an earlier version.')), 'the operator is told once');
		assert.equal(db.getSetting('health_data_rewrite_pending'), undefined);
	});

	it('finishes the job on the next start if the file was never rewritten', t => {
		t.mock.method(process.stderr, 'write', () => true);
		const path = tempPath(t);
		new WhoopDatabase(path).close();

		// As if the server stopped right after dropping the tables: records remain in free pages.
		const crashed = new Database(path);
		crashed.exec('CREATE TABLE sleep (id TEXT)');
		crashed.prepare('INSERT INTO sleep VALUES (?)').run(`${MARKER}-${'x'.repeat(5000)}`);
		crashed.exec('DROP TABLE sleep');
		crashed.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('health_data_rewrite_pending', 'true');
		crashed.close();
		assert.ok(readFileSync(path).includes(MARKER));

		const db = new WhoopDatabase(path);
		t.after(() => db.close());
		assert.ok(!readFileSync(path).includes(MARKER));
		assert.equal(db.getSetting('health_data_rewrite_pending'), undefined);
	});

	it('syncs every commit to disk, so a power cut cannot undo a saved token or refresh mark', t => {
		const db = new WhoopDatabase(tempPath(t));
		t.after(() => db.close());
		// A connection setting, so it can only be read through the connection itself.
		const connection = (db as unknown as { db: Database.Database }).db;
		assert.equal(connection.pragma('synchronous', { simple: true }), 2);
	});

	it('does nothing on later starts', t => {
		const logged: string[] = [];
		t.mock.method(process.stderr, 'write', (chunk: string) => {
			logged.push(chunk);
			return true;
		});
		const path = tempPath(t);
		new WhoopDatabase(path).close();
		new WhoopDatabase(path).close();
		assert.deepEqual(logged, []);
	});
});

describe('the WHOOP token store', () => {
	it('keeps the mark of an unfinished refresh across a restart, until tokens are saved without it', t => {
		const path = tempPath(t);
		const first = new WhoopDatabase(path);
		first.saveTokens({ access_token: 'access', refresh_token: 'refresh', expires_at: 1, refresh_started_at: 1234 });
		first.close();

		const reopened = new WhoopDatabase(path);
		t.after(() => reopened.close());
		assert.equal(reopened.getTokens()?.refresh_started_at, 1234);
		reopened.saveTokens({ access_token: 'new-access', refresh_token: 'new-refresh', expires_at: 2 });
		assert.deepEqual(reopened.getTokens(), { access_token: 'new-access', refresh_token: 'new-refresh', expires_at: 2 });
	});

	it('is one object, so clients built on the same database refresh one at a time', t => {
		const db = memoryDb(t);
		assert.equal(db.whoopTokens, db.whoopTokens);
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
