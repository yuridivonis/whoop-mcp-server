import Database from 'better-sqlite3';
import { encrypt, decrypt, isEncrypted } from './crypto.js';
import type { StoredWhoopTokens, TokenStore, DbOAuthCode, DbOAuthToken } from './types.js';

interface TokenRow {
	id: number;
	access_token: string;
	refresh_token: string;
	expires_at: number;
	refresh_started_at: number | null;
	updated_at: string;
}

/** Where versions before 1.3.0 kept a copy of the WHOOP data. */
const HEALTH_DATA_TABLES = ['cycles', 'recovery', 'sleep', 'workouts', 'sync_state'];

/**
 * The server's own state: the encrypted WHOOP tokens, sign-ins for /mcp, and settings.
 * It never holds WHOOP data; the tools fetch that live from WHOOP.
 */
export class WhoopDatabase {
	private db: Database.Database;
	private warnedUnreadableTokens = false;

	/** The WHOOP tokens, as the store the WHOOP client reads and saves. */
	readonly whoopTokens: TokenStore = {
		load: async () => this.getTokens(),
		save: async tokens => this.saveTokens(tokens),
	};

	constructor(dbPath = './whoop.db') {
		this.db = new Database(dbPath);
		this.db.pragma('journal_mode = WAL');
		this.deleteHealthData();
		this.initSchema();
	}

	/**
	 * Versions before 1.3.0 kept a copy of the WHOOP data. It's deleted on the first start,
	 * and the file is rewritten so the data is gone from the disk too: dropping a table only
	 * marks its pages free, and they keep their contents until something overwrites them.
	 * The WHOOP tokens and sign-ins are kept.
	 */
	private deleteHealthData(): void {
		const found = HEALTH_DATA_TABLES.filter(table =>
			this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
		);
		if (found.length === 0) return;

		this.db.transaction(() => {
			for (const table of found) {
				this.db.exec(`DROP TABLE ${table}`);
			}
		})();
		this.db.exec('VACUUM');
		// VACUUM writes the new file through the write-ahead log; this copies it over and
		// empties the log, so no old page survives there either.
		this.db.pragma('wal_checkpoint(TRUNCATE)');
		process.stderr.write('Deleted the WHOOP data stored by an earlier version. The server now fetches it live from WHOOP and keeps no copy.\n');
	}

	private initSchema(): void {
		// Sign-in tables from before sign-in generations lack the generation column. They
		// only hold sign-in state, so they are dropped and recreated: clients sign in once more.
		const tokenColumns = this.db.prepare("SELECT name FROM pragma_table_info('oauth_tokens')").all() as { name: string }[];
		if (tokenColumns.length > 0 && !tokenColumns.some(column => column.name === 'generation')) {
			this.db.exec('DROP TABLE IF EXISTS oauth_codes; DROP TABLE IF EXISTS oauth_tokens;');
		}

		this.db.exec(`
			CREATE TABLE IF NOT EXISTS tokens (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				access_token TEXT NOT NULL,
				refresh_token TEXT NOT NULL,
				expires_at INTEGER NOT NULL,
				refresh_started_at INTEGER,
				updated_at TEXT DEFAULT CURRENT_TIMESTAMP
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
				generation TEXT NOT NULL,
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
				generation TEXT NOT NULL,
				kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
				client_id TEXT NOT NULL,
				scopes TEXT NOT NULL,
				expires_at INTEGER NOT NULL,
				consumed_at INTEGER
			);

			CREATE INDEX IF NOT EXISTS idx_oauth_tokens_family ON oauth_tokens(family_id);

			CREATE TABLE IF NOT EXISTS settings (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
		`);

		// Added in 1.3.0; CREATE TABLE IF NOT EXISTS leaves an existing table as it was.
		const hasMark = this.db.prepare("SELECT 1 FROM pragma_table_info('tokens') WHERE name = 'refresh_started_at'").get();
		if (!hasMark) {
			this.db.exec('ALTER TABLE tokens ADD COLUMN refresh_started_at INTEGER');
		}
	}

	saveTokens(tokens: StoredWhoopTokens): void {
		const encryptedAccess = encrypt(tokens.access_token);
		const encryptedRefresh = encrypt(tokens.refresh_token);

		this.db.prepare(`
			INSERT OR REPLACE INTO tokens (id, access_token, refresh_token, expires_at, refresh_started_at, updated_at)
			VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		`).run(encryptedAccess, encryptedRefresh, tokens.expires_at, tokens.refresh_started_at ?? null);
	}

	getTokens(): StoredWhoopTokens | null {
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
			...(row.refresh_started_at === null ? {} : { refresh_started_at: row.refresh_started_at }),
		};
	}

	getSetting(key: string): string | undefined {
		const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
		return row?.value;
	}

	setSetting(key: string, value: string): void {
		this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
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
			INSERT INTO oauth_codes (code_hash, family_id, generation, client_id, code_challenge, redirect_uri, scopes, expires_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`).run(code.code_hash, code.family_id, code.generation, code.client_id, code.code_challenge, code.redirect_uri, code.scopes, code.expires_at);
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
			INSERT INTO oauth_tokens (token_hash, family_id, generation, kind, client_id, scopes, expires_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run(token.token_hash, token.family_id, token.generation, token.kind, token.client_id, token.scopes, token.expires_at);
	}

	getOAuthToken(tokenHash: string, kind?: DbOAuthToken['kind']): DbOAuthToken | undefined {
		const row = this.db.prepare('SELECT * FROM oauth_tokens WHERE token_hash = ?').get(tokenHash) as DbOAuthToken | undefined;
		return kind === undefined || row?.kind === kind ? row : undefined;
	}

	/** Marks the refresh token used and returns it, in one statement, so it works only once. */
	consumeRefreshToken(tokenHash: string, clientId: string, generation: string, now: number): DbOAuthToken | undefined {
		return this.db.prepare(`
			UPDATE oauth_tokens SET consumed_at = ?
			WHERE token_hash = ? AND kind = 'refresh' AND client_id = ? AND generation = ? AND consumed_at IS NULL
			RETURNING *
		`).get(now, tokenHash, clientId, generation) as DbOAuthToken | undefined;
	}

	deleteOAuthToken(tokenHash: string): void {
		this.db.prepare('DELETE FROM oauth_tokens WHERE token_hash = ?').run(tokenHash);
	}

	/**
	 * Saves a new password record and deletes every code and token, in one transaction.
	 * The old grants would be rejected anyway (they carry the old generation); this just
	 * clears them out. Registered clients are kept.
	 */
	startSignInGeneration(settingKey: string, record: string): void {
		this.db.transaction(() => {
			this.setSetting(settingKey, record);
			this.db.prepare('DELETE FROM oauth_codes').run();
			this.db.prepare('DELETE FROM oauth_tokens').run();
		})();
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
