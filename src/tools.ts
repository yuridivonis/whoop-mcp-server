import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { WhoopAuthError, type Query, type WhoopClient } from './whoop-client.js';
import type { PendingAuthStates } from './auth-states.js';
import { localDate, localTime, wakeDay } from './days.js';
import type { WhoopSleep } from './types.js';

export const SERVER_VERSION = '1.2.0';

export interface ToolDeps {
	client: WhoopClient;
	authStates: PendingAuthStates;
	redirectUri: string;
	/** In stdio mode there is no /callback, so get_auth_url explains how to connect instead. */
	mode: 'http' | 'stdio';
}

interface ToolArguments {
	days?: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// get_today looks for last night's sleep in one page of the latest sleeps, past any naps since.
const LATEST_SLEEPS = 25;

function formatDuration(millis: number | null | undefined): string {
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
	'or get_workouts. Every call fetches the data live from WHOOP, so answers are current, and the server keeps no copy. ' +
	"If a tool says WHOOP isn't connected, call get_auth_url and pass its answer to the user. Days are the user's local days, " +
	"and a night of sleep counts toward the day they woke up. Nothing here changes the user's WHOOP data.";

/** Appended to each data tool's description, so an agent knows what calling it involves. */
const DATA_TOOL_BEHAVIOR =
	" Read-only: it never changes the user's WHOOP data. It fetches the data live from WHOOP on every call and keeps no copy, " +
	"so the answer is current; if WHOOP can't be reached, it says so. If WHOOP isn't connected yet, it returns a message " +
	'asking to call get_auth_url.';

/** For tools that take days: how to pick it, which the schema alone can't say. */
const DAYS_GUIDANCE = ' Set days to match the question: 7 for the last week, 30 for the last month, up to 90.';

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

function text(value: string): CallToolResult {
	return { content: [{ type: 'text', text: value }] };
}

// Recoveries are dated by their cycle, which starts before the recovery is created: the
// night before, or days before if the strap synced late. So cycles are fetched this far back.
const CYCLE_LEAD_DAYS = 3;

/**
 * The period the tools that take days cover: records from the start of the UTC date
 * `days` days ago (`since`). They ask WHOOP for a few days more, so each recovery's
 * cycle comes along, and every tool asking for the same days at the same moment makes
 * the same request, which the client then shares.
 */
function period(days: number): { since: string; query: Query } {
	const since = new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
	return { since, query: { start: new Date(Date.parse(since) - CYCLE_LEAD_DAYS * DAY_MS).toISOString() } };
}

function newestFirst(a: { start: string }, b: { start: string }): number {
	return Date.parse(b.start) - Date.parse(a.start);
}

/**
 * Time asleep is the sum of the stages. In bed minus awake would also count the time the
 * strap recorded no data. Null when a stage is missing, rather than a partial total.
 */
function timeAsleep(sleep: WhoopSleep): number | null {
	const stages = sleep.score?.stage_summary;
	const light = stages?.total_light_sleep_time_milli;
	const deep = stages?.total_slow_wave_sleep_time_milli;
	const rem = stages?.total_rem_sleep_time_milli;
	return light == null || deep == null || rem == null ? null : light + deep + rem;
}

export function createMcpServer({ client, authStates, redirectUri, mode }: ToolDeps): Server {
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
					DAYS_GUIDANCE +
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
					DAYS_GUIDANCE +
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
					DAYS_GUIDANCE +
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
					DAYS_GUIDANCE +
					DATA_TOOL_BEHAVIOR,
				inputSchema: { type: 'object', properties: { days: DAYS_PARAMETER }, required: [] },
				annotations: DATA_TOOL_ANNOTATIONS,
			},
			{
				name: 'get_auth_url',
				title: 'Connect WHOOP account',
				description:
					"Returns a one-time link that connects the user's WHOOP account to this server through WHOOP's own login. Use it " +
					"when a data tool such as get_today says WHOOP isn't connected or its authorization expired. Give the link to the " +
					'user to open in a browser: it works once and expires in 10 minutes. Once they have ' +
					'logged in, get_today and the other data tools work. ' +
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
			switch (name) {
				case 'get_today': {
					// The latest of each, whatever its date.
					const [recoveries, sleeps, cycles] = await Promise.all([
						client.recoveries({ limit: 1 }),
						client.sleeps({ limit: LATEST_SLEEPS }),
						client.cycles({ limit: 1 }),
					]);
					const [recovery] = recoveries;
					const sleep = sleeps.find(candidate => !candidate.nap);
					const [cycle] = cycles;

					if (!recovery && !sleep && !cycle) {
						return text('WHOOP has no recovery, sleep or strain data for this account yet.');
					}

					let response = `# Today's Whoop Summary\n\n`;

					if (recovery) {
						const score = recovery.score;
						response += `## Recovery: ${score?.recovery_score ?? 'N/A'}% ${score?.recovery_score ? getRecoveryZone(score.recovery_score) : ''}\n`;
						response += `- **HRV**: ${score?.hrv_rmssd_milli?.toFixed(1) ?? 'N/A'} ms\n`;
						response += `- **Resting HR**: ${score?.resting_heart_rate ?? 'N/A'} bpm\n`;
						if (score?.spo2_percentage) response += `- **SpO2**: ${score.spo2_percentage.toFixed(1)}%\n`;
						if (score?.skin_temp_celsius) response += `- **Skin Temp**: ${score.skin_temp_celsius.toFixed(1)}°C\n`;
						response += '\n';
					}

					if (sleep) {
						const score = sleep.score;
						const stages = score?.stage_summary;
						response += `## Last Night's Sleep\n`;
						response += `- **Total Sleep**: ${formatDuration(timeAsleep(sleep))}\n`;
						response += `- **Performance**: ${score?.sleep_performance_percentage?.toFixed(0) ?? 'N/A'}%\n`;
						response += `- **Efficiency**: ${score?.sleep_efficiency_percentage?.toFixed(0) ?? 'N/A'}%\n`;
						response += `- **Stages**: Light ${formatDuration(stages?.total_light_sleep_time_milli)}, Deep ${formatDuration(stages?.total_slow_wave_sleep_time_milli)}, REM ${formatDuration(stages?.total_rem_sleep_time_milli)}\n`;
						if (score?.respiratory_rate) response += `- **Respiratory Rate**: ${score.respiratory_rate.toFixed(1)} breaths/min\n`;
						response += '\n';
					}

					if (cycle) {
						const score = cycle.score;
						response += `## Current Strain\n`;
						response += `- **Day Strain**: ${score?.strain?.toFixed(1) ?? 'N/A'} ${score?.strain ? getStrainZone(score.strain) : ''}\n`;
						if (score?.kilojoule) response += `- **Calories**: ${Math.round(score.kilojoule / 4.184)} kcal\n`;
						if (score?.average_heart_rate) response += `- **Avg HR**: ${score.average_heart_rate} bpm\n`;
						if (score?.max_heart_rate) response += `- **Max HR**: ${score.max_heart_rate} bpm\n`;
					}

					return text(response);
				}

				case 'get_recovery_trends': {
					const days = validateDays(typedArgs.days);
					const { since, query } = period(days);
					const [recoveries, cycles] = await Promise.all([client.recoveries(query), client.cycles(query)]);
					const cyclesById = new Map(cycles.map(cycle => [cycle.id, cycle]));
					// Days are the user's local days (see days.ts): a recovery belongs to the same day as its cycle.
					const trends = recoveries
						.flatMap(recovery => {
							const score = recovery.score;
							if (score?.recovery_score == null || recovery.created_at < since) return [];
							const cycle = cyclesById.get(recovery.cycle_id);
							return [{
								created_at: recovery.created_at,
								date: cycle ? wakeDay(cycle.start, cycle.timezone_offset) : recovery.created_at.slice(0, 10),
								recovery_score: score.recovery_score,
								hrv: score.hrv_rmssd_milli,
								rhr: score.resting_heart_rate,
							}];
						})
						.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

					if (trends.length === 0) {
						return text('No recovery data available for the requested period.');
					}

					let response = `# Recovery Trends (Last ${days} Days)\n\n`;
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
					const { since, query } = period(days);
					// Naps and nights WHOOP hasn't scored are left out. A night counts toward the day the user woke up.
					const trends = (await client.sleeps(query))
						.flatMap(sleep => {
							const performance = sleep.score?.sleep_performance_percentage;
							if (sleep.nap || performance == null || sleep.start < since) return [];
							const asleep = timeAsleep(sleep);
							return [{
								start: sleep.start,
								date: wakeDay(sleep.start, sleep.timezone_offset),
								total_sleep_hours: asleep === null ? null : Math.round(asleep / 36_000) / 100,
								performance,
								efficiency: sleep.score?.sleep_efficiency_percentage,
							}];
						})
						.sort(newestFirst);

					if (trends.length === 0) {
						return text('No sleep data available for the requested period.');
					}

					let response = `# Sleep Analysis (Last ${days} Days)\n\n`;
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
					const { since, query } = period(days);
					const trends = (await client.cycles(query))
						.flatMap(cycle => {
							const strain = cycle.score?.strain;
							if (strain == null || cycle.start < since) return [];
							const kilojoule = cycle.score?.kilojoule;
							return [{
								start: cycle.start,
								date: wakeDay(cycle.start, cycle.timezone_offset),
								strain,
								calories: kilojoule == null ? null : Math.round(kilojoule / 4.184),
							}];
						})
						.sort(newestFirst);

					if (trends.length === 0) {
						return text('No strain data available for the requested period.');
					}

					let response = `# Strain History (Last ${days} Days)\n\n`;
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
					const { since, query } = period(days);
					const workouts = (await client.workouts(query)).filter(workout => workout.start >= since).sort(newestFirst);

					if (workouts.length === 0) {
						return text(`No workouts recorded in the last ${days} days.`);
					}

					let response = `# Workouts (Last ${days} Days)\n\n`;
					response += '| Date | Start | Activity | Duration | Strain | Avg HR | Max HR | Zones 4–5 | Calories |\n|------|-------|----------|----------|--------|--------|--------|-----------|----------|\n';

					let totalMillis = 0;
					let hardZoneMillis = 0;
					const strains: number[] = [];
					for (const w of workouts) {
						const score = w.score;
						const duration = Date.parse(w.end) - Date.parse(w.start);
						totalMillis += duration;
						const scored = w.score_state === 'SCORED';
						const zone4 = score?.zone_durations?.zone_four_milli;
						const zone5 = score?.zone_durations?.zone_five_milli;
						const zones = zone4 == null && zone5 == null ? null : (zone4 ?? 0) + (zone5 ?? 0);
						hardZoneMillis += zones ?? 0;
						if (scored && score?.strain != null) strains.push(score.strain);
						const strain = scored ? score?.strain?.toFixed(1) ?? 'N/A' : 'unscored';
						const calories = score?.kilojoule != null ? `${Math.round(score.kilojoule / 4.184)} kcal` : 'N/A';
						const zoneTime = zones === null ? 'N/A' : zones > 0 ? formatDuration(zones) : '0h 0m';
						response += `| ${formatDate(localDate(w.start, w.timezone_offset))} | ${localTime(w.start, w.timezone_offset)} | ${sportName(w.sport_name ?? null, w.sport_id)} | ${formatDuration(duration)} | ${strain} | ${score?.average_heart_rate ?? 'N/A'} bpm | ${score?.max_heart_rate ?? 'N/A'} bpm | ${zoneTime} | ${calories} |\n`;
					}

					const avgStrain = strains.length > 0 ? (strains.reduce((sum, value) => sum + value, 0) / strains.length).toFixed(1) : 'N/A';
					response += `\n## Totals\n- **Workouts**: ${workouts.length}\n- **Time**: ${formatDuration(totalMillis)}\n- **Average Strain**: ${avgStrain}\n- **Time in heart-rate zones 4–5**: ${hardZoneMillis > 0 ? formatDuration(hardZoneMillis) : '0h 0m'}\n`;

					return text(response);
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
			// Not connected, or the authorization ended: the answer tells the agent what to do next.
			if (error instanceof WhoopAuthError) {
				return text(error.message);
			}
			const message = error instanceof Error ? error.message : 'Unknown error';
			// There's no older copy to fall back on, so the operator's log gets the failure too.
			if (!(error instanceof McpError)) {
				process.stderr.write(`${name} failed: ${message}\n`);
			}
			return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
		}
	});

	return server;
}
