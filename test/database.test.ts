import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WhoopDatabase } from '../src/database.js';
import type { WhoopWorkout } from '../src/types.js';

/** Shaped like the workout example in WHOOP's v2 API reference. */
function v2Workout(overrides: Partial<WhoopWorkout> = {}): WhoopWorkout {
	return {
		id: 'ecfc6a15-4661-442f-a9a4-f160dd7afae8',
		user_id: 9012,
		created_at: '2026-09-22T11:25:44.774Z',
		updated_at: '2026-09-22T14:25:44.774Z',
		start: '2026-09-22T02:25:44.774Z',
		end: '2026-09-22T03:25:44.774Z',
		timezone_offset: '-05:00',
		sport_id: 1,
		score_state: 'SCORED',
		score: {
			strain: 8.2463,
			average_heart_rate: 123,
			max_heart_rate: 146,
			kilojoule: 1569.34,
			percent_recorded: 100,
			zone_durations: {
				zone_zero_milli: 300000,
				zone_one_milli: 600000,
				zone_two_milli: 900000,
				zone_three_milli: 900000,
				zone_four_milli: 600000,
				zone_five_milli: 300000,
			},
		},
		...overrides,
	};
}

describe('stored workouts', () => {
	it('keep the heart-rate zones from a v2 workout', () => {
		const db = new WhoopDatabase(':memory:');
		db.upsertWorkouts([v2Workout()]);

		const [stored] = db.getWorkoutsByDateRange('2026-09-01', '2026-09-30');
		assert.equal(stored.zone_zero_milli, 300000);
		assert.equal(stored.zone_five_milli, 300000);
		assert.equal(stored.strain, 8.2463);
	});

	it('are stored even when WHOOP sends no zone data', () => {
		const db = new WhoopDatabase(':memory:');
		const workout = v2Workout();
		delete workout.score?.zone_durations;
		db.upsertWorkouts([workout]);

		const [stored] = db.getWorkoutsByDateRange('2026-09-01', '2026-09-30');
		assert.equal(stored.zone_zero_milli, null);
		assert.equal(stored.strain, 8.2463);
	});
});

const originalSecret = process.env.ENCRYPTION_SECRET;

describe('stored WHOOP tokens', () => {
	afterEach(() => {
		process.env.ENCRYPTION_SECRET = originalSecret;
	});

	it('read as "not connected" instead of crashing after the encryption key changes', t => {
		t.mock.method(process.stderr, 'write', () => true); // the expected "could not be decrypted" warning
		const db = new WhoopDatabase(':memory:');
		process.env.ENCRYPTION_SECRET = 'key-before-rotation';
		db.saveTokens({ access_token: 'access', refresh_token: 'refresh', expires_at: Date.now() + 3_600_000 });

		process.env.ENCRYPTION_SECRET = 'key-after-rotation';
		assert.equal(db.getTokens(), null);

		// Reconnecting stores fresh tokens under the new key.
		db.saveTokens({ access_token: 'new-access', refresh_token: 'new-refresh', expires_at: Date.now() + 3_600_000 });
		assert.equal(db.getTokens()?.access_token, 'new-access');
	});
});
