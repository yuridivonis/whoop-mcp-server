/**
 * Formatting for the tools' answers: every value WHOOP sends, in readable units, with
 * nothing hidden. A missing value prints as "–"; a zero prints as a zero.
 */
import { parseOffset, timeAsleepMilli } from '@yuridivonis/whoop-client';
import { localDate, localTime, wakeDay } from './days.js';
import type { WhoopCycle, WhoopRecovery, WhoopSleep, WhoopWorkout } from '@yuridivonis/whoop-client';

export const MISSING = '–';
const HOUR_MS = 60 * 60 * 1000;

/** "7h 05m"; a negative duration (a nap credit) as "− 0h 06m"; null as "–". */
export function formatDuration(millis: number | null | undefined): string {
	if (millis == null || !Number.isFinite(millis)) return MISSING;
	const sign = millis < 0 ? '− ' : '';
	const abs = Math.abs(millis);
	const hours = Math.floor(abs / HOUR_MS);
	const minutes = Math.floor((abs % HOUR_MS) / 60_000);
	return `${sign}${hours}h ${String(minutes).padStart(2, '0')}m`;
}

/** Formats a local day (YYYY-MM-DD) as "Thu, Oct 1". In UTC, so the server's own timezone can't shift it. */
export function formatDate(day: string): string {
	return new Date(`${day.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** A number with `digits` decimals and an optional unit; "–" when missing. */
export function num(value: number | null | undefined, digits = 0, unit = ''): string {
	if (value == null || !Number.isFinite(value)) return MISSING;
	return `${value.toFixed(digits)}${unit}`;
}

/** Kilojoules as whole kilocalories. */
export function kcal(kilojoule: number | null | undefined): number | null {
	return kilojoule == null || !Number.isFinite(kilojoule) ? null : Math.round(kilojoule / 4.184);
}

/** Metres as "4.2 km", or "850 m" under a kilometre. */
export function distance(meters: number | null | undefined): string {
	if (meters == null || !Number.isFinite(meters)) return MISSING;
	return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
}

/** "functional-fitness" → "Functional fitness". WHOOP always names the sport; an empty name is shown as unknown. */
export function sportName(name: string | undefined): string {
	if (!name) return 'Unknown activity';
	const words = name.replace(/[-_]+/g, ' ').trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

export function recoveryZone(score: number): string {
	if (score >= 67) return 'Green (Well Recovered)';
	if (score >= 34) return 'Yellow (Moderate)';
	return 'Red (Needs Rest)';
}

export function strainZone(strain: number): string {
	if (strain >= 18) return 'All Out (18-21)';
	if (strain >= 14) return 'High (14-17)';
	if (strain >= 10) return 'Moderate (10-13)';
	return 'Light (0-9)';
}

/** What a record without a score is doing: still being scored, or beyond scoring. */
export function scoreStateLabel(state: string): string {
	if (state === 'PENDING_SCORE') return 'pending';
	if (state === 'UNSCORABLE') return "couldn't score";
	return MISSING;
}

/** The mean of the values that are present, with how many there were. */
export function mean(values: (number | null | undefined)[]): { value: number | null; n: number } {
	const present = values.filter((v): v is number => v != null && Number.isFinite(v));
	if (present.length === 0) return { value: null, n: 0 };
	return { value: present.reduce((sum, v) => sum + v, 0) / present.length, n: present.length };
}

/** One averages line: "- **HRV**: 64.1 ms (12 of 14 days)". The count is shown only when some rows lacked the value. */
export function averageLine(label: string, values: (number | null | undefined)[], format: (value: number) => string, of: number, what = 'days'): string {
	const { value, n } = mean(values);
	const count = n < of ? ` (${n} of ${of} ${what})` : '';
	return `- **${label}**: ${value == null ? MISSING : format(value)}${count}\n`;
}

/** The day a record counts toward, marked "(UTC)" when its offset can't be read. */
export function dayOf(start: string, offset: string, wake = true): string {
	const day = wake ? wakeDay(start, offset) : localDate(start, offset);
	return parseOffset(offset) === null ? `${formatDate(day)} (UTC)` : formatDate(day);
}

/** "Wed, Sep 30 23:10 → Thu, Oct 1 06:40 (UTC+08:00)". */
export function span(start: string, end: string | null | undefined, offset: string): string {
	const from = `${formatDate(localDate(start, offset))} ${localTime(start, offset)}`;
	const to = end ? `${formatDate(localDate(end, offset))} ${localTime(end, offset)}` : 'now';
	const zone = parseOffset(offset) === null ? 'UTC, offset unreadable' : `UTC${offset}`;
	return `${from} → ${to} (${zone})`;
}

/** Columns for values WHOOP sends only some users or workouts; left out of a table when no row has them. */
export const OPTIONAL_COLUMNS = new Set(['Steps', 'Calibrating', 'SpO2 (%)', 'Skin temp (°C)', 'Distance', 'Elevation gain (m)', 'Altitude change (m)']);

/** A Markdown table from a header and rows. An optional column nobody fills (every cell "–") is left out; every other column stays. */
export function table(columns: string[], rows: string[][]): string {
	const keep = columns.map((column, i) => !OPTIONAL_COLUMNS.has(column) || rows.some(row => row[i] !== MISSING));
	const header = columns.filter((_, i) => keep[i]);
	const lines = [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`];
	for (const row of rows) lines.push(`| ${row.filter((_, i) => keep[i]).join(' | ')} |`);
	return `${lines.join('\n')}\n`;
}

// Record views: every field, as numbers or null, plus the derived ones the text needs.

export function sleepView(sleep: WhoopSleep) {
	const s = sleep.score;
	const st = s?.stage_summary;
	const need = s?.sleep_needed;
	const needTotal = need ? need.baseline_milli + need.need_from_sleep_debt_milli + need.need_from_recent_strain_milli + need.need_from_recent_nap_milli : null;
	return {
		asleep: timeAsleepMilli(sleep),
		inBed: st?.total_in_bed_time_milli ?? null,
		awake: st?.total_awake_time_milli ?? null,
		noData: st?.total_no_data_time_milli ?? null,
		light: st?.total_light_sleep_time_milli ?? null,
		deep: st?.total_slow_wave_sleep_time_milli ?? null,
		rem: st?.total_rem_sleep_time_milli ?? null,
		cycles: st?.sleep_cycle_count ?? null,
		disturbances: st?.disturbance_count ?? null,
		need: needTotal,
		baseline: need?.baseline_milli ?? null,
		debt: need?.need_from_sleep_debt_milli ?? null,
		strainNeed: need?.need_from_recent_strain_milli ?? null,
		napCredit: need?.need_from_recent_nap_milli ?? null,
		respiratory: s?.respiratory_rate ?? null,
		performance: s?.sleep_performance_percentage ?? null,
		efficiency: s?.sleep_efficiency_percentage ?? null,
		consistency: s?.sleep_consistency_percentage ?? null,
	};
}

export function recoveryView(recovery: WhoopRecovery) {
	const s = recovery.score;
	return {
		score: s?.recovery_score ?? null,
		hrv: s?.hrv_rmssd_milli ?? null,
		rhr: s?.resting_heart_rate ?? null,
		spo2: s?.spo2_percentage ?? null,
		skinTemp: s?.skin_temp_celsius ?? null,
		calibrating: s?.user_calibrating ?? null,
	};
}

export function cycleView(cycle: WhoopCycle) {
	const s = cycle.score;
	return {
		strain: s?.strain ?? null,
		calories: kcal(s?.kilojoule),
		avgHr: s?.average_heart_rate ?? null,
		maxHr: s?.max_heart_rate ?? null,
		steps: cycle.step_count ?? null,
		inProgress: cycle.end == null,
	};
}

export function workoutView(workout: WhoopWorkout) {
	const s = workout.score;
	const z = s?.zone_durations;
	const scored = workout.score_state === 'SCORED';
	return {
		scored,
		duration: Date.parse(workout.end) - Date.parse(workout.start),
		strain: scored ? s?.strain ?? null : null,
		avgHr: s?.average_heart_rate ?? null,
		maxHr: s?.max_heart_rate ?? null,
		calories: kcal(s?.kilojoule),
		recorded: s?.percent_recorded ?? null,
		distance: s?.distance_meter ?? null,
		gain: s?.altitude_gain_meter ?? null,
		change: s?.altitude_change_meter ?? null,
		zones: z ? [z.zone_zero_milli, z.zone_one_milli, z.zone_two_milli, z.zone_three_milli, z.zone_four_milli, z.zone_five_milli] : null,
		hard: z ? z.zone_four_milli + z.zone_five_milli : null,
	};
}
