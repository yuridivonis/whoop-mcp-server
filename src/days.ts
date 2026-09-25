/**
 * Which calendar day a Whoop record belongs to, in the member's own timezone.
 *
 * Whoop reports times in UTC together with the timezone offset where they were recorded
 * (e.g. "+08:00"). Labelling by the UTC date shows a Singapore night as the day before;
 * these helpers label by the local date instead.
 */

const OFFSET = /^([+-])(\d{2}):?(\d{2})$/;
let warnedUnreadableOffset = false;

function offsetMinutes(offset: string | null): number {
	if (!offset) return 0;
	const match = OFFSET.exec(offset);
	if (!match) {
		// A format change at Whoop would shift every day; say so once instead of silently.
		if (!warnedUnreadableOffset) {
			warnedUnreadableOffset = true;
			process.stderr.write(`Unrecognised Whoop timezone offset ${JSON.stringify(offset.slice(0, 20))}; dating days in UTC instead.\n`);
		}
		return 0;
	}
	const minutes = Number(match[2]) * 60 + Number(match[3]);
	return match[1] === '-' ? -minutes : minutes;
}

function shifted(iso: string, offset: string | null, shiftHours: number): string {
	return new Date(Date.parse(iso) + (offsetMinutes(offset) + shiftHours * 60) * 60_000).toISOString();
}

/** The local date (YYYY-MM-DD) of a UTC timestamp, optionally shifted by some hours. */
export function localDate(iso: string, offset: string | null, shiftHours = 0): string {
	return shifted(iso, offset, shiftHours).slice(0, 10);
}

/** The local time of day (HH:MM) of a UTC timestamp. */
export function localTime(iso: string, offset: string | null): string {
	return shifted(iso, offset, 0).slice(11, 16);
}

/**
 * A sleep starts a Whoop cycle, and both belong to the day you wake up into. Twelve hours
 * after falling asleep is safely inside that day, whether you went to bed before or after
 * midnight. One rule for both keeps a day's sleep, recovery and strain together, even for
 * an afternoon sleep after a night shift.
 */
export function wakeDay(sleepStart: string, offset: string | null): string {
	return localDate(sleepStart, offset, 12);
}
