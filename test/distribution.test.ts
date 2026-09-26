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
			assert.match(source, new RegExp(`\\b${name}\\b`), `${name} is read somewhere in src/`);
		}
	});

	it('points clients at the port the container publishes', () => {
		const url = new URL(image.transport.url);
		const published = image.runtimeArguments.find(arg => arg.name === '-p')?.value.split(':')[0];
		assert.equal(url.port, published);
		assert.equal(image.environmentVariables.find(env => env.name === 'PUBLIC_URL')?.default, url.origin);
	});
});

describe('licence check', () => {
	it('accepts permissive licences and refuses the rest', () => {
		assert.ok(licenseAllowed('MIT'));
		assert.ok(licenseAllowed('(MIT OR GPL-3.0)'), 'one permissive alternative is enough');
		assert.ok(!licenseAllowed('GPL-3.0'));
		assert.ok(!licenseAllowed('MIT AND GPL-3.0'), 'every licence in an AND must be allowed');
		assert.ok(!licenseAllowed(undefined), 'no declared licence is refused');
	});
});
