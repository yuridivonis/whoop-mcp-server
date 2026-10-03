import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MISSING, distance, formatDuration, num, recoveryZone, strainZone, table } from '../src/render.js';

describe('render', () => {
	it('labels zones by the number as printed, so the label never contradicts it', () => {
		assert.equal(strainZone(9.96), 'Moderate (10-13)', '9.96 prints as 10.0');
		assert.equal(strainZone(9.94), 'Light (0-9)');
		assert.equal(strainZone(13.97), 'High (14-17)');
		assert.equal(strainZone(17.96), 'All Out (18-21)');
		assert.equal(recoveryZone(66.6), 'Green (Well Recovered)', '66.6 prints as 67%');
		assert.equal(recoveryZone(66.4), 'Yellow (Moderate)');
		assert.equal(recoveryZone(33.5), 'Yellow (Moderate)');
		assert.equal(recoveryZone(33.4), 'Red (Needs Rest)');
	});

	it('formats durations with two-digit minutes, a credit with a minus, and nothing as a dash', () => {
		assert.equal(formatDuration(7 * 3_600_000), '7h 00m');
		assert.equal(formatDuration(5 * 60_000), '0h 05m');
		assert.equal(formatDuration(-300_000), '− 0h 05m');
		assert.equal(formatDuration(0), '0h 00m');
		assert.equal(formatDuration(null), MISSING);
		assert.equal(formatDuration(Number.NaN), MISSING);
	});

	it('never prints minus zero, and rounds distance to a whole metre or a tenth of a kilometre', () => {
		assert.equal(num(-0.4), '0');
		assert.equal(num(-0.6), '-1');
		assert.equal(distance(999.6), '1000 m');
		assert.equal(distance(1000), '1.0 km');
		assert.equal(distance(null), MISSING);
	});

	it('drops an optional column nobody fills, and keeps every other column even when empty', () => {
		const out = table(['Date', 'Asleep', 'Steps'], [['Mon', MISSING, MISSING], ['Tue', '7h 00m', MISSING]]);
		assert.equal(out, '| Date | Asleep |\n|---|---|\n| Mon | – |\n| Tue | 7h 00m |\n');
		assert.match(table(['Date', 'Steps'], [['Mon', '12']]), /\| Date \| Steps \|/);
	});
});
