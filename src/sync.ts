import type { WhoopClient } from './whoop-client.js';
import type { WhoopDatabase } from './database.js';

interface SyncStats {
	cycles: number;
	recoveries: number;
	sleeps: number;
	workouts: number;
}

interface SmartSyncResult {
	type: 'full' | 'quick' | 'skip';
	stats?: SyncStats;
}

function valueOf<T>(result: PromiseSettledResult<T>): T {
	if (result.status === 'rejected') throw result.reason;
	return result.value;
}

export class WhoopSync {
	private readonly client: WhoopClient;
	private readonly db: WhoopDatabase;
	/** Syncs never overlap: two tool calls at once would double the load on the WHOOP API. */
	private inFlight: Promise<SyncStats> | null = null;

	constructor(client: WhoopClient, db: WhoopDatabase) {
		this.client = client;
		this.db = db;
	}

	async syncDays(days = 90): Promise<SyncStats> {
		while (this.inFlight) {
			await this.inFlight.catch(() => {});
		}

		const run = this.runSync(days);
		this.inFlight = run;
		try {
			return await run;
		} catch (error) {
			// Tools report the failure to the user; this puts it in the server logs too.
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`Whoop sync failed: ${message}\n`);
			throw error;
		} finally {
			this.inFlight = null;
		}
	}

	private async runSync(days: number): Promise<SyncStats> {
		const endDate = new Date();
		const startDate = new Date();
		startDate.setDate(startDate.getDate() - days);

		const start = startDate.toISOString();
		const end = endDate.toISOString();

		// allSettled, not all: when one request fails early, the sync must still wait for the
		// other three, or the next sync would start while they are running.
		const settled = await Promise.allSettled([
			this.client.getAllCycles({ start, end }),
			this.client.getAllRecoveries({ start, end }),
			this.client.getAllSleeps({ start, end }),
			this.client.getAllWorkouts({ start, end }),
		]);
		const cycles = valueOf(settled[0]);
		const recoveries = valueOf(settled[1]);
		const sleeps = valueOf(settled[2]);
		const workouts = valueOf(settled[3]);

		if (cycles.length > 0) this.db.upsertCycles(cycles);
		if (recoveries.length > 0) this.db.upsertRecoveries(recoveries);
		if (sleeps.length > 0) this.db.upsertSleeps(sleeps);
		if (workouts.length > 0) this.db.upsertWorkouts(workouts);

		this.db.updateSyncState(
			startDate.toISOString().split('T')[0],
			endDate.toISOString().split('T')[0]
		);

		return {
			cycles: cycles.length,
			recoveries: recoveries.length,
			sleeps: sleeps.length,
			workouts: workouts.length,
		};
	}

	async quickSync(): Promise<SyncStats> {
		return this.syncDays(7);
	}

	/**
	 * Called before every data tool: the first sync pulls 90 days, later ones refresh the
	 * last 7 days, and data synced within the hour is left alone.
	 */
	async smartSync(): Promise<SmartSyncResult> {
		// A sync already running will leave the data fresh; wait for it (and surface its
		// failure) instead of queueing another.
		if (this.inFlight) {
			await this.inFlight;
			return { type: 'skip' };
		}

		const state = this.db.getSyncState();

		if (!state.lastSyncAt) {
			const stats = await this.syncDays(90);
			return { type: 'full', stats };
		}

		const lastSync = new Date(state.lastSyncAt);
		const hoursSinceSync = (Date.now() - lastSync.getTime()) / (1000 * 60 * 60);

		if (hoursSinceSync < 1) {
			return { type: 'skip' };
		}

		const stats = await this.quickSync();
		return { type: 'quick', stats };
	}
}
