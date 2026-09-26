/**
 * Release notes for one version: its section of CHANGELOG.md, plus how to upgrade and a
 * link to the full diff. The release workflow (.github/workflows/release.yml) runs this.
 *
 * Usage: node scripts/release-notes.mjs <version> [<previous version>]
 */
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO_URL = 'https://github.com/yuridivonis/whoop-mcp-server';

export function releaseNotes(changelog, version, previousVersion) {
	const lines = changelog.split('\n');
	const start = lines.findIndex(line => line.startsWith(`## [${version}]`));
	if (start === -1) {
		throw new Error(`CHANGELOG.md has no section for ${version}. Add one before releasing.`);
	}
	// The section ends at the next version heading, or at the link references at the bottom.
	const end = lines.findIndex((line, i) => i > start && (line.startsWith('## [') || /^\[[^\]]+\]: /.test(line)));
	const section = lines.slice(start + 1, end === -1 ? lines.length : end).join('\n').trim();

	const notes = [
		section,
		'',
		'### Upgrading',
		'',
		'With the image, Railway\'s auto updates apply it for you, or redeploy (Docker: pull `:1` again). With a fork, sync it and ' +
			'redeploy. Anything else this release needs is described above. Coming from 1.0.0? Follow ' +
			`[Upgrading from 1.0.0](${REPO_URL}#upgrading-from-100) first.`,
	];
	if (previousVersion) {
		notes.push('', `**Full changelog:** ${REPO_URL}/compare/v${previousVersion}...v${version}`);
	}
	return `${notes.join('\n')}\n`;
}

// Run directly (not imported by the tests). realpath, so a symlinked checkout still runs it.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	const [version, previousVersion] = process.argv.slice(2);
	if (!version) {
		console.error('Usage: node scripts/release-notes.mjs <version> [<previous version>]');
		process.exit(1);
	}
	const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
	process.stdout.write(releaseNotes(changelog, version, previousVersion));
}
