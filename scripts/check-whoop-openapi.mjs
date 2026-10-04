#!/usr/bin/env node
/**
 * Compares WHOOP's published OpenAPI with the WHOOP client's types, and exits 1 when a
 * field appears on one side only: WHOOP added or removed something, or a type is wrong.
 *
 *   node scripts/check-whoop-openapi.mjs            # fetches the live spec
 *   node scripts/check-whoop-openapi.mjs spec.json   # or reads a saved copy
 *
 * Needs the network (or the file) and the repo's TypeScript, so it runs from the weekly
 * live check and by hand, never in the ordinary test run.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const SPEC_URL = 'https://api.prod.whoop.com/developer/doc/openapi.json';
const TYPES = new URL('../packages/whoop-client/src/types.ts', import.meta.url);

// WHOOP schema → our interface, and the nested score objects.
const MAP = {
	Cycle: 'WhoopCycle',
	CycleScore: 'WhoopCycle.score',
	Recovery: 'WhoopRecovery',
	RecoveryScore: 'WhoopRecovery.score',
	Sleep: 'WhoopSleep',
	SleepScore: 'WhoopSleep.score',
	SleepStageSummary: 'WhoopSleep.score.stage_summary',
	SleepNeeded: 'WhoopSleep.score.sleep_needed',
	WorkoutV2: 'WhoopWorkout',
	WorkoutScore: 'WhoopWorkout.score',
	ZoneDurations: 'WhoopWorkout.score.zone_durations',
	UserBasicProfile: 'WhoopProfile',
	UserBodyMeasurement: 'WhoopBodyMeasurement',
};

const ts = createRequire(import.meta.url)('typescript');

/** Property names of every interface in types.ts, nested objects as "Interface.prop.prop". */
function declaredFields() {
	const source = ts.createSourceFile('types.ts', readFileSync(TYPES, 'utf8'), ts.ScriptTarget.Latest, true);
	const fields = new Map();
	const walk = (members, path) => {
		const names = new Set();
		for (const member of members) {
			if (!ts.isPropertySignature(member) || !member.name) continue;
			const name = member.name.getText(source);
			names.add(name);
			if (member.type && ts.isTypeLiteralNode(member.type)) walk(member.type.members, `${path}.${name}`);
		}
		fields.set(path, names);
	};
	ts.forEachChild(source, node => {
		if (ts.isInterfaceDeclaration(node)) walk(node.members, node.name.text);
	});
	return fields;
}

async function spec() {
	const file = process.argv[2];
	if (file) return JSON.parse(readFileSync(file, 'utf8'));
	const response = await fetch(SPEC_URL);
	if (!response.ok) throw new Error(`WHOOP's spec answered ${response.status}`);
	return response.json();
}

const schemas = (await spec()).components?.schemas ?? {};
const ours = declaredFields();
let drift = 0;
for (const [schema, path] of Object.entries(MAP)) {
	const theirs = new Set(Object.keys(schemas[schema]?.properties ?? {}));
	const mine = ours.get(path);
	if (!schemas[schema]) { console.log(`DRIFT ${schema}: no longer in WHOOP's spec`); drift++; continue; }
	if (!mine) { console.log(`DRIFT ${path}: not declared in types.ts`); drift++; continue; }
	for (const field of theirs) if (!mine.has(field)) { console.log(`DRIFT ${schema}.${field}: WHOOP sends it, ${path} lacks it`); drift++; }
	for (const field of mine) if (!theirs.has(field)) { console.log(`DRIFT ${path}.${field}: declared, but not in WHOOP's ${schema}`); drift++; }
}
console.log(drift === 0 ? `OK: ${Object.keys(MAP).length} WHOOP schemas match the client's types.` : `${drift} difference(s).`);
process.exit(drift === 0 ? 0 : 1);
