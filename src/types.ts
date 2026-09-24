export interface WhoopTokens {
	access_token: string;
	refresh_token: string;
	expires_at: number;
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

export interface DbCycle {
	id: number;
	user_id: number;
	start_time: string;
	end_time: string | null;
	score_state: string;
	strain: number | null;
	kilojoule: number | null;
	avg_hr: number | null;
	max_hr: number | null;
	synced_at: string;
}

export interface DbRecovery {
	id: number;
	user_id: number;
	sleep_id: string;
	created_at: string;
	score_state: string;
	recovery_score: number | null;
	resting_hr: number | null;
	hrv_rmssd: number | null;
	spo2: number | null;
	skin_temp: number | null;
	synced_at: string;
}

export interface DbSleep {
	id: string;
	user_id: number;
	cycle_id: number | null;
	start_time: string;
	end_time: string;
	is_nap: number;
	score_state: string;
	total_in_bed_milli: number | null;
	total_awake_milli: number | null;
	total_light_milli: number | null;
	total_deep_milli: number | null;
	total_rem_milli: number | null;
	sleep_performance: number | null;
	sleep_efficiency: number | null;
	sleep_consistency: number | null;
	respiratory_rate: number | null;
	sleep_needed_baseline_milli: number | null;
	sleep_needed_debt_milli: number | null;
	sleep_needed_strain_milli: number | null;
	synced_at: string;
}

export interface DbWorkout {
	id: string;
	user_id: number;
	sport_id: number;
	start_time: string;
	end_time: string;
	score_state: string;
	strain: number | null;
	avg_hr: number | null;
	max_hr: number | null;
	kilojoule: number | null;
	zone_zero_milli: number | null;
	zone_one_milli: number | null;
	zone_two_milli: number | null;
	zone_three_milli: number | null;
	zone_four_milli: number | null;
	zone_five_milli: number | null;
	synced_at: string;
}

export interface DbOAuthCode {
	code_hash: string;
	/** Shared by this code and every token issued from it. */
	family_id: string;
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
	kind: 'access' | 'refresh';
	client_id: string;
	/** Space-separated, as in the OAuth `scope` parameter. */
	scopes: string;
	expires_at: number;
	/** Set when a refresh token is used; a second use means it leaked. */
	consumed_at: number | null;
}
