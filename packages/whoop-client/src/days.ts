/**
 * Which calendar day a WHOOP record belongs to, in the member's own timezone.
 *
 * WHOOP reports times in UTC together with the timezone offset where they were recorded
 * (e.g. "+08:00"). Labelling by the UTC date shows a Singapore night as the day before;
 * these helpers label by the local date instead. An offset they can't read counts as UTC:
 * check it with parseOffset() if that matters to you.
 */

const OFFSET = /^([+-])(\d{2}):?(\d{2})$/;

/**
 * Minutes east of UTC for a WHOOP timezone offset such as "+08:00" or "-0500". 0 when there
 * is no offset; null when there is one but it can't be read.
 */
export function parseOffset(offset: string | null): number | null {
	if (!offset) return 0;
	const match = OFFSET.exec(offset);
	if (!match) return null;
	const minutes = Number(match[2]) * 60 + Number(match[3]);
	return match[1] === '-' ? -minutes : minutes;
}

function shifted(iso: string, offset: string | null, shiftHours: number): string {
	return new Date(Date.parse(iso) + ((parseOffset(offset) ?? 0) + shiftHours * 60) * 60_000).toISOString();
}

/** The local date (YYYY-MM-DD) of a UTC timestamp. */
export function localDate(iso: string, offset: string | null): string {
	return shifted(iso, offset, 0).slice(0, 10);
}

/** The local time of day (HH:MM) of a UTC timestamp. */
export function localTime(iso: string, offset: string | null): string {
	return shifted(iso, offset, 0).slice(11, 16);
}

/**
 * A sleep starts a WHOOP cycle, and both belong to the day you wake up into. Twelve hours
 * after falling asleep is safely inside that day, whether you went to bed before or after
 * midnight. One rule for both keeps a day's sleep, recovery and strain together, even for
 * an afternoon sleep after a night shift.
 */
export function wakeDay(sleepStart: string, offset: string | null): string {
	return shifted(sleepStart, offset, 12).slice(0, 10);
}
