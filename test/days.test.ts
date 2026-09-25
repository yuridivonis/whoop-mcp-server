import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { localDate, localTime, wakeDay } from '../src/days.js';

describe('local days', () => {
	it('dates a night by the day you wake up into, not the night it started', () => {
		// 23:30 in Singapore on the 24th, which is still the 24th in UTC.
		assert.equal(wakeDay('2026-09-24T15:30:00.000Z', '+08:00'), '2026-09-25');
		// 23:30 in New York on the 24th, which is already the 25th in UTC.
		assert.equal(wakeDay('2026-09-25T03:30:00.000Z', '-04:00'), '2026-09-25');
		// Going to bed after midnight doesn't push the day forward twice.
		assert.equal(wakeDay('2026-09-24T17:30:00.000Z', '+08:00'), '2026-09-25');
	});

	it('keeps an afternoon sleep after a night shift with the day it starts', () => {
		// Asleep 13:00 to 21:00 in Singapore on the 24th: that cycle runs into the 25th.
		assert.equal(wakeDay('2026-09-24T05:00:00.000Z', '+08:00'), '2026-09-25');
	});

	it('gives the local time of day', () => {
		assert.equal(localTime('2026-09-24T16:30:00.000Z', '+08:00'), '00:30');
		assert.equal(localTime('2026-09-24T16:30:00.000Z', '-05:00'), '11:30');
	});

	it('falls back to UTC for a missing or unreadable offset, and says so once', t => {
		const logged: string[] = [];
		t.mock.method(process.stderr, 'write', (line: string) => {
			logged.push(line);
			return true;
		});

		assert.equal(localDate('2026-09-24T23:10:00.000Z', null), '2026-09-24');
		assert.equal(localDate('2026-09-24T23:10:00.000Z', '+0800'), '2026-09-25');
		assert.equal(localDate('2026-09-24T23:10:00.000Z', 'Asia/Singapore'), '2026-09-24');
		assert.equal(localDate('2026-09-24T23:10:00.000Z', 'Asia/Singapore'), '2026-09-24');

		assert.equal(logged.length, 1);
		assert.match(logged[0], /Unrecognised Whoop timezone offset "Asia\/Singapore"/);
	});
});
