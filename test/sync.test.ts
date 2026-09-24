import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WhoopDatabase } from '../src/database.js';
import { WhoopSync } from '../src/sync.js';
import type { WhoopClient } from '../src/whoop-client.js';

/** A WHOOP client whose fetches take a moment and record how many run at once. */
function slowClient(): { client: WhoopClient; stats: { fetches: number; concurrent: number; maxConcurrent: number } } {
	const stats = { fetches: 0, concurrent: 0, maxConcurrent: 0 };
	const fetchAll = async (): Promise<never[]> => {
		stats.fetches++;
		stats.concurrent++;
		stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.concurrent);
		await new Promise(resolve => setTimeout(resolve, 20));
		stats.concurrent--;
		return [];
	};
	const client = {
		getAllCycles: fetchAll,
		getAllRecoveries: fetchAll,
		getAllSleeps: fetchAll,
		getAllWorkouts: fetchAll,
	} as unknown as WhoopClient;
	return { client, stats };
}

describe('WhoopSync', () => {
	it('runs one sync when two tool calls arrive together', async () => {
		const { client, stats } = slowClient();
		const sync = new WhoopSync(client, new WhoopDatabase(':memory:'));

		const results = await Promise.all([sync.smartSync(), sync.smartSync()]);

		assert.deepEqual(results.map(result => result.type).sort(), ['full', 'skip']);
		assert.equal(stats.fetches, 4); // one sync: cycles, recoveries, sleeps, workouts
	});

	it('keeps the next sync waiting until a failed sync\'s other requests have finished', async t => {
		t.mock.method(process.stderr, 'write', () => true); // the expected "sync failed" log lines
		const { client, stats } = slowClient();
		// One endpoint fails at once; the other three are still in flight.
		(client as unknown as { getAllCycles: () => Promise<never> }).getAllCycles = async () => {
			throw new Error('Whoop API request failed: 500');
		};
		const sync = new WhoopSync(client, new WhoopDatabase(':memory:'));

		const [failed, next] = await Promise.allSettled([sync.syncDays(7), sync.syncDays(7)]);

		assert.equal(failed.status, 'rejected');
		assert.equal(next.status, 'rejected');
		assert.equal(stats.maxConcurrent, 3);
	});

	it('writes a failed sync to the server log', async t => {
		const { client } = slowClient();
		(client as unknown as { getAllSleeps: () => Promise<never> }).getAllSleeps = async () => {
			throw new Error('Whoop API request failed: 503 upstream unavailable');
		};
		const logged: string[] = [];
		t.mock.method(process.stderr, 'write', (chunk: string) => {
			logged.push(chunk);
			return true;
		});

		await assert.rejects(new WhoopSync(client, new WhoopDatabase(':memory:')).syncDays(7));

		assert.deepEqual(logged, ['Whoop sync failed: Whoop API request failed: 503 upstream unavailable\n']);
	});

	it('queues a full sync behind a running one instead of overlapping', async () => {
		const { client, stats } = slowClient();
		const sync = new WhoopSync(client, new WhoopDatabase(':memory:'));

		await Promise.all([sync.syncDays(7), sync.syncDays(90)]);

		assert.equal(stats.fetches, 8);
		assert.equal(stats.maxConcurrent, 4); // the four requests of one sync, never two syncs
	});
});
