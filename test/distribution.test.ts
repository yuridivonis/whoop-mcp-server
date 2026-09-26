import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
		for (const doc of ['README.md', 'SECURITY.md', 'PRIVACY.md', 'CHANGELOG.md', 'docs/add-to-your-ai.md']) {
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
});

describe('README', () => {
	it('tells Railway users to deploy the current version, so auto updates start from it', () => {
		const readme = read('README.md');
		assert.match(readme, new RegExp(`enter \`ghcr\\.io/yuridivonis/whoop-mcp-server:${version.replace(/\./g, '\\.')}\``));
		const pinned = [...readme.matchAll(/ghcr\.io\/yuridivonis\/whoop-mcp-server:(\d+\.\d+\.\d+)/g)].map(match => match[1]);
		assert.ok(pinned.length >= 2);
		assert.deepEqual([...new Set(pinned)], [version], 'every pinned image is the current version');
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
