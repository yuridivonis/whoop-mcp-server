import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { localDate, localTime, wakeDay } from '../src/days.js';

describe("the server's day helpers", () => {
	it('date records like the WHOOP client does', () => {
		assert.equal(localDate('2026-09-24T23:10:00.000Z', '+08:00'), '2026-09-25');
		assert.equal(localTime('2026-09-24T16:30:00.000Z', '+08:00'), '00:30');
		assert.equal(wakeDay('2026-09-24T15:30:00.000Z', '+08:00'), '2026-09-25');
	});

	it("fall back to UTC for an offset they can't read, and say so in the log once", t => {
		const logged: string[] = [];
		t.mock.method(process.stderr, 'write', (line: string) => {
			logged.push(line);
			return true;
		});

		assert.equal(localDate('2026-09-24T23:10:00.000Z', null), '2026-09-24');
		assert.equal(localDate('2026-09-24T23:10:00.000Z', 'Asia/Singapore'), '2026-09-24');
		assert.equal(wakeDay('2026-09-24T23:10:00.000Z', 'Asia/Singapore'), '2026-09-25');
		assert.equal(localTime('2026-09-24T23:10:00.000Z', 'Asia/Singapore'), '23:10');

		assert.equal(logged.length, 1);
		assert.match(logged[0], /Unrecognised Whoop timezone offset "Asia\/Singapore"; dating days in UTC instead\./);
	});
});
