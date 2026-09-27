/**
 * The package as others will use it: imported by name, so through its `exports` and the
 * built dist. Nothing but the documented names is public, and the library stays silent and
 * free of Node-only APIs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as whoopClient from '@yuridivonis/whoop-client';

const DOCUMENTED = [
	'WhoopAuthError',
	'WhoopClient',
	'WhoopError',
	'WhoopProtocolError',
	'WhoopRateLimitError',
	'WhoopRequestError',
	'WhoopUnavailableError',
	'localDate',
	'localTime',
	'parseOffset',
	'timeAsleepMilli',
	'wakeDay',
];

describe('the package', () => {
	it('exports exactly the documented names', () => {
		assert.deepEqual(Object.keys(whoopClient).sort(), [...DOCUMENTED].sort());
	});

	it('never logs, and uses no Node-only APIs, so it runs wherever fetch does', () => {
		const dir = new URL('../src/', import.meta.url);
		for (const file of readdirSync(dir).filter(name => name.endsWith('.ts'))) {
			const source = readFileSync(new URL(file, dir), 'utf8');
			assert.doesNotMatch(source, /\bconsole\./, `${file} logs`);
			assert.doesNotMatch(source, /\bprocess\./, `${file} uses process`);
			assert.doesNotMatch(source, /from ['"]node:/, `${file} imports a Node module`);
		}
	});
});
