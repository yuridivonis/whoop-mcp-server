#!/usr/bin/env node
/**
 * Asks a running Whoop MCP Server, connected to a real WHOOP account, every question the
 * tools answer, and checks the answers: first the rules in answer-rules.mjs, then, when
 * ANTHROPIC_API_KEY is set, a reading by Claude for values that are implausible or don't
 * agree with each other. Nothing from the answers is printed, saved or put in an issue:
 * the report names tools, places and kinds of problem, each from a fixed vocabulary.
 *
 *   LIVE_CHECK_URL             the server, e.g. https://whoop.example.up.railway.app
 *   LIVE_CHECK_PASSWORD        its MCP_AUTH_PASSWORD
 *   ANTHROPIC_API_KEY          optional; without it only the rules run
 *   LIVE_CHECK_REVIEWER_MODEL  optional; the Claude model that reads the answers
 *   LIVE_CHECK_REPORT          optional; a file to write the Markdown report to
 *   LIVE_CHECK_ANTHROPIC_URL   optional; where the Claude API is (the tests point it at a fake)
 *
 * Exits 1 when there are problems, 2 when the server couldn't be asked at all.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { problems, tables } from './answer-rules.mjs';

const REDIRECT_URI = 'http://localhost:9999/oauth/callback';
const REVIEWER_MODEL = process.env.LIVE_CHECK_REVIEWER_MODEL || 'claude-sonnet-5';
const ANTHROPIC_URL = process.env.LIVE_CHECK_ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages';
const TIMEOUT_MS = 60_000;
const QUESTIONS = [
	['get_today', {}],
	...['get_recovery_trends', 'get_sleep_analysis', 'get_strain_history', 'get_workouts'].flatMap(tool => [[tool, { days: 7 }], [tool, { days: 30 }]]),
];
const questionLabel = (tool, args) => (args.days ? `${tool} (${args.days} days)` : tool);

/** The kinds of problem the reviewer may report: its output is matched against these words and nothing else. */
const PROBLEM_KINDS = [
	'a value outside what a human body can produce',
	'the summary disagrees with a table',
	'the 7-day and 30-day answers disagree',
	'an average disagrees with its rows',
	'a count disagrees with its rows',
	'a date out of order or in the future',
	'a duplicated day',
	'a missing day',
	'a label that does not fit its value',
	'a unit that looks wrong for its number',
	'formatting that would confuse a reader',
	'something else',
];

const base = process.env.LIVE_CHECK_URL?.replace(/\/$/, '');
const password = process.env.LIVE_CHECK_PASSWORD;
if (!base || !password) {
	console.log('LIVE_CHECK_URL and LIVE_CHECK_PASSWORD are not both set: nothing to check.');
	process.exit(0);
}

function timed(url, init) {
	return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/** Registers a client, signs in with the password and exchanges the code, as Claude.ai does. */
async function signIn() {
	const registered = await timed(`${base}/register`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ client_name: 'Live check', redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] }),
	});
	if (registered.status !== 201) throw new Error(`registration answered ${registered.status}`);
	const { client_id } = await registered.json();

	const verifier = randomBytes(32).toString('base64url');
	const challenge = createHash('sha256').update(verifier).digest('base64url');
	const form = new URLSearchParams({
		client_id, redirect_uri: REDIRECT_URI, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256',
		state: 'live-check', password, consent: 'yes',
	});
	const authorized = await timed(`${base}/authorize`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form, redirect: 'manual' });
	const code = new URL(authorized.headers.get('location') ?? 'http://none', REDIRECT_URI).searchParams.get('code');
	if (!code) throw new Error(`sign-in answered ${authorized.status} without a code (wrong LIVE_CHECK_PASSWORD?)`);

	const tokens = await timed(`${base}/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id, redirect_uri: REDIRECT_URI }),
	});
	if (tokens.status !== 200) throw new Error(`token exchange answered ${tokens.status}`);
	return (await tokens.json()).access_token;
}

/** One JSON-RPC request to /mcp; the server answers as JSON or as one SSE event. */
async function rpc(accessToken, method, params) {
	const res = await timed(`${base}/mcp`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${accessToken}` },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
	const body = await res.text();
	if (!res.ok) throw new Error(`${method} answered ${res.status}`);
	const json = (res.headers.get('content-type') ?? '').includes('application/json') ? body : body.split('\n').find(line => line.startsWith('data: '))?.slice(6);
	let message;
	try {
		message = JSON.parse(json ?? '{}');
	} catch {
		throw new Error(`${method} answered something other than JSON`);
	}
	if (message.error) throw new Error(`${method} failed: ${message.error.message}`);
	return message.result;
}

/** Row count of an answer's first table: a 30-day answer must have at least a 7-day answer's rows. */
function firstTableRows(text) {
	return tables(text)[0]?.rows.length ?? 0;
}

/**
 * The places the reviewer may name: the server's own words from the answers (a heading up to
 * its first comma or parenthesis, table headers, the bold labels of the summary), never a
 * value. Nothing with a digit in it qualifies, whatever the regexes let through.
 */
function placesIn(answers) {
	const places = new Set();
	for (const { text } of answers) {
		for (const line of text.split('\n')) {
			const heading = /^#+\s*([^,(]+)/.exec(line);
			if (heading) places.add(heading[1].trim());
			for (const bold of line.matchAll(/\*\*([^*]+)\*\*/g)) places.add(bold[1]);
		}
		for (const table of tables(text)) for (const cell of table.header) places.add(cell);
	}
	return new Set([...places].filter(place => place && !/\d/.test(place)));
}

/** The server's own words when it has no WHOOP connection to answer from (src/whoop-messages.ts). */
const NOT_CONNECTED = /Use the get_auth_url tool to (connect|reconnect)\./;
/** The answers that always carry a heading when the server has data: a 30-day period without one means none came. */
const EXPECT_DATA = new Set(['get_today', 'get_recovery_trends (30 days)', 'get_sleep_analysis (30 days)', 'get_strain_history (30 days)']);

/**
 * Claude reads the answers and reports what looks wrong. Only words from the fixed vocabulary
 * reach the report: a question label, a place from `placesIn`, a kind from PROBLEM_KINDS.
 */
async function review(answers) {
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey) return { ran: false, problems: [] };
	const labels = QUESTIONS.map(([tool, args]) => questionLabel(tool, args));
	const places = placesIn(answers);
	const system = [
		'You check the answers of a server that relays one person\'s WHOOP data (recovery, sleep, strain, workouts) to an AI assistant.',
		'The server passes WHOOP\'s values through with units and labels; it does not calculate anything beyond simple averages and totals.',
		`Today is ${new Date().toISOString().slice(0, 10)} (UTC).`,
		'Read every answer and report anything that looks like a bug in the server.',
		'Unscored days, dashes for missing values, "pending", "couldn\'t score" and gaps where the strap wasn\'t worn are normal, not bugs.',
		'Answer with JSON only, no prose: {"problems":[{"tool":"<one of the answer labels>","where":"<a place in that answer>","kind":"<one of the kinds below, copied exactly>"}]}.',
		'A place is a heading\'s first words up to its first comma or parenthesis (such as "Recovery", "Sleep", "Averages"), a column header, or a bold label, copied exactly.',
		`The kinds: ${PROBLEM_KINDS.map(kind => JSON.stringify(kind)).join(', ')}.`,
		'Privacy rule: write nothing but those three fields, each copied from the lists; never a number, a date, a time or any value from the answers. An empty problems list is a fine answer.',
	].join(' ');
	const content = answers.map(({ label, text }) => `### ${label}\n\n${text}`).join('\n\n');
	const res = await timed(ANTHROPIC_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
		body: JSON.stringify({ model: REVIEWER_MODEL, max_tokens: 2000, system, messages: [{ role: 'user', content }] }),
	});
	if (!res.ok) return { ran: true, problems: [`the reviewer could not run: the Claude API answered ${res.status} for model ${REVIEWER_MODEL}`] };
	let parsed;
	try {
		const reply = (await res.json()).content?.find(block => block.type === 'text')?.text ?? '';
		parsed = JSON.parse(reply.replace(/^```(?:json)?\s*|\s*```$/g, ''));
	} catch {
		return { ran: true, problems: ['the reviewer answered with something other than the JSON asked for'] };
	}
	const found = (Array.isArray(parsed?.problems) ? parsed.problems : []).map(p => {
		const tool = labels.includes(p?.tool) ? p.tool : 'an answer it did not name from the list';
		const where = places.has(p?.where) ? p.where : 'a place it did not name from the answer';
		const kind = PROBLEM_KINDS.includes(p?.kind) ? p.kind : 'a kind of problem outside the list';
		return `${tool}, ${where}: ${kind}`;
	});
	return { ran: true, problems: found };
}

/** An error message's first clause: the server's own words, never a body WHOOP or anyone else sent. */
function firstClause(text) {
	return text.replace(/^Error:\s*/, '').split('\n')[0].split(/:\s|:$|\.\s/)[0].slice(0, 120);
}

const report = [];
const found = [];
try {
	const accessToken = await signIn();
	const { serverInfo } = await rpc(accessToken, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'live-check', version: '0' } });
	const mainVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
	report.push(`Server version ${serverInfo?.version ?? 'unknown'}${serverInfo?.version === mainVersion ? '' : ` (this checkout is ${mainVersion}: the server hasn't updated yet, so the check covers the older version)`}.`);

	const answers = [];
	for (const [tool, args] of QUESTIONS) {
		const label = questionLabel(tool, args);
		let result;
		try {
			result = await rpc(accessToken, 'tools/call', { name: tool, arguments: args });
		} catch (error) {
			found.push(`${label}: ${firstClause(error.message)}`);
			continue;
		}
		const text = result.content?.[0]?.text ?? '';
		if (result.isError) {
			found.push(`${label}: the tool answered an error: ${firstClause(text)}`);
			continue;
		}
		if (NOT_CONNECTED.test(text)) {
			found.push(`${label}: the server is not connected to WHOOP`);
			continue;
		}
		if (EXPECT_DATA.has(label) && !/^#/m.test(text)) {
			found.push(`${label}: the tool answered without data`);
			continue;
		}
		answers.push({ tool, days: args.days, label, text });
		for (const problem of problems(text)) found.push(`${label}: ${problem}`);
	}
	for (const month of answers.filter(a => a.days === 30)) {
		const week = answers.find(a => a.tool === month.tool && a.days === 7);
		if (week && firstTableRows(month.text) < firstTableRows(week.text)) found.push(`${month.label}: fewer rows than the 7-day answer`);
	}
	report.push(`${answers.length} of ${QUESTIONS.length} answers received; ${found.length === 0 ? 'the rules pass on all of them' : `${found.length} rule problem(s)`}.`);

	const reviewed = await review(answers);
	if (reviewed.ran) {
		report.push(reviewed.problems.length === 0 ? `Claude (${REVIEWER_MODEL}) read the answers and saw nothing wrong.` : `Claude (${REVIEWER_MODEL}) flagged ${reviewed.problems.length} thing(s).`);
		found.push(...reviewed.problems.map(p => `reviewer: ${p}`));
	} else {
		report.push('No ANTHROPIC_API_KEY: the answers were checked by the rules only.');
	}
} catch (error) {
	found.push(`the server could not be asked: ${firstClause(error.message)}`);
}

const markdown = [
	`## Live check, ${new Date().toISOString().slice(0, 10)}`,
	'',
	...report,
	'',
	found.length === 0 ? 'All clear.' : `### Problems\n\n${found.map(f => `- ${f}`).join('\n')}`,
	'',
].join('\n');
console.log(markdown);
if (process.env.LIVE_CHECK_REPORT) writeFileSync(process.env.LIVE_CHECK_REPORT, markdown);
process.exit(found.length === 0 ? 0 : report.length === 0 ? 2 : 1);
