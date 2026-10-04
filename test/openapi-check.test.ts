import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

const SCRIPT = new URL('../scripts/check-whoop-openapi.mjs', import.meta.url).pathname;
const TYPES = new URL('../packages/whoop-client/src/types.ts', import.meta.url).pathname;

// The same map the script holds, so the fixture below mirrors the client's types exactly.
const MAP: Record<string, string> = {
	Cycle: 'WhoopCycle', CycleScore: 'WhoopCycle.score', Recovery: 'WhoopRecovery', RecoveryScore: 'WhoopRecovery.score',
	Sleep: 'WhoopSleep', SleepScore: 'WhoopSleep.score', SleepStageSummary: 'WhoopSleep.score.stage_summary', SleepNeeded: 'WhoopSleep.score.sleep_needed',
	WorkoutV2: 'WhoopWorkout', WorkoutScore: 'WhoopWorkout.score', ZoneDurations: 'WhoopWorkout.score.zone_durations',
	UserBasicProfile: 'WhoopProfile', UserBodyMeasurement: 'WhoopBodyMeasurement',
};

/** The field names at `path` ("Interface.prop.prop") as types.ts currently declares them. */
function declaredFields(path: string): string[] {
	const source = ts.createSourceFile(TYPES, readFileSync(TYPES, 'utf8'), ts.ScriptTarget.Latest, true);
	const [name, ...nested] = path.split('.');
	let members: readonly ts.TypeElement[] = [];
	ts.forEachChild(source, node => { if (ts.isInterfaceDeclaration(node) && node.name.text === name) members = node.members; });
	for (const step of nested) {
		const member = members.find((m): m is ts.PropertySignature => ts.isPropertySignature(m) && m.name.getText(source) === step);
		members = member?.type && ts.isTypeLiteralNode(member.type) ? member.type.members : [];
	}
	return members.filter(ts.isPropertySignature).map(m => m.name.getText(source));
}

type Spec = { components: { schemas: Record<string, { properties: Record<string, object> }> } };

/** A spec whose every mapped schema has exactly the client's fields. */
function matchingSpec(): Spec {
	const schemas: Spec['components']['schemas'] = {};
	for (const [schema, path] of Object.entries(MAP)) {
		const fields = declaredFields(path);
		assert.ok(fields.length > 0, `${path} has fields`);
		schemas[schema] = { properties: Object.fromEntries(fields.map(field => [field, { type: 'string' }])) };
	}
	return { components: { schemas } };
}

function run(spec: Spec): { status: number | null; out: string } {
	const file = join(mkdtempSync(join(tmpdir(), 'whoop-spec-')), 'openapi.json');
	writeFileSync(file, JSON.stringify(spec));
	const result = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
	return { status: result.status, out: result.stdout + result.stderr };
}

describe('the WHOOP OpenAPI drift check', () => {
	it('passes when every schema has exactly the fields the client declares', () => {
		const { status, out } = run(matchingSpec());
		assert.equal(status, 0, out);
		assert.match(out, /OK: 13 WHOOP schemas match/);
	});

	it('fails, naming each difference, when WHOOP adds a field, drops one, or drops a whole schema', () => {
		const spec = matchingSpec();
		spec.components.schemas.Recovery.properties.new_metric = { type: 'number' };
		delete spec.components.schemas.SleepStageSummary.properties.disturbance_count;
		delete spec.components.schemas.UserBodyMeasurement;
		const { status, out } = run(spec);
		assert.equal(status, 1);
		assert.match(out, /DRIFT Recovery\.new_metric: WHOOP sends it, WhoopRecovery lacks it/);
		assert.match(out, /DRIFT WhoopSleep\.score\.stage_summary\.disturbance_count: declared, but not in WHOOP's SleepStageSummary/);
		assert.match(out, /DRIFT UserBodyMeasurement: no longer in WHOOP's spec/);
		assert.match(out, /3 difference\(s\)/);
	});
});
