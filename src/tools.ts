import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { WhoopAuthError, type WhoopClient } from './whoop-client.js';
import type { WhoopDatabase } from './database.js';
import type { WhoopSync } from './sync.js';
import type { PendingAuthStates } from './auth-states.js';
import { localDate, localTime } from './days.js';

export const SERVER_VERSION = '1.1.2';

export interface ToolDeps {
	db: WhoopDatabase;
	client: WhoopClient;
	sync: WhoopSync;
	authStates: PendingAuthStates;
	redirectUri: string;
	/** In stdio mode there is no /callback, so get_auth_url explains how to connect instead. */
	mode: 'http' | 'stdio';
}

interface ToolArguments {
	days?: number;
	full?: boolean;
}

const NOT_AUTHENTICATED = 'Not authenticated with Whoop. Use get_auth_url to authorize first.';

function formatDuration(millis: number | null): string {
	if (!millis) return 'N/A';
	const hours = Math.floor(millis / 3_600_000);
	const minutes = Math.floor((millis % 3_600_000) / 60_000);
	return `${hours}h ${minutes}m`;
}

/** Formats a local day (YYYY-MM-DD). In UTC, so the server's own timezone can't shift it. */
function formatDate(day: string): string {
	return new Date(`${day.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		timeZone: 'UTC',
	});
}

/** "functional-fitness" → "Functional fitness". */
function sportName(name: string | null, sportId: number): string {
	if (!name) return `Activity ${sportId}`;
	const words = name.replace(/[-_]+/g, ' ').trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

// Only the data the tools use. `offline` keeps the connection alive with refresh tokens.
const WHOOP_SCOPES = ['read:cycles', 'read:recovery', 'read:sleep', 'read:workout', 'offline'];

/** Sent to clients when they connect: how the tools fit together. */
const SERVER_INSTRUCTIONS =
	"Answers questions about the user's WHOOP data: recovery, sleep, strain and workouts. Start with get_today for how the " +
	'user is doing today. For patterns over several days, use get_recovery_trends, get_sleep_analysis, get_strain_history ' +
	'or get_workouts. Data refreshes from WHOOP automatically when it is over an hour old, so sync_data is rarely needed. ' +
	"If a tool says WHOOP isn't connected, call get_auth_url and pass its answer to the user. Days are the user's local days, " +
	"and a night of sleep counts toward the day they woke up. Nothing here changes the user's WHOOP data.";

/** Appended to each data tool's description, so an agent knows what calling it involves. */
const DATA_TOOL_BEHAVIOR =
	" Read-only: it never changes the user's WHOOP data. Before answering, it refreshes the local copy from WHOOP if the last " +
	'sync is over an hour old; if WHOOP is unreachable, it answers from the last sync and says so. If WHOOP isn\'t connected ' +
	'yet, it returns a message asking to call get_auth_url.';

const DATA_TOOL_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const DAYS_PARAMETER = {
	type: 'integer',
	minimum: 1,
	maximum: 90,
	default: 14,
	description: 'How many days to cover, counting back from today: 1 to 90, default 14.',
};

function getRecoveryZone(score: number): string {
	if (score >= 67) return 'Green (Well Recovered)';
	if (score >= 34) return 'Yellow (Moderate)';
	return 'Red (Needs Rest)';
}

function getStrainZone(strain: number): string {
	if (strain >= 18) return 'All Out (18-21)';
	if (strain >= 14) return 'High (14-17)';
	if (strain >= 10) return 'Moderate (10-13)';
	return 'Light (0-9)';
}

function validateDays(value: unknown): number {
	if (value === undefined || value === null) return 14;
	const num = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
	if (Number.isNaN(num) || num < 1) return 14;
	return Math.min(num, 90);
}

function validateBoolean(value: unknown): boolean {
	if (typeof value === 'boolean') return value;
	if (value === 'true') return true;
	return false;
}

function text(value: string): CallToolResult {
	return { content: [{ type: 'text', text: value }] };
}

/** Explains why the data shown may be stale, instead of silently serving the cache. */
function syncFailureNote(error: unknown): string {
	if (error instanceof WhoopAuthError) {
		return `Note: ${error.message} Showing previously synced data.\n\n`;
	}
	const message = error instanceof Error ? error.message : 'Unknown error';
	return `Note: could not refresh data from Whoop (${message}). Showing previously synced data.\n\n`;
}

export function createMcpServer({ db, client, sync, authStates, redirectUri, mode }: ToolDeps): Server {
	const server = new Server(
		{ name: 'whoop-mcp-server', version: SERVER_VERSION },
		{ capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			{
				name: 'get_today',
				title: "Today's WHOOP summary",
				description:
					"Returns the user's latest WHOOP status as Markdown: the most recent recovery (score %, Green/Yellow/Red zone, HRV in " +
					"ms, resting heart rate, SpO2, skin temperature), last night's sleep (time asleep, performance, efficiency, " +
					"light/deep/REM stages, respiratory rate) and today's strain so far (0–21) with calories and heart rate. Use it first for questions like " +
					'"how am I today?" or "should I train hard?". For more than one day, use get_recovery_trends, get_sleep_analysis, ' +
					'get_strain_history or get_workouts.' +
					DATA_TOOL_BEHAVIOR,
				inputSchema: { type: 'object', properties: {}, required: [] },
				annotations: DATA_TOOL_ANNOTATIONS,
			},
			{
				name: 'get_recovery_trends',
				title: 'Recovery trends',
				description:
					'Returns daily recovery for the last `days` days (default 14), newest first, as a Markdown table: recovery score (%), ' +
					"HRV (ms) and resting heart rate (bpm) for each of the user's local days, then averages. Days WHOOP hasn't scored " +
					'are left out. Use it for patterns and comparisons, such as ' +
					'"how has my HRV changed this month?". For today alone, use get_today; for the sleep behind the numbers, use ' +
					'get_sleep_analysis.' +
					DATA_TOOL_BEHAVIOR,
				inputSchema: { type: 'object', properties: { days: DAYS_PARAMETER }, required: [] },
				annotations: DATA_TOOL_ANNOTATIONS,
			},
			{
				name: 'get_sleep_analysis',
				title: 'Sleep analysis',
				description:
					'Returns nightly sleep for the last `days` days (default 14), newest first, as a Markdown table: time asleep in ' +
					'hours (light, deep and REM sleep, not time in bed), sleep performance (%) and efficiency (%), then averages. Naps ' +
					"and nights WHOOP hasn't scored are left out, and each night counts toward the day the user woke up. Use it for " +
					"sleep patterns. For last night's stages, use get_today; for the recovery those nights produced, use " +
					'get_recovery_trends.' +
					DATA_TOOL_BEHAVIOR,
				inputSchema: { type: 'object', properties: { days: DAYS_PARAMETER }, required: [] },
				annotations: DATA_TOOL_ANNOTATIONS,
			},
			{
				name: 'get_strain_history',
				title: 'Strain history',
				description:
					'Returns daily strain for the last `days` days (default 14), including today so far, newest first, as a Markdown ' +
					'table: WHOOP day strain (0–21, covering all activity that day) and calories burned (kcal), then averages. Days ' +
					'without a strain score are left out. Use it for overall load and activity trends. For individual ' +
					'training sessions, use get_workouts; for how the body coped, use get_recovery_trends.' +
					DATA_TOOL_BEHAVIOR,
				inputSchema: { type: 'object', properties: { days: DAYS_PARAMETER }, required: [] },
				annotations: DATA_TOOL_ANNOTATIONS,
			},
			{
				name: 'get_workouts',
				title: 'Recent workouts',
				description:
					'Returns individual workouts from the last `days` days (default 14), newest first, as a Markdown table: local date ' +
					'and start time, activity, duration, strain (or "unscored" when WHOOP hasn\'t scored it), average and max heart rate, time in heart-rate ' +
					'zones 4–5 and calories, then totals. Use it for questions about specific sessions or training volume; for ' +
					'whole-day strain including activity outside workouts, use get_strain_history.' +
					DATA_TOOL_BEHAVIOR,
				inputSchema: { type: 'object', properties: { days: DAYS_PARAMETER }, required: [] },
				annotations: DATA_TOOL_ANNOTATIONS,
			},
			{
				name: 'sync_data',
				title: 'Sync WHOOP data',
				description:
					"Pulls the latest data from WHOOP into the server's local copy and reports how many cycles, recoveries, sleeps " +
					'and workouts it saved. Rarely needed: the other tools already refresh data that is over an hour old. Call it with ' +
					'full: true to refresh right away (for example, for a workout that just ended), or to re-download the last 90 days ' +
					'if the automatic sync after connecting failed; without full, it only syncs if the last sync was over an hour ago. ' +
					"It never changes the user's WHOOP data or deletes anything, so running it again is harmless. If WHOOP isn't " +
					'connected, it asks for get_auth_url.',
				inputSchema: {
					type: 'object',
					properties: {
						full: {
							type: 'boolean',
							default: false,
							description: 'true re-downloads the last 90 days now. false (the default) syncs only if the last sync was over an hour ago.',
						},
					},
					required: [],
				},
				// Writes to the server's own cache, never to WHOOP.
				annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
			},
			{
				name: 'get_auth_url',
				title: 'Connect WHOOP account',
				description:
					"Returns a one-time link that connects the user's WHOOP account to this server through WHOOP's own login. Use it " +
					"when a data tool such as get_today says WHOOP isn't connected or its authorization expired. Give the link to the " +
					'user to open in a browser: it works once and expires in 10 minutes. Once they have ' +
					'logged in, the last 90 days sync automatically and get_today works. ' +
					"It doesn't read any WHOOP data. A server running in stdio mode can't receive WHOOP's login, so there it returns " +
					'setup instructions instead.',
				inputSchema: { type: 'object', properties: {}, required: [] },
				// Nothing changes until the user opens the link.
				annotations: { readOnlyHint: true, openWorldHint: false },
			},
		],
	}));

	server.setRequestHandler(CallToolRequestSchema, async request => {
		const { name, arguments: args } = request.params;
		const typedArgs = (args ?? {}) as ToolArguments;

		try {
			let note = '';
			const dataTools = ['get_today', 'get_recovery_trends', 'get_sleep_analysis', 'get_strain_history', 'get_workouts'];
			if (dataTools.includes(name)) {
				if (!db.getTokens()) {
					return text(NOT_AUTHENTICATED);
				}
				try {
					await sync.smartSync();
				} catch (error) {
					note = syncFailureNote(error);
				}
			}

			switch (name) {
				case 'get_today': {
					const recovery = db.getLatestRecovery();
					const sleep = db.getLatestSleep();
					const cycle = db.getLatestCycle();

					if (!recovery && !sleep && !cycle) {
						return text(`${note}No data available. Try running sync_data first.`);
					}

					let response = `${note}# Today's Whoop Summary\n\n`;

					if (recovery) {
						response += `## Recovery: ${recovery.recovery_score ?? 'N/A'}% ${recovery.recovery_score ? getRecoveryZone(recovery.recovery_score) : ''}\n`;
						response += `- **HRV**: ${recovery.hrv_rmssd?.toFixed(1) ?? 'N/A'} ms\n`;
						response += `- **Resting HR**: ${recovery.resting_hr ?? 'N/A'} bpm\n`;
						if (recovery.spo2) response += `- **SpO2**: ${recovery.spo2.toFixed(1)}%\n`;
						if (recovery.skin_temp) response += `- **Skin Temp**: ${recovery.skin_temp.toFixed(1)}°C\n`;
						response += '\n';
					}

					if (sleep) {
						// Time asleep is the sum of the stages. In bed minus awake would also count
						// the time the strap recorded no data. A missing stage shows N/A, as in get_sleep_analysis.
						const { total_light_milli: light, total_deep_milli: deep, total_rem_milli: rem } = sleep;
						const totalSleep = light === null || deep === null || rem === null ? null : light + deep + rem;
						response += `## Last Night's Sleep\n`;
						response += `- **Total Sleep**: ${formatDuration(totalSleep)}\n`;
						response += `- **Performance**: ${sleep.sleep_performance?.toFixed(0) ?? 'N/A'}%\n`;
						response += `- **Efficiency**: ${sleep.sleep_efficiency?.toFixed(0) ?? 'N/A'}%\n`;
						response += `- **Stages**: Light ${formatDuration(sleep.total_light_milli)}, Deep ${formatDuration(sleep.total_deep_milli)}, REM ${formatDuration(sleep.total_rem_milli)}\n`;
						if (sleep.respiratory_rate) response += `- **Respiratory Rate**: ${sleep.respiratory_rate.toFixed(1)} breaths/min\n`;
						response += '\n';
					}

					if (cycle) {
						response += `## Current Strain\n`;
						response += `- **Day Strain**: ${cycle.strain?.toFixed(1) ?? 'N/A'} ${cycle.strain ? getStrainZone(cycle.strain) : ''}\n`;
						if (cycle.kilojoule) response += `- **Calories**: ${Math.round(cycle.kilojoule / 4.184)} kcal\n`;
						if (cycle.avg_hr) response += `- **Avg HR**: ${cycle.avg_hr} bpm\n`;
						if (cycle.max_hr) response += `- **Max HR**: ${cycle.max_hr} bpm\n`;
					}

					return text(response);
				}

				case 'get_recovery_trends': {
					const days = validateDays(typedArgs.days);
					const trends = db.getRecoveryTrends(days);

					if (trends.length === 0) {
						return text(`${note}No recovery data available for the requested period.`);
					}

					let response = `${note}# Recovery Trends (Last ${days} Days)\n\n`;
					response += '| Date | Recovery | HRV | RHR |\n|------|----------|-----|-----|\n';

					for (const day of trends) {
						response += `| ${formatDate(day.date)} | ${day.recovery_score}% | ${day.hrv?.toFixed(1) ?? 'N/A'} ms | ${day.rhr ?? 'N/A'} bpm |\n`;
					}

					const avgRecovery = trends.reduce((sum, d) => sum + (d.recovery_score || 0), 0) / trends.length;
					const avgHrv = trends.reduce((sum, d) => sum + (d.hrv || 0), 0) / trends.length;
					const avgRhr = trends.reduce((sum, d) => sum + (d.rhr || 0), 0) / trends.length;

					response += `\n## Averages\n- **Recovery**: ${avgRecovery.toFixed(0)}%\n- **HRV**: ${avgHrv.toFixed(1)} ms\n- **RHR**: ${avgRhr.toFixed(0)} bpm\n`;

					return text(response);
				}

				case 'get_sleep_analysis': {
					const days = validateDays(typedArgs.days);
					const trends = db.getSleepTrends(days);

					if (trends.length === 0) {
						return text(`${note}No sleep data available for the requested period.`);
					}

					let response = `${note}# Sleep Analysis (Last ${days} Days)\n\n`;
					response += '| Date | Duration | Performance | Efficiency |\n|------|----------|-------------|------------|\n';

					for (const day of trends) {
						response += `| ${formatDate(day.date)} | ${day.total_sleep_hours?.toFixed(1) ?? 'N/A'}h | ${day.performance?.toFixed(0) ?? 'N/A'}% | ${day.efficiency?.toFixed(0) ?? 'N/A'}% |\n`;
					}

					const avgDuration = trends.reduce((sum, d) => sum + (d.total_sleep_hours || 0), 0) / trends.length;
					const avgPerf = trends.reduce((sum, d) => sum + (d.performance || 0), 0) / trends.length;
					const avgEff = trends.reduce((sum, d) => sum + (d.efficiency || 0), 0) / trends.length;

					response += `\n## Averages\n- **Duration**: ${avgDuration.toFixed(1)} hours\n- **Performance**: ${avgPerf.toFixed(0)}%\n- **Efficiency**: ${avgEff.toFixed(0)}%\n`;

					return text(response);
				}

				case 'get_strain_history': {
					const days = validateDays(typedArgs.days);
					const trends = db.getStrainTrends(days);

					if (trends.length === 0) {
						return text(`${note}No strain data available for the requested period.`);
					}

					let response = `${note}# Strain History (Last ${days} Days)\n\n`;
					response += '| Date | Strain | Calories |\n|------|--------|----------|\n';

					for (const day of trends) {
						response += `| ${formatDate(day.date)} | ${day.strain?.toFixed(1) ?? 'N/A'} | ${day.calories ?? 'N/A'} kcal |\n`;
					}

					const avgStrain = trends.reduce((sum, d) => sum + (d.strain || 0), 0) / trends.length;
					const avgCalories = trends.reduce((sum, d) => sum + (d.calories || 0), 0) / trends.length;

					response += `\n## Averages\n- **Daily Strain**: ${avgStrain.toFixed(1)}\n- **Daily Calories**: ${Math.round(avgCalories)} kcal\n`;

					return text(response);
				}

				case 'get_workouts': {
					const days = validateDays(typedArgs.days);
					// The same calendar window as the other tools, not a rolling one.
					const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
					const workouts = db.getWorkouts(since);

					if (workouts.length === 0) {
						return text(`${note}No workouts recorded in the last ${days} days.`);
					}

					let response = `${note}# Workouts (Last ${days} Days)\n\n`;
					response += '| Date | Start | Activity | Duration | Strain | Avg HR | Max HR | Zones 4–5 | Calories |\n|------|-------|----------|----------|--------|--------|--------|-----------|----------|\n';

					let totalMillis = 0;
					let hardZoneMillis = 0;
					const strains: number[] = [];
					for (const w of workouts) {
						const duration = Date.parse(w.end_time) - Date.parse(w.start_time);
						totalMillis += duration;
						const scored = w.score_state === 'SCORED';
						const zones = w.zone_four_milli === null && w.zone_five_milli === null ? null : (w.zone_four_milli ?? 0) + (w.zone_five_milli ?? 0);
						hardZoneMillis += zones ?? 0;
						if (scored && w.strain !== null) strains.push(w.strain);
						const strain = scored ? w.strain?.toFixed(1) ?? 'N/A' : 'unscored';
						const calories = w.kilojoule !== null ? `${Math.round(w.kilojoule / 4.184)} kcal` : 'N/A';
						const zoneTime = zones === null ? 'N/A' : zones > 0 ? formatDuration(zones) : '0h 0m';
						response += `| ${formatDate(localDate(w.start_time, w.timezone_offset))} | ${localTime(w.start_time, w.timezone_offset)} | ${sportName(w.sport_name, w.sport_id)} | ${formatDuration(duration)} | ${strain} | ${w.avg_hr ?? 'N/A'} bpm | ${w.max_hr ?? 'N/A'} bpm | ${zoneTime} | ${calories} |\n`;
					}

					const avgStrain = strains.length > 0 ? (strains.reduce((sum, value) => sum + value, 0) / strains.length).toFixed(1) : 'N/A';
					response += `\n## Totals\n- **Workouts**: ${workouts.length}\n- **Time**: ${formatDuration(totalMillis)}\n- **Average Strain**: ${avgStrain}\n- **Time in heart-rate zones 4–5**: ${hardZoneMillis > 0 ? formatDuration(hardZoneMillis) : '0h 0m'}\n`;

					return text(response);
				}

				case 'sync_data': {
					if (!db.getTokens()) {
						return text(NOT_AUTHENTICATED);
					}

					const full = validateBoolean(typedArgs.full);
					let stats;

					if (full) {
						stats = await sync.syncDays(90);
					} else {
						const result = await sync.smartSync();
						if (result.type === 'skip') {
							return text('Data is already up to date (synced within the last hour).');
						}
						stats = result.stats;
					}

					return text(`Sync complete!\n- Cycles: ${stats?.cycles}\n- Recoveries: ${stats?.recoveries}\n- Sleeps: ${stats?.sleeps}\n- Workouts: ${stats?.workouts}`);
				}

				case 'get_auth_url': {
					if (mode === 'stdio') {
						return text(
							"In stdio mode this server can't receive Whoop's login redirect. Connect Whoop once by running the server in http mode " +
								'with the same DB_PATH, stop it, then restart this one (see "Running on Your Own Computer" in the README).'
						);
					}
					const url = client.getAuthorizationUrl(WHOOP_SCOPES, authStates.issue());
					return text(
						`To authorize with Whoop:\n\n1. Visit: ${url}\n2. Log in and authorize\n3. You'll be redirected back automatically\n\n` +
							`The link works once and expires in 10 minutes.\n\nRedirect URI: ${redirectUri}`
					);
				}

				default:
					throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
		}
	});

	return server;
}
