/**
 * The WHOOP client's day helpers, plus a warning in the server's log when WHOOP sends a
 * timezone offset they can't read. The library quietly dates such records in UTC; here
 * the operator hears about it once, since a format change at WHOOP would shift every day.
 */
import {
	localDate as clientLocalDate,
	localTime as clientLocalTime,
	parseOffset,
	wakeDay as clientWakeDay,
} from '@yuridivonis/whoop-client';

let warnedUnreadableOffset = false;

function warnIfUnreadable(offset: string | null): void {
	if (warnedUnreadableOffset || parseOffset(offset) !== null) return;
	warnedUnreadableOffset = true;
	process.stderr.write(`Unrecognised Whoop timezone offset ${JSON.stringify(String(offset).slice(0, 20))}; dating days in UTC instead.\n`);
}

/** The local date (YYYY-MM-DD) of a UTC timestamp. */
export function localDate(iso: string, offset: string | null): string {
	warnIfUnreadable(offset);
	return clientLocalDate(iso, offset);
}

/** The local time of day (HH:MM) of a UTC timestamp. */
export function localTime(iso: string, offset: string | null): string {
	warnIfUnreadable(offset);
	return clientLocalTime(iso, offset);
}

/** The day a night of sleep, and the cycle it starts, belong to: the day you wake up into. */
export function wakeDay(sleepStart: string, offset: string | null): string {
	warnIfUnreadable(offset);
	return clientWakeDay(sleepStart, offset);
}
