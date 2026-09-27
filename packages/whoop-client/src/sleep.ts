import type { WhoopSleep } from './types.js';

/**
 * Time asleep, in milliseconds: the sum of the light, deep and REM stages. In bed minus
 * awake would also count the time the strap recorded no data. Null when a stage is
 * missing, rather than a partial total.
 */
export function timeAsleepMilli(sleep: WhoopSleep): number | null {
	const stages = sleep.score?.stage_summary;
	const light = stages?.total_light_sleep_time_milli;
	const deep = stages?.total_slow_wave_sleep_time_milli;
	const rem = stages?.total_rem_sleep_time_milli;
	return light == null || deep == null || rem == null ? null : light + deep + rem;
}
