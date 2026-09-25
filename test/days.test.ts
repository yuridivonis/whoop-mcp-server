import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cycleDay, localDate, sleepDay } from '../src/days.js';

describe('local days', () => {
	it('dates a cycle by the day you wake up into, not the night it started', () => {
		// 23:30 in Singapore on the 24th, which is still the 24th in UTC.
		assert.equal(cycleDay('2026-09-24T15:30:00.000Z', '+08:00'), '2026-09-25');
		// 23:30 in New York on the 24th, which is already the 25th in UTC.
		assert.equal(cycleDay('2026-09-25T03:30:00.000Z', '-04:00'), '2026-09-25');
		// Going to bed after midnight doesn't push the day forward twice.
		assert.equal(cycleDay('2026-09-24T17:30:00.000Z', '+08:00'), '2026-09-25');
	});

	it('dates a sleep by the morning you wake up', () => {
		assert.equal(sleepDay('2026-09-24T23:10:00.000Z', '+08:00'), '2026-09-25');
	});

	it('falls back to UTC when the offset is missing or unreadable', () => {
		assert.equal(localDate('2026-09-24T23:10:00.000Z', null), '2026-09-24');
		assert.equal(localDate('2026-09-24T23:10:00.000Z', 'Asia/Singapore'), '2026-09-24');
		assert.equal(localDate('2026-09-24T23:10:00.000Z', '+0800'), '2026-09-25');
	});
});
