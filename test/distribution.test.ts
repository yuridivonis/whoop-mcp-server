import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { licenseAllowed } from '../scripts/check-licenses.mjs';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

interface ServerJson {
	name: string;
	title: string;
	description: string;
	version: string;
	packages: {
		identifier: string;
		transport: { type: string; url: string };
		runtimeArguments: { name: string; value: string }[];
		environmentVariables: { name: string; default?: string }[];
	}[];
}

const server = JSON.parse(read('server.json')) as ServerJson;
const [image] = server.packages;
const { version } = JSON.parse(read('package.json')) as { version: string };
const source = readdirSync(new URL('../src/', import.meta.url), { recursive: true })
	.filter(file => String(file).endsWith('.ts'))
	.map(file => read(`src/${String(file)}`))
	.join('\n');

describe('registry listing (server.json)', () => {
	it('names the same server as the Docker label the registry checks', () => {
		const label = read('Dockerfile').match(/io\.modelcontextprotocol\.server\.name="([^"]+)"/)?.[1];
		assert.equal(label, server.name);
	});

	it('lists this version and the image built for it', () => {
		assert.equal(server.version, version);
		assert.equal(image.identifier, `ghcr.io/yuridivonis/whoop-mcp-server:${version}`);
	});

	it("fits the registry's length limits", () => {
		assert.ok(server.description.length <= 100, `description is ${server.description.length} characters`);
		assert.ok(server.title.length <= 100);
	});

	it('only lists settings the server actually reads', () => {
		for (const { name } of image.environmentVariables) {
			assert.match(source, new RegExp(`env(?:\\.${name}\\b|\\[['"]${name}['"]\\])`), `the server reads env.${name}`);
		}
	});

	it("maps the container's port and data directory the way the Dockerfile sets them", () => {
		const dockerfile = read('Dockerfile');
		const containerPort = dockerfile.match(/^ENV PORT=(\d+)$/m)?.[1];
		const dbPath = dockerfile.match(/^ENV DB_PATH=(\S+)$/m)?.[1] ?? '';
		const [hostPort, mappedPort] = (image.runtimeArguments.find(arg => arg.name === '-p')?.value ?? '').split(':');
		const mountPath = (image.runtimeArguments.find(arg => arg.name === '-v')?.value ?? '').split(':')[1];
		assert.equal(mappedPort, containerPort, 'the -p mapping targets the port the server listens on');
		assert.ok(mountPath && dbPath.startsWith(`${mountPath}/`), `the volume holds DB_PATH (${dbPath})`);

		const url = new URL(image.transport.url);
		assert.equal(url.port, hostPort, 'clients connect to the published port');
		assert.equal(image.environmentVariables.find(env => env.name === 'PUBLIC_URL')?.default, url.origin);
	});
});

/** GitHub's heading anchors: lower case, punctuation dropped, each space a hyphen. */
function headingAnchors(doc: string): Set<string> {
	const anchors = new Set<string>();
	let inCode = false;
	for (const line of read(doc).split('\n')) {
		if (line.startsWith('```')) inCode = !inCode;
		if (inCode || !/^#{1,6} /.test(line)) continue;
		anchors.add(line.replace(/^#+ /, '').trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-'));
	}
	return anchors;
}

describe('documentation links', () => {
	it('point to files and headings that exist', () => {
		const repoHome = 'https://github.com/yuridivonis/whoop-mcp-server#';
		for (const doc of ['README.md', 'SECURITY.md', 'PRIVACY.md', 'CHANGELOG.md', 'docs/add-to-your-ai.md', 'packages/whoop-client/README.md']) {
			for (const [, link] of read(doc).matchAll(/\]\(([^)\s]+)\)/g)) {
				let target: string;
				if (link.startsWith(repoHome)) target = `README.md${link.slice(repoHome.length - 1)}`;
				else if (/^[a-z]+:/.test(link)) continue;
				else target = link.startsWith('#') ? `${doc}${link}` : new URL(link, `file:///${doc}`).pathname.slice(1) + (link.includes('#') ? `#${link.split('#')[1]}` : '');
				const [file, anchor] = target.split('#');
				assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `${doc} links to ${link}: ${file} is missing`);
				if (anchor && file.endsWith('.md')) {
					assert.ok(headingAnchors(file).has(anchor), `${doc} links to ${link}: ${file} has no heading #${anchor}`);
				}
			}
		}
	});

	it('from the set-up page point to files and README headings that exist', () => {
		const repo = 'https://github.com/yuridivonis/whoop-mcp-server';
		const links = [...read('src/first-run-page.ts').matchAll(/https:\/\/github\.com\/yuridivonis\/whoop-mcp-server[^'"`\s)]*/g)].map(match => match[0]);
		const templated = [...read('src/first-run-page.ts').matchAll(/\$\{REPO\}(\/blob\/main\/[^'"`\s)]+|#[\w-]+)/g)].map(match => `${repo}${match[1]}`);
		assert.ok(templated.length >= 4, 'the page links into the repository');
		for (const link of [...links, ...templated]) {
			const rest = link.slice(repo.length);
			if (rest.startsWith('/blob/main/')) {
				assert.ok(existsSync(new URL(`../${rest.slice('/blob/main/'.length)}`, import.meta.url)), `${link}: file is missing`);
			} else if (rest.startsWith('#')) {
				assert.ok(headingAnchors('README.md').has(rest.slice(1)), `${link}: README has no such heading`);
			}
		}
	});
});

describe('README', () => {
	it('has the Deploy on Railway button, pointing at the published template with the campaign that names this project', () => {
		const readme = read('README.md');
		assert.ok(readme.includes('[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/rt-2HZ?referralCode=U4Y3-R&utm_medium=integration&utm_source=button&utm_campaign=whoop-mcp-server)'));
		assert.match(readme, /Tested live on \d{4}-\d{2}-\d{2}\./);
		const disclosure = readme.indexOf('Railway pays template creators a share of what deployments spend, and the link carries a referral code');
		assert.ok(disclosure > 0, 'the kickback and the referral are disclosed');
		assert.ok(disclosure < readme.indexOf('railway.com/button.svg'), 'before the button');
		assert.ok(readme.indexOf('railway.com/button.svg') < readme.indexOf('### 1. Deploy'), 'the button comes first in Setup');
	});

	it('deploys the :1 tag everywhere, which moves with every 1.x release, and pins no version', () => {
		const readme = read('README.md');
		const tags = [...readme.matchAll(/ghcr\.io\/yuridivonis\/whoop-mcp-server:([\w.-]+)/g)].map(match => match[1]);
		assert.ok(tags.length >= 3);
		assert.deepEqual([...new Set(tags)], ['1'], 'every tagged image mention uses :1');
	});
});

describe('release workflow', () => {
	const workflow = read('.github/workflows/release.yml');

	it('publishes the image under its version, its major version and latest', () => {
		assert.match(workflow, /\$\{\{ env\.IMAGE \}\}:\$\{\{ needs\.release\.outputs\.version \}\}/);
		assert.match(workflow, /format\('\{0\}:\{1\}', env\.IMAGE, needs\.release\.outputs\.major\)/);
		assert.match(workflow, /format\('\{0\}:latest', env\.IMAGE\)/);
		assert.match(workflow, /echo "major=\$\{version%%\.\*\}"/);
	});

	it('publishes to the MCP Registry only a version it does not list yet', () => {
		assert.match(workflow, /id: listed/);
		for (const step of ['Install mcp-publisher', 'Sign in to the MCP Registry', 'Publish server.json']) {
			const block = workflow.slice(workflow.indexOf(`- name: ${step}`)).split('\n').slice(0, 2).join('\n');
			assert.match(block, /if: steps\.listed\.outputs\.listed != 'true'/, step);
		}
	});

	it('runs as the last job of CI on main, once every other job has passed', () => {
		const ci = read('.github/workflows/ci.yml');
		const jobs = ci.slice(ci.indexOf('\njobs:\n'));
		const names = [...jobs.matchAll(/^  ([a-z-]+):$/gm)].map(match => match[1]);
		const caller = jobs.slice(jobs.indexOf('\n  release:\n'));
		assert.match(caller, /uses: \.\/\.github\/workflows\/release\.yml/);
		assert.deepEqual(caller.match(/needs: \[([^\]]+)\]/)?.[1].split(', ').sort(), names.filter(name => name !== 'release').sort());
		assert.match(caller, /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'.* && needs\.pending\.outputs\.release == 'true'$/m,
			'only a push with something to release queues for it');
		assert.match(caller, /group: release\n\s+cancel-in-progress: false/, 'releases queue, never cancel');
		const pending = jobs.slice(jobs.indexOf('\n  pending:\n'), jobs.indexOf('\n  release:\n'));
		assert.match(pending, /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
		for (const lookup of [pending, workflow]) {
			assert.match(lookup, /grep -q 'HTTP 404'/, 'only "not found" means there is no release');
		}
		assert.match(workflow, /^  workflow_call:$/m);
		assert.doesNotMatch(workflow, /workflow_run|pull_request_target/, 'no trigger that runs with write access on untrusted code');
		// A manual run shares the caller's group; a called run must not, or it would wait on its caller.
		assert.match(workflow, /^concurrency:\n  group: \$\{\{ github\.event_name == 'workflow_dispatch' && 'release' \|\| format\('release-\{0\}', github\.run_id\) \}\}\n  cancel-in-progress: false$/m);
	});

	it('moves :latest and the major tag only to the newest release', () => {
		const moving = workflow.split('\n').filter(line => /:latest|outputs\.major\)/.test(line) && line.includes('format('));
		assert.equal(moving.length, 2);
		for (const line of moving) assert.match(line, /needs\.release\.outputs\.newest == 'true' &&/);
	});
});

describe('Scorecard workflow', () => {
	const workflow = read('.github/workflows/scorecard.yml');

	it("keeps to Scorecard's rules for publishing results, which the badge needs", () => {
		assert.match(workflow, /^permissions: \{\}$/m, 'no workflow-level write permissions');
		assert.doesNotMatch(workflow, /^(env|defaults):/m, 'no top-level env or defaults');
		assert.match(workflow, /publish_results: true/);
		const actions = [...workflow.matchAll(/uses: ([^@\s]+)@([0-9a-f]{40}) #/g)].map(match => match[1]);
		assert.deepEqual(actions, ['actions/checkout', 'ossf/scorecard-action', 'actions/upload-artifact', 'github/codeql-action/upload-sarif']);
		assert.equal([...workflow.matchAll(/uses: /g)].length, actions.length, 'every action is pinned to a commit');
		assert.doesNotMatch(workflow, /^\s+run:/m, 'no shell steps');
		assert.doesNotMatch(workflow, /^\s{4}(env|defaults|container|services):/m, 'no job-level env, defaults, containers or services');
		assert.match(workflow, /runs-on: ubuntu-/);
	});
});

describe('licence check', () => {
	it('accepts permissive licences and refuses the rest', () => {
		assert.ok(licenseAllowed('MIT'));
		assert.ok(licenseAllowed('(MIT OR GPL-3.0)'), 'one permissive alternative is enough');
		assert.ok(!licenseAllowed('GPL-3.0'));
		assert.ok(!licenseAllowed('MIT AND GPL-3.0'), 'every licence in an AND must be allowed');
		assert.ok(!licenseAllowed(undefined), 'no declared licence is refused');
		assert.ok(!licenseAllowed('GPL-3.0 AND (MIT OR ISC)'), 'brackets group before AND applies');
		assert.ok(licenseAllowed('(MIT OR Apache-2.0) AND BSD-3-Clause'));
		assert.ok(!licenseAllowed('MIT WITH Classpath-exception-2.0'), 'exceptions are refused');
		assert.ok(!licenseAllowed('(MIT'), 'malformed expressions are refused');
	});
});

describe('the WHOOP client package', () => {
	const pkg = JSON.parse(read('packages/whoop-client/package.json')) as Record<string, unknown>;
	const root = JSON.parse(read('package.json')) as { author: string; dependencies: Record<string, string> };

	it('is ready to publish, but kept private until then', () => {
		assert.equal(pkg.name, '@yuridivonis/whoop-client');
		assert.equal(pkg.private, true, 'flipped when it is published');
		assert.equal(pkg.license, 'MIT');
		assert.equal(pkg.type, 'module');
		assert.equal(pkg.sideEffects, false);
		assert.equal(pkg.author, root.author);
		assert.ok(typeof pkg.description === 'string' && pkg.description.length > 0);
		assert.deepEqual(pkg.repository, { type: 'git', url: 'https://github.com/yuridivonis/whoop-mcp-server', directory: 'packages/whoop-client' });
		assert.equal(pkg.homepage, 'https://github.com/yuridivonis/whoop-mcp-server/tree/main/packages/whoop-client#readme');
		assert.deepEqual(pkg.bugs, { url: 'https://github.com/yuridivonis/whoop-mcp-server/issues' });
		assert.deepEqual(pkg.exports, { '.': { types: './dist/index.d.ts', default: './dist/index.js' } });
		assert.equal(pkg.main, './dist/index.js');
		assert.equal(pkg.types, './dist/index.d.ts');
		assert.deepEqual(pkg.files, ['dist', 'src']);
		assert.deepEqual(pkg.engines, { node: '>=22' });
		assert.deepEqual(pkg.publishConfig, { access: 'public' });
	});

	it('has no runtime dependencies of its own', () => {
		for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
			assert.equal(pkg[field], undefined, `no ${field}`);
		}
	});

	it('is the exact version the server depends on, so npm always links the workspace', () => {
		assert.equal(root.dependencies['@yuridivonis/whoop-client'], pkg.version);
	});

	it('carries the licence and the not-affiliated line', () => {
		assert.equal(read('packages/whoop-client/LICENSE'), read('LICENSE'));
		assert.match(
			read('packages/whoop-client/README.md'),
			/It uses the WHOOP API to access data from WHOOP products, and is not affiliated with, endorsed by, or sponsored by WHOOP\./,
		);
	});

	it('would publish only its build, its source, the README and the licence', () => {
		// On Windows npm is npm.cmd, which needs a shell; there the command goes as one string (DEP0190).
		const command = 'npm pack --dry-run --json --workspace @yuridivonis/whoop-client';
		const options: ExecFileSyncOptionsWithStringEncoding = { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] };
		const output = process.platform === 'win32' ? execFileSync(command, { ...options, shell: true }) : execFileSync('npm', command.split(' ').slice(1), options);
		const [{ files }] = JSON.parse(output) as { files: { path: string }[] }[];
		const paths = files.map(file => file.path);
		for (const path of paths) {
			assert.ok(
				['package.json', 'README.md', 'LICENSE'].includes(path) ||
					/^dist\/[\w./-]+\.(js|d\.ts|js\.map|d\.ts\.map)$/.test(path) ||
					/^src\/[\w./-]+\.ts$/.test(path),
				`${path} would be published`,
			);
		}
		assert.ok(paths.includes('dist/index.js') && paths.includes('dist/index.d.ts'), 'the build is in it');
	});

	it('is used by the server through its name only, never a path into its source', () => {
		const files = [
			...readdirSync(new URL('../src/', import.meta.url), { recursive: true }).map(file => `src/${String(file)}`),
			...readdirSync(new URL('./', import.meta.url), { recursive: true }).map(file => `test/${String(file)}`),
		].filter(file => file.endsWith('.ts'));
		for (const file of files) {
			for (const [, specifier] of read(file).matchAll(/(?:from|import\s*\()\s*['"]([^'"]+)['"]/g)) {
				if (!specifier.includes('packages/whoop-client')) continue;
				assert.match(specifier, /^\.\.\/packages\/whoop-client\/test\/fake-whoop\.js$/, `${file} imports ${specifier}`);
			}
		}
	});
});
