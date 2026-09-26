export interface WhoopTokens {
	access_token: string;
	refresh_token: string;
	/** When the access token expires, in milliseconds since the epoch. */
	expires_at: number;
}

/** Tokens as a TokenStore keeps them. */
export interface StoredWhoopTokens extends WhoopTokens {
	/**
	 * Set just before the refresh token is presented to WHOOP, and cleared by saving the
	 * result. Found set, it means a refresh never finished: WHOOP may already have replaced
	 * the refresh token, so it must not be presented again.
	 */
	refresh_started_at?: number;
}

/**
 * Where a WhoopClient keeps its tokens. WHOOP replaces the refresh token on every refresh
 * and rejects a used one, so the client re-reads the store before refreshing and saves
 * the new tokens straight away.
 */
export interface TokenStore {
	/** The stored tokens, or null when WHOOP isn't connected. */
	load(): Promise<StoredWhoopTokens | null>;
	/** Replaces the stored tokens, mark included. Must not resolve until they're durably saved. */
	save(tokens: StoredWhoopTokens): Promise<void>;
	/**
	 * Runs fn while no other process can refresh the same tokens. Only needed when several
	 * processes share the tokens: clients in one process that share a store object already
	 * refresh one at a time. load() and save() are called inside it, so it must not block them.
	 */
	withLock?<T>(fn: () => Promise<T>): Promise<T>;
}

export interface WhoopCycle {
	id: number;
	user_id: number;
	start: string;
	end: string | null;
	timezone_offset: string;
	score_state: 'SCORED' | 'PENDING_SCORE' | 'UNSCORABLE';
	score?: {
		strain: number;
		kilojoule: number;
		average_heart_rate: number;
		max_heart_rate: number;
	};
}

export interface WhoopRecovery {
	cycle_id: number;
	sleep_id: string;
	user_id: number;
	created_at: string;
	updated_at: string;
	score_state: 'SCORED' | 'PENDING_SCORE' | 'UNSCORABLE';
	score?: {
		user_calibrating: boolean;
		recovery_score: number;
		resting_heart_rate: number;
		hrv_rmssd_milli: number;
		spo2_percentage?: number;
		skin_temp_celsius?: number;
	};
}

export interface WhoopSleep {
	id: string;
	user_id: number;
	created_at: string;
	updated_at: string;
	start: string;
	end: string;
	timezone_offset: string;
	nap: boolean;
	score_state: 'SCORED' | 'PENDING_SCORE' | 'UNSCORABLE';
	score?: {
		stage_summary: {
			total_in_bed_time_milli: number;
			total_awake_time_milli: number;
			total_no_data_time_milli: number;
			total_light_sleep_time_milli: number;
			total_slow_wave_sleep_time_milli: number;
			total_rem_sleep_time_milli: number;
			sleep_cycle_count: number;
			disturbance_count: number;
		};
		sleep_needed: {
			baseline_milli: number;
			need_from_sleep_debt_milli: number;
			need_from_recent_strain_milli: number;
			need_from_recent_nap_milli: number;
		};
		respiratory_rate: number;
		sleep_performance_percentage: number;
		sleep_consistency_percentage: number;
		sleep_efficiency_percentage: number;
	};
}

export interface WhoopWorkout {
	id: string;
	user_id: number;
	created_at: string;
	updated_at: string;
	start: string;
	end: string;
	timezone_offset: string;
	sport_id: number;
	/** API v2, e.g. "running". */
	sport_name?: string;
	score_state: 'SCORED' | 'PENDING_SCORE' | 'UNSCORABLE';
	score?: {
		strain: number;
		average_heart_rate: number;
		max_heart_rate: number;
		kilojoule: number;
		percent_recorded: number;
		/** Named zone_durations in API v2 (zone_duration was v1); absent when there is no heart-rate data. */
		zone_durations?: {
			zone_zero_milli: number;
			zone_one_milli: number;
			zone_two_milli: number;
			zone_three_milli: number;
			zone_four_milli: number;
			zone_five_milli: number;
		};
	};
}

export interface WhoopPaginatedResponse<T> {
	records: T[];
	next_token?: string;
}

export interface DbOAuthCode {
	code_hash: string;
	/** Shared by this code and every token issued from it. */
	family_id: string;
	/** Sign-in generation it was issued under; only the current one is accepted (auth/provider.ts). */
	generation: string;
	client_id: string;
	code_challenge: string;
	redirect_uri: string;
	/** Space-separated, as in the OAuth `scope` parameter. */
	scopes: string;
	expires_at: number;
	consumed_at: number | null;
}

export interface DbOAuthToken {
	token_hash: string;
	family_id: string;
	generation: string;
	kind: 'access' | 'refresh';
	client_id: string;
	/** Space-separated, as in the OAuth `scope` parameter. */
	scopes: string;
	expires_at: number;
	/** Set when a refresh token is used; a second use means it leaked. */
	consumed_at: number | null;
}
