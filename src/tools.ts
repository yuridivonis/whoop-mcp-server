import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
	WhoopAuthError,
	WhoopError,
	timeAsleepMilli,
	type WhoopClient,
	type WhoopQuery,
	type WhoopScope,
	type WhoopSleep,
} from '@yuridivonis/whoop-client';
import type { PendingAuthStates } from './auth-states.js';
import type { UpdateChecker } from './updates.js';
import { localTime, wakeDay } from './days.js';
import {
	MISSING, averageLine, cycleView, dayOf, distance, formatDate, formatDuration, mean, num, recoveryView, recoveryZone,
	scoreStateLabel, sleepView, span, sportName, strainZone, table, workoutView,
} from './render.js';
import { whoopMessage } from './whoop-messages.js';

export const SERVER_VERSION = '1.4.9';

export interface ToolDeps {
	client: WhoopClient;
	authStates: PendingAuthStates;
	redirectUri: string;
	/** Both WHOOP app values are set (config.ts). Until then get_auth_url points at the set-up page. */
	whoopConfigured: boolean;
	/** The server's public address; the set-up page is at its root. */
	publicUrl: URL;
	/** In stdio mode there is no /callback, so get_auth_url explains how to connect instead. */
	mode: 'http' | 'stdio';
	/** Adds a line to get_today when a newer release is out. Absent when UPDATE_CHECK=false. */
	updates?: UpdateChecker;
}

interface ToolArguments {
	days?: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// get_today looks for last night's sleep in one page of the latest sleeps, past any naps since.
const LATEST_SLEEPS = 25;

const WHOOP_SCOPES: WhoopScope[] = ['read:cycles', 'read:recovery', 'read:sleep', 'read:workout', 'offline'];

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
function period(days: number): { since: string; query: WhoopQuery } {
	const since = new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
	return { since, query: { start: new Date(Date.parse(since) - CYCLE_LEAD_DAYS * DAY_MS).toISOString() } };
}

function newestFirst(a: { start: string }, b: { start: string }): number {
	return Date.parse(b.start) - Date.parse(a.start);
}

export function createMcpServer({ client, authStates, redirectUri, whoopConfigured, publicUrl, mode, updates }: ToolDeps): Server {
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
					"Returns the user's latest WHOOP status as Markdown, every value WHOOP sent: the most recent recovery (score %, Green/Yellow/Red zone, HRV in " +
					"ms, resting heart rate, SpO2, skin temperature, whether WHOOP is still calibrating), last night's sleep (time asleep and in bed, awake and " +
					"no-data time, light/deep/REM stages, sleep cycles, disturbances, performance, efficiency, consistency, respiratory rate, the sleep " +
					"needed before it with its baseline, debt, strain and nap parts, and today's naps) and today's strain so far (0–21) with calories, heart rate and steps. " +
					"Each section is dated. Use it first for questions like " +
					'"how am I today?" or "should I train hard?". For more than one day, use get_recovery_trends, get_sleep_analysis, ' +
					'get_strain_history or get_workouts. When a newer version of this server is out, the answer ends with a one-line ' +
					'notice to pass on to the user.' +
					DATA_TOOL_BEHAVIOR,
				inputSchema: { type: 'object', properties: {}, required: [] },
				annotations: DATA_TOOL_ANNOTATIONS,
			},
			{
				name: 'get_recovery_trends',
				title: 'Recovery trends',
				description:
					'Returns daily recovery for the last `days` days (default 14), newest first, as a Markdown table: recovery score (%), ' +
					"HRV (ms), resting heart rate (bpm), SpO2 (%), skin temperature (°C) and whether WHOOP was still calibrating, for each of the user's local days, then averages " +
					"over the days that have each value. Days WHOOP hasn't scored yet are listed as pending. Use it for patterns and comparisons, such as " +
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
					'Returns nightly sleep for the last `days` days (default 14), newest first, as Markdown tables: bed and wake time, time asleep ' +
					'(light, deep and REM), in bed, deep, REM, light and awake, performance (%) and efficiency (%); a details table with no-data time, sleep cycles, ' +
					'disturbances, consistency (%), respiratory rate and the sleep needed before each night (baseline, debt, strain, nap credit); a naps table; ' +
					"then averages over the nights that have each value. Nights WHOOP hasn't scored are listed as pending. Each night counts toward the day the user woke up. Use it for " +
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
					'table: WHOOP day strain (0–21, covering all activity that day), calories burned (kcal), average and max heart rate and steps, then averages; ' +
					'the day in progress is marked and left out of the averages. Days WHOOP hasn\'t scored yet are listed as pending. Use it for overall load and activity trends. For individual ' +
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
					'zones 4–5 and calories; a details table with distance, elevation gain, altitude change, the share of heart-rate data recorded and time in each ' +
					'zone 0–5; then totals. Use it for questions about specific sessions or training volume; for ' +
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
					"setup instructions instead; a server whose WHOOP app isn't configured yet answers with the address of its set-up page.",
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
						const r = recoveryView(recovery);
						// Dated by its cycle when that's the one fetched, else by the sleep it followed, else in UTC.
						const day = cycle && cycle.id === recovery.cycle_id ? dayOf(cycle.start, cycle.timezone_offset)
							: sleep && sleep.id === recovery.sleep_id ? dayOf(sleep.start, sleep.timezone_offset)
							: `${formatDate(recovery.created_at.slice(0, 10))} (UTC)`;
						response += `## Recovery, ${day}\n`;
						if (r.score == null) {
							response += `- **Recovery**: ${scoreStateLabel(recovery.score_state)}\n`;
						} else {
							response += `- **Recovery**: ${num(r.score, 0, '%')} ${recoveryZone(r.score)}\n`;
						}
						response += `- **HRV**: ${num(r.hrv, 1, ' ms')}\n`;
						response += `- **Resting HR**: ${num(r.rhr, 0, ' bpm')}\n`;
						response += `- **SpO2**: ${num(r.spo2, 1, '%')}\n`;
						response += `- **Skin temperature**: ${num(r.skinTemp, 1, '°C')}\n`;
						if (r.calibrating) response += `- **Calibrating**: WHOOP is still learning your baseline\n`;
						response += '\n';
					}

					if (sleep) {
						const v = sleepView(sleep);
						response += `## Sleep, ${span(sleep.start, sleep.end, sleep.timezone_offset)}\n`;
						if (sleep.score_state !== 'SCORED') response += `- **Score**: ${scoreStateLabel(sleep.score_state)}\n`;
						response += `- **Asleep**: ${formatDuration(v.asleep)} (in bed ${formatDuration(v.inBed)}, awake ${formatDuration(v.awake)}, no data ${formatDuration(v.noData)})\n`;
						response += `- **Stages**: Light ${formatDuration(v.light)}, Deep ${formatDuration(v.deep)}, REM ${formatDuration(v.rem)}\n`;
						response += `- **Sleep cycles**: ${num(v.cycles)}, **disturbances**: ${num(v.disturbances)}\n`;
						response += `- **Performance**: ${num(v.performance, 0, '%')}, **efficiency**: ${num(v.efficiency, 0, '%')}, **consistency**: ${num(v.consistency, 0, '%')}\n`;
						response += `- **Respiratory rate**: ${num(v.respiratory, 1, ' breaths/min')}\n`;
						response += `- **Sleep needed before this sleep**: ${formatDuration(v.need)} (baseline ${formatDuration(v.baseline)} + debt ${formatDuration(v.debt)} + strain ${formatDuration(v.strainNeed)} ${v.napCredit != null && v.napCredit < 0 ? '− naps ' + formatDuration(-v.napCredit) : '+ naps ' + formatDuration(v.napCredit)})\n`;
						// Naps in the shown cycle: the ones WHOOP filed under it.
						const naps = cycle ? sleeps.filter(candidate => candidate.nap && candidate.cycle_id === cycle.id) : [];
						for (const nap of naps) {
							const n = sleepView(nap);
							response += `- **Nap** ${localTime(nap.start, nap.timezone_offset)}–${localTime(nap.end, nap.timezone_offset)}: ${formatDuration(n.asleep)} asleep, ${formatDuration(n.inBed)} in bed\n`;
						}
						response += '\n';
					}

					if (cycle) {
						const c = cycleView(cycle);
						response += `## Strain, ${dayOf(cycle.start, cycle.timezone_offset)}${c.inProgress ? ' (day in progress)' : ''}\n`;
						if (c.strain == null) {
							response += `- **Day strain**: ${scoreStateLabel(cycle.score_state)}\n`;
						} else {
							response += `- **Day strain**: ${num(c.strain, 1)} ${strainZone(c.strain)}\n`;
						}
						response += `- **Calories**: ${num(c.calories, 0, ' kcal')}\n`;
						response += `- **Avg HR**: ${num(c.avgHr, 0, ' bpm')}, **max HR**: ${num(c.maxHr, 0, ' bpm')}\n`;
						if (c.steps != null) response += `- **Steps**: ${num(c.steps)}\n`;
					}

					const notice = updates?.notice();
					if (notice) response += `\n---\n${notice}\n`;

					return text(response);
				}

				case 'get_recovery_trends': {
					const days = validateDays(typedArgs.days);
					const { since, query } = period(days);
					const [recoveries, cycles] = await Promise.all([client.recoveries(query), client.cycles(query)]);
					const cyclesById = new Map(cycles.map(cycle => [cycle.id, cycle]));
					// Days are the user's local days (see days.ts): a recovery belongs to the same day as its cycle.
					const rows = recoveries
						.filter(recovery => recovery.created_at >= since)
						.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
						.map(recovery => {
							const cycle = cyclesById.get(recovery.cycle_id);
							const date = cycle ? dayOf(cycle.start, cycle.timezone_offset) : `${formatDate(recovery.created_at.slice(0, 10))} (UTC)`;
							return { date, state: recovery.score_state, ...recoveryView(recovery) };
						});

					if (rows.length === 0) {
						return text('No recovery data available for the requested period.');
					}

					let response = `# Recovery Trends (Last ${days} Days)\n\n`;
					response += table(
						['Date', 'Recovery', 'HRV (ms)', 'RHR (bpm)', 'SpO2 (%)', 'Skin temp (°C)', 'Calibrating'],
						rows.map(r => [
							r.date,
							r.score == null ? scoreStateLabel(r.state) : num(r.score, 0, '%'),
							num(r.hrv, 1), num(r.rhr, 0), num(r.spo2, 1), num(r.skinTemp, 1),
							r.calibrating == null ? MISSING : r.calibrating ? 'yes' : 'no',
						]),
					);
					const scored = rows.filter(r => r.score != null);
					response += `\n## Averages (${scored.length} of ${rows.length} days scored)\n`;
					response += averageLine('Recovery', scored.map(r => r.score), v => `${v.toFixed(0)}%`, scored.length);
					response += averageLine('HRV', scored.map(r => r.hrv), v => `${v.toFixed(1)} ms`, scored.length);
					response += averageLine('RHR', scored.map(r => r.rhr), v => `${v.toFixed(0)} bpm`, scored.length);
					response += averageLine('SpO2', scored.map(r => r.spo2), v => `${v.toFixed(1)}%`, scored.length);
					response += averageLine('Skin temperature', scored.map(r => r.skinTemp), v => `${v.toFixed(1)}°C`, scored.length);

					return text(response);
				}

				case 'get_sleep_analysis': {
					const days = validateDays(typedArgs.days);
					const { since, query } = period(days);
					// A night counts toward the day the user woke up; a nap toward the day it started.
					const all = (await client.sleeps(query)).filter(sleep => sleep.start >= since).sort(newestFirst);
					const nights = all.filter(sleep => !sleep.nap).map(sleep => ({ sleep, date: dayOf(sleep.start, sleep.timezone_offset), ...sleepView(sleep) }));
					const naps = all.filter(sleep => sleep.nap).map(sleep => ({ sleep, date: dayOf(sleep.start, sleep.timezone_offset, false), ...sleepView(sleep) }));

					if (nights.length === 0 && naps.length === 0) {
						return text('No sleep data available for the requested period.');
					}

					let response = `# Sleep Analysis (Last ${days} Days)\n\n`;
					if (nights.length > 0) {
						response += table(
							['Date', 'Bed', 'Wake', 'Asleep', 'In bed', 'Deep', 'REM', 'Light', 'Awake', 'Performance', 'Efficiency'],
							nights.map(n => [
								n.date, localTime(n.sleep.start, n.sleep.timezone_offset), localTime(n.sleep.end, n.sleep.timezone_offset),
								n.sleep.score_state === 'SCORED' ? formatDuration(n.asleep) : scoreStateLabel(n.sleep.score_state),
								formatDuration(n.inBed), formatDuration(n.deep), formatDuration(n.rem), formatDuration(n.light), formatDuration(n.awake),
								num(n.performance, 0, '%'), num(n.efficiency, 0, '%'),
							]),
						);
						response += '\n### Details\n';
						response += table(
							['Date', 'Bed', 'No data', 'Cycles', 'Disturbances', 'Consistency', 'Resp. rate (/min)', 'Need', 'Baseline', 'Debt', 'Strain', 'Nap credit'],
							nights.map(n => [
								n.date, localTime(n.sleep.start, n.sleep.timezone_offset), formatDuration(n.noData), num(n.cycles), num(n.disturbances),
								num(n.consistency, 0, '%'), num(n.respiratory, 1), formatDuration(n.need), formatDuration(n.baseline), formatDuration(n.debt),
								formatDuration(n.strainNeed), formatDuration(n.napCredit),
							]),
						);
						response += 'Asleep = light + deep + REM. Need = what the body needed going into that night: baseline + debt + strain − naps.\n';
					}
					if (naps.length > 0) {
						response += '\n### Naps\n';
						response += table(
							['Date', 'Start', 'End', 'Asleep', 'In bed'],
							naps.map(n => [n.date, localTime(n.sleep.start, n.sleep.timezone_offset), localTime(n.sleep.end, n.sleep.timezone_offset), formatDuration(n.asleep), formatDuration(n.inBed)]),
						);
					}
					if (nights.length > 0) {
						const N = nights.length;
						response += `\n## Averages (${N} nights${naps.length ? `, ${naps.length} naps` : ''})\n`;
						response += averageLine('Asleep', nights.map(n => n.asleep), formatDuration, N, 'nights');
						response += averageLine('In bed', nights.map(n => n.inBed), formatDuration, N, 'nights');
						response += averageLine('Deep', nights.map(n => n.deep), formatDuration, N, 'nights');
						response += averageLine('REM', nights.map(n => n.rem), formatDuration, N, 'nights');
						response += averageLine('Light', nights.map(n => n.light), formatDuration, N, 'nights');
						response += averageLine('Awake', nights.map(n => n.awake), formatDuration, N, 'nights');
						response += averageLine('Performance', nights.map(n => n.performance), v => `${v.toFixed(0)}%`, N, 'nights');
						response += averageLine('Efficiency', nights.map(n => n.efficiency), v => `${v.toFixed(0)}%`, N, 'nights');
						response += averageLine('Consistency', nights.map(n => n.consistency), v => `${v.toFixed(0)}%`, N, 'nights');
						response += averageLine('Respiratory rate', nights.map(n => n.respiratory), v => `${v.toFixed(1)} breaths/min`, N, 'nights');
						response += averageLine('Disturbances', nights.map(n => n.disturbances), v => v.toFixed(1), N, 'nights');
						response += averageLine('Sleep needed', nights.map(n => n.need), formatDuration, N, 'nights');
					}

					return text(response);
				}

				case 'get_strain_history': {
					const days = validateDays(typedArgs.days);
					const { since, query } = period(days);
					const rows = (await client.cycles(query))
						.filter(cycle => cycle.start >= since)
						.sort(newestFirst)
						.map(cycle => ({ cycle, date: dayOf(cycle.start, cycle.timezone_offset), ...cycleView(cycle) }));

					if (rows.length === 0) {
						return text('No strain data available for the requested period.');
					}

					let response = `# Strain History (Last ${days} Days)\n\n`;
					response += table(
						['Date', 'Strain', 'Calories (kcal)', 'Avg HR (bpm)', 'Max HR (bpm)', 'Steps'],
						rows.map(r => [
							`${r.date}${r.inProgress ? ' (day in progress)' : ''}`,
							r.strain == null ? scoreStateLabel(r.cycle.score_state) : num(r.strain, 1),
							num(r.calories), num(r.avgHr), num(r.maxHr), num(r.steps),
						]),
					);
					// The day in progress is a partial day: it's shown but not averaged.
					const complete = rows.filter(r => !r.inProgress && r.strain != null);
					response += `\n## Averages (${complete.length} of ${rows.length} days: completed and scored)\n`;
					response += averageLine('Daily strain', complete.map(r => r.strain), v => v.toFixed(1), complete.length);
					response += averageLine('Daily calories', complete.map(r => r.calories), v => `${Math.round(v)} kcal`, complete.length);
					response += averageLine('Avg HR', complete.map(r => r.avgHr), v => `${v.toFixed(0)} bpm`, complete.length);
					response += averageLine('Max HR', complete.map(r => r.maxHr), v => `${v.toFixed(0)} bpm`, complete.length);
					response += averageLine('Steps', complete.map(r => r.steps), v => `${Math.round(v)}`, complete.length);

					return text(response);
				}

				case 'get_workouts': {
					const days = validateDays(typedArgs.days);
					const { since, query } = period(days);
					const workouts = (await client.workouts(query)).filter(workout => workout.start >= since).sort(newestFirst);

					if (workouts.length === 0) {
						return text(`No workouts recorded in the last ${days} days.`);
					}

					const rows = workouts.map(w => ({ w, date: dayOf(w.start, w.timezone_offset, false), start: localTime(w.start, w.timezone_offset), ...workoutView(w) }));
					let response = `# Workouts (Last ${days} Days)\n\n`;
					response += table(
						['Date', 'Start', 'Activity', 'Duration', 'Strain', 'Avg HR (bpm)', 'Max HR (bpm)', 'Zones 4–5', 'Calories (kcal)'],
						rows.map(r => [
							r.date, r.start, sportName(r.w.sport_name), formatDuration(r.duration),
							r.scored ? num(r.strain, 1) : 'unscored',
							num(r.avgHr), num(r.maxHr), formatDuration(r.hard), num(r.calories),
						]),
					);
					response += '\n### Details\n';
					response += table(
						['Date', 'Start', 'Distance', 'Elevation gain (m)', 'Altitude change (m)', 'HR data recorded', 'Zone 0', 'Zone 1', 'Zone 2', 'Zone 3', 'Zone 4', 'Zone 5'],
						rows.map(r => [
							r.date, r.start, distance(r.distance), num(r.gain), num(r.change), num(r.recorded, 0, '%'),
							...(r.zones ? r.zones.map(z => formatDuration(z)) : Array(6).fill(MISSING) as string[]),
						]),
					);

					const scored = rows.filter(r => r.scored && r.strain != null);
					const sum = (values: (number | null)[]) => values.some(v => v != null) ? values.reduce<number>((total, v) => total + (v ?? 0), 0) : null;
					response += `\n## Totals (${rows.length} workouts${scored.length < rows.length ? `, ${scored.length} scored` : ''})\n`;
					response += `- **Time**: ${formatDuration(sum(rows.map(r => r.duration)))}\n`;
					response += `- **Average strain**: ${num(mean(scored.map(r => r.strain)).value, 1)}\n`;
					response += `- **Time in heart-rate zones 4–5**: ${formatDuration(sum(rows.map(r => r.hard)))}\n`;
					response += `- **Calories**: ${num(sum(rows.map(r => r.calories)), 0, ' kcal')}\n`;
					response += `- **Distance**: ${distance(sum(rows.map(r => r.distance)))}\n`;
					response += `- **Elevation gain**: ${num(sum(rows.map(r => r.gain)), 0, ' m')}\n`;

					return text(response);
				}

				case 'get_auth_url': {
					if (mode === 'stdio') {
						return text(
							"In stdio mode this server can't receive Whoop's login redirect. Connect Whoop once by running the server in http mode " +
								'with the same DB_PATH, stop it, then restart this one (see "Running on Your Own Computer" in the README).'
						);
					}
					if (!whoopConfigured) {
						// Without the app's keys, WHOOP's login would only show an error page.
						return text(`This server's WHOOP app isn't configured yet. Open ${publicUrl.href} for the steps.`);
					}
					const url = client.authorizationUrl({ scopes: WHOOP_SCOPES, state: authStates.issue() });
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
				return text(whoopMessage(error));
			}
			const message = error instanceof WhoopError ? whoopMessage(error) : error instanceof Error ? error.message : 'Unknown error';
			// There's no older copy to fall back on, so the operator's log gets the failure too.
			if (!(error instanceof McpError)) {
				process.stderr.write(`${name} failed: ${message}\n`);
			}
			return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
		}
	});

	return server;
}
