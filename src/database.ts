import Database from 'better-sqlite3';
import { encrypt, decrypt, isEncrypted } from './crypto.js';
import type {
	WhoopTokens,
	WhoopCycle,
	WhoopRecovery,
	WhoopSleep,
	WhoopWorkout,
	DbCycle,
	DbRecovery,
	DbSleep,
	DbWorkout,
	DbOAuthCode,
	DbOAuthToken,
} from './types.js';

interface TokenRow {
	id: number;
	access_token: string;
	refresh_token: string;
	expires_at: number;
	updated_at: string;
}

interface SyncStateRow {
	id: number;
	last_sync_at: string | null;
	oldest_synced_date: string | null;
	newest_synced_date: string | null;
}

interface RecoveryTrendRow {
	date: string;
	recovery_score: number;
	hrv: number;
	rhr: number;
}

interface SleepTrendRow {
	date: string;
	total_sleep_hours: number;
	performance: number;
	efficiency: number;
}

interface StrainTrendRow {
	date: string;
	strain: number;
	calories: number;
}

export class WhoopDatabase {
	private db: Database.Database;
	private warnedUnreadableTokens = false;

	constructor(dbPath = './whoop.db') {
		this.db = new Database(dbPath);
		this.db.pragma('journal_mode = WAL');
		this.initSchema();
	}

	private initSchema(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS tokens (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				access_token TEXT NOT NULL,
				refresh_token TEXT NOT NULL,
				expires_at INTEGER NOT NULL,
				updated_at TEXT DEFAULT CURRENT_TIMESTAMP
			);

			CREATE TABLE IF NOT EXISTS sync_state (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				last_sync_at TEXT,
				oldest_synced_date TEXT,
				newest_synced_date TEXT
			);

			CREATE TABLE IF NOT EXISTS cycles (
				id INTEGER PRIMARY KEY,
				user_id INTEGER NOT NULL,
				start_time TEXT NOT NULL,
				end_time TEXT,
				score_state TEXT NOT NULL,
				strain REAL,
				kilojoule REAL,
				avg_hr INTEGER,
				max_hr INTEGER,
				synced_at TEXT DEFAULT CURRENT_TIMESTAMP
			);

			CREATE TABLE IF NOT EXISTS recovery (
				id INTEGER PRIMARY KEY,
				user_id INTEGER NOT NULL,
				sleep_id TEXT,
				created_at TEXT NOT NULL,
				score_state TEXT NOT NULL,
				recovery_score INTEGER,
				resting_hr INTEGER,
				hrv_rmssd REAL,
				spo2 REAL,
				skin_temp REAL,
				synced_at TEXT DEFAULT CURRENT_TIMESTAMP
			);

			CREATE TABLE IF NOT EXISTS sleep (
				id TEXT PRIMARY KEY,
				user_id INTEGER NOT NULL,
				cycle_id INTEGER,
				start_time TEXT NOT NULL,
				end_time TEXT NOT NULL,
				is_nap INTEGER NOT NULL DEFAULT 0,
				score_state TEXT NOT NULL,
				total_in_bed_milli INTEGER,
				total_awake_milli INTEGER,
				total_light_milli INTEGER,
				total_deep_milli INTEGER,
				total_rem_milli INTEGER,
				sleep_performance REAL,
				sleep_efficiency REAL,
				sleep_consistency REAL,
				respiratory_rate REAL,
				sleep_needed_baseline_milli INTEGER,
				sleep_needed_debt_milli INTEGER,
				sleep_needed_strain_milli INTEGER,
				synced_at TEXT DEFAULT CURRENT_TIMESTAMP
			);

			CREATE TABLE IF NOT EXISTS workouts (
				id TEXT PRIMARY KEY,
				user_id INTEGER NOT NULL,
				sport_id INTEGER NOT NULL,
				start_time TEXT NOT NULL,
				end_time TEXT NOT NULL,
				score_state TEXT NOT NULL,
				strain REAL,
				avg_hr INTEGER,
				max_hr INTEGER,
				kilojoule REAL,
				zone_zero_milli INTEGER,
				zone_one_milli INTEGER,
				zone_two_milli INTEGER,
				zone_three_milli INTEGER,
				zone_four_milli INTEGER,
				zone_five_milli INTEGER,
				synced_at TEXT DEFAULT CURRENT_TIMESTAMP
			);

			-- Sign-in for /mcp (OAuth 2.1). Codes and tokens are stored as SHA-256 hashes,
			-- so a copy of this file cannot be used to call the server.
			CREATE TABLE IF NOT EXISTS oauth_clients (
				client_id TEXT PRIMARY KEY,
				client_info TEXT NOT NULL,
				created_at TEXT DEFAULT CURRENT_TIMESTAMP
			);

			-- family_id ties a code to every token issued from it, so a replayed code or
			-- refresh token revokes the whole sign-in. Used rows are kept (consumed_at) while
			-- their family is still live, which is what makes a replay detectable.
			CREATE TABLE IF NOT EXISTS oauth_codes (
				code_hash TEXT PRIMARY KEY,
				family_id TEXT NOT NULL,
				client_id TEXT NOT NULL,
				code_challenge TEXT NOT NULL,
				redirect_uri TEXT NOT NULL,
				scopes TEXT NOT NULL,
				expires_at INTEGER NOT NULL,
				consumed_at INTEGER
			);

			CREATE TABLE IF NOT EXISTS oauth_tokens (
				token_hash TEXT PRIMARY KEY,
				family_id TEXT NOT NULL,
				kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
				client_id TEXT NOT NULL,
				scopes TEXT NOT NULL,
				expires_at INTEGER NOT NULL,
				consumed_at INTEGER
			);

			CREATE INDEX IF NOT EXISTS idx_oauth_tokens_family ON oauth_tokens(family_id);

			CREATE INDEX IF NOT EXISTS idx_cycles_start ON cycles(start_time);
			CREATE INDEX IF NOT EXISTS idx_recovery_created ON recovery(created_at);
			CREATE INDEX IF NOT EXISTS idx_sleep_start ON sleep(start_time);
			CREATE INDEX IF NOT EXISTS idx_workouts_start ON workouts(start_time);

			INSERT OR IGNORE INTO sync_state (id) VALUES (1);
		`);
	}

	saveTokens(tokens: WhoopTokens): void {
		const encryptedAccess = encrypt(tokens.access_token);
		const encryptedRefresh = encrypt(tokens.refresh_token);

		this.db.prepare(`
			INSERT OR REPLACE INTO tokens (id, access_token, refresh_token, expires_at, updated_at)
			VALUES (1, ?, ?, ?, CURRENT_TIMESTAMP)
		`).run(encryptedAccess, encryptedRefresh, tokens.expires_at);
	}

	getTokens(): WhoopTokens | null {
		const row = this.db.prepare('SELECT * FROM tokens WHERE id = 1').get() as TokenRow | undefined;
		if (!row) return null;

		let accessToken: string;
		let refreshToken: string;
		try {
			accessToken = isEncrypted(row.access_token) ? decrypt(row.access_token) : row.access_token;
			refreshToken = isEncrypted(row.refresh_token) ? decrypt(row.refresh_token) : row.refresh_token;
		} catch {
			// The key changed (ENCRYPTION_SECRET, or WHOOP_CLIENT_SECRET when that is unset).
			// Treat WHOOP as disconnected so the server still starts and get_auth_url can
			// store fresh tokens, instead of crashing on every restart.
			if (!this.warnedUnreadableTokens) {
				this.warnedUnreadableTokens = true;
				process.stderr.write('Stored Whoop tokens could not be decrypted (encryption key changed?). Run get_auth_url to reconnect.\n');
			}
			return null;
		}

		return {
			access_token: accessToken,
			refresh_token: refreshToken,
			expires_at: row.expires_at,
		};
	}

	getSyncState(): { lastSyncAt: string | null; oldestDate: string | null; newestDate: string | null } {
		const row = this.db.prepare('SELECT * FROM sync_state WHERE id = 1').get() as SyncStateRow | undefined;
		return {
			lastSyncAt: row?.last_sync_at ?? null,
			oldestDate: row?.oldest_synced_date ?? null,
			newestDate: row?.newest_synced_date ?? null,
		};
	}

	updateSyncState(oldestDate: string, newestDate: string): void {
		this.db.prepare(`
			UPDATE sync_state
			SET last_sync_at = CURRENT_TIMESTAMP,
				oldest_synced_date = COALESCE(
					CASE WHEN oldest_synced_date IS NULL OR ? < oldest_synced_date THEN ? ELSE oldest_synced_date END,
					?
				),
				newest_synced_date = COALESCE(
					CASE WHEN newest_synced_date IS NULL OR ? > newest_synced_date THEN ? ELSE newest_synced_date END,
					?
				)
			WHERE id = 1
		`).run(oldestDate, oldestDate, oldestDate, newestDate, newestDate, newestDate);
	}

	upsertCycles(cycles: WhoopCycle[]): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO cycles (id, user_id, start_time, end_time, score_state, strain, kilojoule, avg_hr, max_hr, synced_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		`);

		const insertMany = this.db.transaction((items: WhoopCycle[]) => {
			for (const c of items) {
				stmt.run(
					c.id,
					c.user_id,
					c.start,
					c.end,
					c.score_state,
					c.score?.strain ?? null,
					c.score?.kilojoule ?? null,
					c.score?.average_heart_rate ?? null,
					c.score?.max_heart_rate ?? null
				);
			}
		});

		insertMany(cycles);
	}

	upsertRecoveries(recoveries: WhoopRecovery[]): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO recovery (id, user_id, sleep_id, created_at, score_state, recovery_score, resting_hr, hrv_rmssd, spo2, skin_temp, synced_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		`);

		const insertMany = this.db.transaction((items: WhoopRecovery[]) => {
			for (const r of items) {
				stmt.run(
					r.cycle_id,
					r.user_id,
					r.sleep_id,
					r.created_at,
					r.score_state,
					r.score?.recovery_score ?? null,
					r.score?.resting_heart_rate ?? null,
					r.score?.hrv_rmssd_milli ?? null,
					r.score?.spo2_percentage ?? null,
					r.score?.skin_temp_celsius ?? null
				);
			}
		});

		insertMany(recoveries);
	}

	upsertSleeps(sleeps: WhoopSleep[]): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO sleep (
				id, user_id, start_time, end_time, is_nap, score_state,
				total_in_bed_milli, total_awake_milli, total_light_milli, total_deep_milli, total_rem_milli,
				sleep_performance, sleep_efficiency, sleep_consistency, respiratory_rate,
				sleep_needed_baseline_milli, sleep_needed_debt_milli, sleep_needed_strain_milli, synced_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		`);

		const insertMany = this.db.transaction((items: WhoopSleep[]) => {
			for (const s of items) {
				stmt.run(
					s.id,
					s.user_id,
					s.start,
					s.end,
					s.nap ? 1 : 0,
					s.score_state,
					s.score?.stage_summary?.total_in_bed_time_milli ?? null,
					s.score?.stage_summary?.total_awake_time_milli ?? null,
					s.score?.stage_summary?.total_light_sleep_time_milli ?? null,
					s.score?.stage_summary?.total_slow_wave_sleep_time_milli ?? null,
					s.score?.stage_summary?.total_rem_sleep_time_milli ?? null,
					s.score?.sleep_performance_percentage ?? null,
					s.score?.sleep_efficiency_percentage ?? null,
					s.score?.sleep_consistency_percentage ?? null,
					s.score?.respiratory_rate ?? null,
					s.score?.sleep_needed?.baseline_milli ?? null,
					s.score?.sleep_needed?.need_from_sleep_debt_milli ?? null,
					s.score?.sleep_needed?.need_from_recent_strain_milli ?? null
				);
			}
		});

		insertMany(sleeps);
	}

	upsertWorkouts(workouts: WhoopWorkout[]): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO workouts (
				id, user_id, sport_id, start_time, end_time, score_state,
				strain, avg_hr, max_hr, kilojoule,
				zone_zero_milli, zone_one_milli, zone_two_milli, zone_three_milli, zone_four_milli, zone_five_milli,
				synced_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		`);

		const insertMany = this.db.transaction((items: WhoopWorkout[]) => {
			for (const w of items) {
				stmt.run(
					w.id,
					w.user_id,
					w.sport_id,
					w.start,
					w.end,
					w.score_state,
					w.score?.strain ?? null,
					w.score?.average_heart_rate ?? null,
					w.score?.max_heart_rate ?? null,
					w.score?.kilojoule ?? null,
					w.score?.zone_durations?.zone_zero_milli ?? null,
					w.score?.zone_durations?.zone_one_milli ?? null,
					w.score?.zone_durations?.zone_two_milli ?? null,
					w.score?.zone_durations?.zone_three_milli ?? null,
					w.score?.zone_durations?.zone_four_milli ?? null,
					w.score?.zone_durations?.zone_five_milli ?? null
				);
			}
		});

		insertMany(workouts);
	}

	getLatestCycle(): DbCycle | null {
		return this.db.prepare('SELECT * FROM cycles ORDER BY start_time DESC LIMIT 1').get() as DbCycle | undefined ?? null;
	}

	getLatestRecovery(): DbRecovery | null {
		return this.db.prepare('SELECT * FROM recovery ORDER BY created_at DESC LIMIT 1').get() as DbRecovery | undefined ?? null;
	}

	getLatestSleep(): DbSleep | null {
		return this.db.prepare('SELECT * FROM sleep WHERE is_nap = 0 ORDER BY start_time DESC LIMIT 1').get() as DbSleep | undefined ?? null;
	}

	getWorkoutsByDateRange(startDate: string, endDate: string): DbWorkout[] {
		return this.db.prepare(`
			SELECT * FROM workouts WHERE start_time >= ? AND start_time <= ? ORDER BY start_time DESC
		`).all(startDate, endDate) as DbWorkout[];
	}

	getRecoveryTrends(days: number): RecoveryTrendRow[] {
		return this.db.prepare(`
			SELECT DATE(created_at) as date, recovery_score, hrv_rmssd as hrv, resting_hr as rhr
			FROM recovery
			WHERE recovery_score IS NOT NULL AND created_at >= DATE('now', '-' || ? || ' days')
			ORDER BY created_at DESC
		`).all(days) as RecoveryTrendRow[];
	}

	getSleepTrends(days: number): SleepTrendRow[] {
		return this.db.prepare(`
			SELECT DATE(start_time) as date,
				ROUND((total_in_bed_milli - total_awake_milli) / 3600000.0, 2) as total_sleep_hours,
				sleep_performance as performance, sleep_efficiency as efficiency
			FROM sleep
			WHERE is_nap = 0 AND sleep_performance IS NOT NULL AND start_time >= DATE('now', '-' || ? || ' days')
			ORDER BY start_time DESC
		`).all(days) as SleepTrendRow[];
	}

	getStrainTrends(days: number): StrainTrendRow[] {
		return this.db.prepare(`
			SELECT DATE(start_time) as date, strain, ROUND(kilojoule / 4.184, 0) as calories
			FROM cycles
			WHERE strain IS NOT NULL AND start_time >= DATE('now', '-' || ? || ' days')
			ORDER BY start_time DESC
		`).all(days) as StrainTrendRow[];
	}

	getOAuthClient(clientId: string): string | undefined {
		const row = this.db.prepare('SELECT client_info FROM oauth_clients WHERE client_id = ?').get(clientId) as { client_info: string } | undefined;
		return row?.client_info;
	}

	saveOAuthClient(clientId: string, clientInfo: string): void {
		this.db.prepare('INSERT INTO oauth_clients (client_id, client_info) VALUES (?, ?)').run(clientId, clientInfo);
	}

	saveOAuthCode(code: Omit<DbOAuthCode, 'consumed_at'>): void {
		this.db.prepare(`
			INSERT INTO oauth_codes (code_hash, family_id, client_id, code_challenge, redirect_uri, scopes, expires_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run(code.code_hash, code.family_id, code.client_id, code.code_challenge, code.redirect_uri, code.scopes, code.expires_at);
	}

	getOAuthCode(codeHash: string): DbOAuthCode | undefined {
		return this.db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(codeHash) as DbOAuthCode | undefined;
	}

	/** Marks the code used and returns it, in one statement, so it can be exchanged only once. */
	consumeOAuthCode(codeHash: string, now: number): DbOAuthCode | undefined {
		return this.db.prepare(
			'UPDATE oauth_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL RETURNING *'
		).get(now, codeHash) as DbOAuthCode | undefined;
	}

	saveOAuthToken(token: Omit<DbOAuthToken, 'consumed_at'>): void {
		this.db.prepare(`
			INSERT INTO oauth_tokens (token_hash, family_id, kind, client_id, scopes, expires_at)
			VALUES (?, ?, ?, ?, ?, ?)
		`).run(token.token_hash, token.family_id, token.kind, token.client_id, token.scopes, token.expires_at);
	}

	getOAuthToken(tokenHash: string, kind?: DbOAuthToken['kind']): DbOAuthToken | undefined {
		const row = this.db.prepare('SELECT * FROM oauth_tokens WHERE token_hash = ?').get(tokenHash) as DbOAuthToken | undefined;
		return kind === undefined || row?.kind === kind ? row : undefined;
	}

	/** Marks the refresh token used and returns it, in one statement, so it works only once. */
	consumeRefreshToken(tokenHash: string, clientId: string, now: number): DbOAuthToken | undefined {
		return this.db.prepare(`
			UPDATE oauth_tokens SET consumed_at = ?
			WHERE token_hash = ? AND kind = 'refresh' AND client_id = ? AND consumed_at IS NULL
			RETURNING *
		`).get(now, tokenHash, clientId) as DbOAuthToken | undefined;
	}

	deleteOAuthToken(tokenHash: string): void {
		this.db.prepare('DELETE FROM oauth_tokens WHERE token_hash = ?').run(tokenHash);
	}

	/** Revokes every token issued from one sign-in. */
	deleteOAuthFamily(familyId: string): void {
		this.db.prepare('DELETE FROM oauth_tokens WHERE family_id = ?').run(familyId);
	}

	/**
	 * Deletes expired codes and tokens. A used code or refresh token is kept while its
	 * family still has a live token: it is the marker that catches a late replay, so it
	 * must outlive its own expiry for as long as a thief could be using the family.
	 */
	deleteExpiredOAuth(now: number): void {
		const liveFamilies = 'SELECT family_id FROM oauth_tokens WHERE consumed_at IS NULL AND expires_at >= ?';
		this.db.prepare(
			`DELETE FROM oauth_codes WHERE expires_at < ? AND (consumed_at IS NULL OR family_id NOT IN (${liveFamilies}))`
		).run(now, now);
		this.db.prepare(
			`DELETE FROM oauth_tokens WHERE expires_at < ? AND (consumed_at IS NULL OR family_id NOT IN (${liveFamilies}))`
		).run(now, now);
	}

	close(): void {
		this.db.close();
	}
}
