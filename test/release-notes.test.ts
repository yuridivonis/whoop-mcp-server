import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { releaseNotes } from '../scripts/release-notes.mjs';

const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

describe('release notes', () => {
	it('exist for the version in package.json, so merging it can release', () => {
		assert.doesNotThrow(() => releaseNotes(changelog, version));
	});

	it("hold only that version's section, then how to upgrade and the diff link", () => {
		const notes = releaseNotes(changelog, '1.1.1', '1.1.0');
		assert.match(notes, /Time asleep/);
		assert.doesNotMatch(notes, /## \[/, 'no other version headings');
		assert.match(notes, /### Upgrading/);
		assert.match(notes, /compare\/v1\.1\.0\.\.\.v1\.1\.1/);
	});

	it('stop the oldest section before the link references', () => {
		const notes = releaseNotes(changelog, '1.0.0');
		assert.match(notes, /Initial release/);
		assert.doesNotMatch(notes, /^\[[\d.]+\]: /m);
		assert.doesNotMatch(notes, /Full changelog/, 'no diff link without a previous version');
	});

	it("refuse a version the changelog doesn't cover", () => {
		assert.throws(() => releaseNotes(changelog, '9.9.9'), /no section for 9\.9\.9/);
	});
});
