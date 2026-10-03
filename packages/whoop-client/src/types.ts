/** An OAuth scope WHOOP grants. `offline` is needed for a refresh token. */
export type WhoopScope =
	| 'read:recovery'
	| 'read:cycles'
	| 'read:sleep'
	| 'read:workout'
	| 'read:profile'
	| 'read:body_measurement'
	| 'offline';

/** Whether WHOOP has scored a record yet. Only SCORED records carry a score. */
export type ScoreState = 'SCORED' | 'PENDING_SCORE' | 'UNSCORABLE';

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
	 * refresh one at a time. load(), save() and clear() are called inside it, so it must not
	 * block them.
	 */
	withLock?<T>(fn: () => Promise<T>): Promise<T>;
	/**
	 * Forgets the stored tokens. Must not resolve until that's durable. Optional: only
	 * WhoopClient.revokeAccess() uses it, and without it the store keeps tokens WHOOP has
	 * revoked, which ask the user to reconnect when next used.
	 */
	clear?(): Promise<void>;
}

/** Which records to fetch. WHOOP returns the newest first. */
export interface WhoopQuery {
	/** Only records from this time on (ISO 8601). */
	start?: string;
	/** Only records before this time (ISO 8601). */
	end?: string;
	/** At most this many records. */
	limit?: number;
}

/** A physiological cycle: WHOOP's "day", from falling asleep one night to falling asleep the next. API v2 `Cycle`. */
export interface WhoopCycle {
	id: number;
	user_id: number;
	/** When WHOOP recorded the cycle (ISO 8601, UTC). */
	created_at: string;
	updated_at: string;
	start: string;
	/** Absent (or null) while the user is still in this cycle. */
	end?: string | null;
	/** The user's offset at the time, like "+02:00". */
	timezone_offset: string;
	score_state: ScoreState;
	score?: {
		/** WHOOP's cardiovascular load for the cycle, 0–21. */
		strain: number;
		/** Energy expended during the cycle, in kilojoules. */
		kilojoule: number;
		/** Beats per minute. */
		average_heart_rate: number;
		/** Beats per minute. */
		max_heart_rate: number;
	};
	/** Steps taken during the cycle. Null when WHOOP has no step data for it; absent on older records. */
	step_count?: number | null;
}

/** The user's basic profile. API v2 `UserBasicProfile`; needs the `read:profile` scope. No client method fetches it yet. */
export interface WhoopProfile {
	user_id: number;
	email: string;
	first_name: string;
	last_name: string;
}

/** The user's body measurements. API v2 `UserBodyMeasurement`; needs the `read:body_measurement` scope. No client method fetches it yet. */
export interface WhoopBodyMeasurement {
	height_meter: number;
	weight_kilogram: number;
	/** The maximum heart rate WHOOP calculated for the user, in beats per minute. */
	max_heart_rate: number;
}

/** How recovered the user is for a cycle. API v2 `Recovery`. */
export interface WhoopRecovery {
	cycle_id: number;
	/** The sleep the recovery was scored from. */
	sleep_id: string;
	user_id: number;
	created_at: string;
	updated_at: string;
	score_state: ScoreState;
	score?: {
		/** True while WHOOP is still learning the user's baseline and can't score fully. */
		user_calibrating: boolean;
		/** 0–100 %. */
		recovery_score: number;
		/** Beats per minute. */
		resting_heart_rate: number;
		/** Heart rate variability (RMSSD), in milliseconds. */
		hrv_rmssd_milli: number;
		/** Blood oxygen, 0–100 %. Only on WHOOP 4.0 or later. */
		spo2_percentage?: number;
		/** Skin temperature, in °C. Only on WHOOP 4.0 or later. */
		skin_temp_celsius?: number;
	};
}

/** A night of sleep or a nap. API v2 `Sleep`. */
export interface WhoopSleep {
	id: string;
	/** The cycle this sleep belongs to. */
	cycle_id: number;
	/** The API v1 identifier; WHOOP stopped sending it in September 2025. */
	v1_id?: number;
	user_id: number;
	created_at: string;
	updated_at: string;
	start: string;
	end: string;
	timezone_offset: string;
	nap: boolean;
	score_state: ScoreState;
	score?: {
		/** Time in each stage, in milliseconds. */
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
		/** How much sleep the body needed going into this sleep, in milliseconds, by part. The nap part is negative or zero: a credit. */
		sleep_needed: {
			baseline_milli: number;
			need_from_sleep_debt_milli: number;
			need_from_recent_strain_milli: number;
			need_from_recent_nap_milli: number;
		};
		/** Breaths per minute. WHOOP marks these four optional: they can be missing on a scored sleep. */
		respiratory_rate?: number;
		sleep_performance_percentage?: number;
		sleep_consistency_percentage?: number;
		sleep_efficiency_percentage?: number;
	};
}

/** A workout. API v2 `WorkoutV2`. */
export interface WhoopWorkout {
	id: string;
	/** The API v1 identifier; WHOOP stopped sending it in September 2025. */
	v1_id?: number;
	user_id: number;
	created_at: string;
	updated_at: string;
	start: string;
	end: string;
	timezone_offset: string;
	/** The sport, e.g. "running". */
	sport_name: string;
	/** The v1 sport number; WHOOP stopped sending it in September 2025. */
	sport_id?: number;
	score_state: ScoreState;
	score?: {
		/** WHOOP's cardiovascular load for the workout, 0–21. */
		strain: number;
		/** Beats per minute. */
		average_heart_rate: number;
		/** Beats per minute. */
		max_heart_rate: number;
		/** Energy expended, in kilojoules. */
		kilojoule: number;
		/** Share (0–100) of the workout for which WHOOP received heart-rate data. */
		percent_recorded: number;
		/** Metres, only when the workout sent distance data to WHOOP. */
		distance_meter?: number;
		/** Metres climbed, only when sent. Descents don't count. */
		altitude_gain_meter?: number;
		/** Metres between the start and end points, only when sent. */
		altitude_change_meter?: number;
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

/** One page of a WHOOP collection. Internal: the client's methods return every page's records together. */
export interface WhoopPage<T> {
	records: T[];
	next_token?: string;
}
