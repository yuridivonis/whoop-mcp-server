import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
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

describe('release workflow', () => {
	const workflow = read('.github/workflows/release.yml');

	it('publishes the image under its version, its major version and latest', () => {
		assert.match(workflow, /\$\{\{ env\.IMAGE \}\}:\$\{\{ needs\.release\.outputs\.version \}\}/);
		assert.match(workflow, /format\('\{0\}:\{1\}', env\.IMAGE, needs\.release\.outputs\.major\)/);
		assert.match(workflow, /format\('\{0\}:latest', env\.IMAGE\)/);
		assert.match(workflow, /echo "major=\$\{version%%\.\*\}"/);
	});

	it('moves :latest and the major tag only to the newest release', () => {
		const moving = workflow.split('\n').filter(line => /:latest|outputs\.major\)/.test(line) && line.includes('format('));
		assert.equal(moving.length, 2);
		for (const line of moving) assert.match(line, /needs\.release\.outputs\.newest == 'true' &&/);
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
