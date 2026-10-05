/**
 * Rules every tool answer must satisfy, whatever the data: well-formed tables, no value
 * that is a bug in disguise, dates in order. Shared by the tests and the live check, so a
 * rule learnt from one applies to both. Plain JavaScript on purpose: the live check runs
 * without a build step.
 */

/** The strings a cell must never be: each one is a bug leaking through the formatting. */
export const FORBIDDEN_CELLS = ['NaN', 'undefined', 'null', 'N/A', 'Invalid Date', 'Infinity', '-Infinity'];

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** The Markdown tables in an answer: header cells and rows of cells. */
export function tables(text) {
	const found = [];
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i].startsWith('| ') || !/^\|[-|]+\|$/.test(lines[i + 1] ?? '')) continue;
		const cells = line => line.slice(1, -1).split(' | ').map(cell => cell.trim());
		const header = cells(lines[i]);
		const rows = [];
		for (let j = i + 2; j < lines.length && lines[j].startsWith('| '); j++) rows.push(cells(lines[j]));
		found.push({ header, rows, line: i + 1 });
		i += 1 + rows.length;
	}
	return found;
}

/** "Thu, Oct 1" (with any suffix such as "(UTC)" or "(day in progress)") as a comparable month-day number, or null. */
function monthDay(cell) {
	const match = /^\w{3}, (\w{3}) (\d{1,2})/.exec(cell);
	return match ? MONTHS[match[1]] * 100 + Number(match[2]) : null;
}

/**
 * Everything wrong with an answer, as messages; an empty list means it passes. `text` is
 * one tool's Markdown answer.
 */
export function problems(text) {
	const found = [];
	if (!text || !text.trim()) return ['empty answer'];
	for (const bad of FORBIDDEN_CELLS) {
		// As a whole cell or a whole token, so "N/A" in prose counts and "Nana" doesn't.
		const token = new RegExp(`(^|[\\s|(])${bad.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}(?=$|[\\s|)%,.])`, 'm');
		if (token.test(text)) found.push(`contains "${bad}"`);
	}
	if (/(^|[\s|(])-0(\.0+)?(?=$|[\s|)%,]|\.(?!\d))/m.test(text)) found.push('contains a negative zero like "-0" or "-0.0"');
	if (/\|[ \t]*\|/.test(text)) found.push('an empty table cell');
	for (const table of tables(text)) {
		for (const [n, row] of table.rows.entries()) {
			if (row.length !== table.header.length) found.push(`table at line ${table.line}: row ${n + 1} has ${row.length} cells, the header ${table.header.length}`);
		}
		// Dates descend within a table (allowing the same day twice: two workouts, a night and a nap).
		const days = table.rows.map(row => monthDay(row[0])).filter(value => value !== null);
		for (let i = 1; i < days.length; i++) {
			// The one allowed increase is a year boundary: a period of up to 90 days can step from
			// January to March back into October to December.
			if (days[i] > days[i - 1] && !(days[i] >= 900 && days[i - 1] < 300)) {
				found.push(`table at line ${table.line}: dates are not newest first (row ${i + 1})`);
				break;
			}
		}
	}
	// A legend or sentence glued to a table becomes a table row in Markdown.
	const lines = text.split('\n');
	for (let i = 1; i < lines.length; i++) {
		if (lines[i - 1].startsWith('| ') && lines[i].trim() && !lines[i].startsWith('|') && !lines[i].startsWith('#')) {
			found.push(`line ${i + 1} follows a table without a blank line`);
		}
	}
	return found;
}
