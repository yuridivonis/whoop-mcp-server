import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { problems, tables } from '../scripts/answer-rules.mjs';

const CLEAN = `# Recovery Trends (Last 7 Days)

## Daily

| Date | Recovery | HRV (ms) |
|------|----------|----------|
| Sat, Oct 4 | 64% 🟡 | 45.2 |
| Fri, Oct 3 | – | 50.0 |
| Thu, Oct 2 (UTC) | 71% 🟢 | 48.9 |

## Averages (2 of 3 days scored)

Recovery 67.5%, HRV 48.0 ms.

🟢 67–100% green · 🟡 34–66% yellow · 🔴 1–33% red`;

describe('the answer rules', () => {
	it('pass a well-formed answer, and read its tables', () => {
		assert.deepEqual(problems(CLEAN), []);
		const [table] = tables(CLEAN);
		assert.deepEqual(table.header, ['Date', 'Recovery', 'HRV (ms)']);
		assert.equal(table.rows.length, 3);
		assert.equal(table.line, 5);
	});

	it('reject an empty answer', () => {
		assert.deepEqual(problems(''), ['empty answer']);
		assert.deepEqual(problems('  \n'), ['empty answer']);
	});

	it('catch the values a bug leaks through formatting, as cells or words, not inside other words', () => {
		assert.deepEqual(problems('| Date | HRV |\n|---|---|\n| Sat, Oct 4 | NaN |'), ['contains "NaN"']);
		assert.deepEqual(problems('Recovery: undefined%'), ['contains "undefined"']);
		assert.deepEqual(problems('HRV -0 ms'), ['contains a negative zero like "-0" or "-0.4"']);
		assert.deepEqual(problems('Skin temp -0.4 °C'), ['contains a negative zero like "-0" or "-0.4"']);
		assert.deepEqual(problems('Skin temp −0.4 °C, a 10-0 week'), [], 'a real minus sign is a real negative; 10-0 is not a zero');
		assert.deepEqual(problems('Steps: N/A today'), ['contains "N/A"']);
		assert.deepEqual(problems('Woke on Invalid Date'), ['contains "Invalid Date"']);
		assert.deepEqual(problems('Nana napped on a null-steps day, then the Infinity Pool run'), ['contains "Infinity"'], 'words containing or joined to a forbidden one are fine');
		assert.deepEqual(problems('Steps: null'), ['contains "null"']);
	});

	it('catch a ragged table, an empty cell, and a legend glued to a table', () => {
		assert.deepEqual(problems('| Date | HRV |\n|---|---|\n| Sat, Oct 4 | 45 | extra |'), ['table at line 1: row 1 has 3 cells, the header 2']);
		assert.deepEqual(problems('| Date | HRV |\n|---|---|\n| Sat, Oct 4 |  |'), ['an empty table cell']);
		assert.deepEqual(problems('| Date | HRV |\n|---|---|\n| Sat, Oct 4 | 45 |\n🟢 legend'), ['line 4 follows a table without a blank line']);
		assert.deepEqual(problems('| Date | HRV |\n|---|---|\n| Sat, Oct 4 | 45 |\n\n🟢 legend'), []);
	});

	it('require dates newest first, allowing a repeated day and a year boundary', () => {
		assert.deepEqual(problems('| Date | HRV |\n|---|---|\n| Fri, Oct 3 | 45 |\n| Sat, Oct 4 | 45 |'), ['table at line 1: dates are not newest first (row 2)']);
		assert.deepEqual(problems('| Date | HRV |\n|---|---|\n| Sat, Oct 4 | 45 |\n| Sat, Oct 4 | 45 |\n| Fri, Oct 3 | 45 |'), []);
		assert.deepEqual(problems('| Date | HRV |\n|---|---|\n| Thu, Jan 1 | 45 |\n| Wed, Dec 31 | 45 |'), []);
		assert.deepEqual(problems('| Date | HRV |\n|---|---|\n| Sat, Oct 4 (day in progress) | 45 |\n| Fri, Oct 3 (UTC) | 45 |'), []);
	});
});
