/**
 * Which calendar day a Whoop record belongs to, in the member's own timezone.
 *
 * Whoop reports times in UTC together with the timezone offset where they were recorded
 * (e.g. "+08:00"). Labelling by the UTC date shows a Singapore night as the day before;
 * these helpers label by the local date instead.
 */

const OFFSET = /^([+-])(\d{2}):?(\d{2})$/;

function offsetMinutes(offset: string | null): number {
	const match = offset ? OFFSET.exec(offset) : null;
	if (!match) return 0;
	const minutes = Number(match[2]) * 60 + Number(match[3]);
	return match[1] === '-' ? -minutes : minutes;
}

/** The local date (YYYY-MM-DD) of a UTC timestamp, optionally shifted by some hours. */
export function localDate(iso: string, offset: string | null, shiftHours = 0): string {
	const shifted = Date.parse(iso) + (offsetMinutes(offset) + shiftHours * 60) * 60_000;
	return new Date(shifted).toISOString().slice(0, 10);
}

/**
 * A cycle starts when you fall asleep, so it belongs to the day you wake up into.
 * Twelve hours after falling asleep is safely inside that day, whether you went to bed
 * before or after midnight.
 */
export function cycleDay(start: string, offset: string | null): string {
	return localDate(start, offset, 12);
}

/** A sleep belongs to the day you wake up from it. */
export function sleepDay(end: string, offset: string | null): string {
	return localDate(end, offset);
}
