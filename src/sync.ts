import { WhoopClient } from './whoop-client.js';
import { WhoopDatabase } from './database.js';

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

		const [cycles, recoveries, sleeps, workouts] = await Promise.all([
			this.client.getAllCycles({ start, end }),
			this.client.getAllRecoveries({ start, end }),
			this.client.getAllSleeps({ start, end }),
			this.client.getAllWorkouts({ start, end }),
		]);

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

	needsFullSync(): boolean {
		const state = this.db.getSyncState();
		if (!state.lastSyncAt) return true;

		const lastSync = new Date(state.lastSyncAt);
		const hoursSinceSync = (Date.now() - lastSync.getTime()) / (1000 * 60 * 60);
		return hoursSinceSync > 24;
	}

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
