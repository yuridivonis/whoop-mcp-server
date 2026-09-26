import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PendingAuthStates } from '../src/auth-states.js';
import { loadConfig } from '../src/config.js';
import { createMcpServer } from '../src/tools.js';
import { UpdateChecker, isNewer } from '../src/updates.js';
import { WhoopClient } from '../src/whoop-client.js';
import { FakeWhoop } from './fake-whoop.js';
import { memoryDb } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;

interface FakeGitHub {
	fetch: typeof fetch;
	requests: { url: string; init?: RequestInit }[];
}

function fakeGitHub(answer: () => Response | Promise<Response>): FakeGitHub {
	const requests: FakeGitHub['requests'] = [];
	return {
		requests,
		fetch: async (input, init) => {
			requests.push({ url: String(input), init });
			return answer();
		},
	};
}

const release = (tag: string, url = `https://github.com/yuridivonis/whoop-mcp-server/releases/tag/${tag}`) =>
	() => new Response(JSON.stringify({ tag_name: tag, html_url: url }), { headers: { 'Content-Type': 'application/json' } });

function checker(github: FakeGitHub, clock = { now: 0 }, logged: string[] = []): UpdateChecker {
	return new UpdateChecker({ currentVersion: '1.3.0', fetch: github.fetch, now: () => clock.now, log: line => logged.push(line) });
}

describe('update check', () => {
	it('compares versions by number, not as text', () => {
		assert.ok(isNewer('1.10.0', '1.9.9'));
		assert.ok(isNewer('v2.0.0', '1.99.99'));
		assert.ok(!isNewer('1.3.0', '1.3.0'));
		assert.ok(!isNewer('1.2.9', '1.3.0'));
		assert.ok(!isNewer('1.4.0-beta.1', '1.3.0'), "versions it can't read never count as newer");
	});

	it('says nothing until it knows, then names the newer version and its release notes', async () => {
		const updates = checker(fakeGitHub(release('v1.4.0')));
		assert.equal(updates.notice(), null);
		await updates.check();
		const notice = updates.notice() ?? '';
		assert.match(notice, /version 1\.4\.0 .* is out \(this one runs 1\.3\.0\)/);
		assert.match(notice, /https:\/\/github\.com\/yuridivonis\/whoop-mcp-server\/releases\/tag\/v1\.4\.0/);
	});

	it('says nothing when this is the latest version, or newer', async () => {
		for (const tag of ['v1.3.0', 'v1.2.0']) {
			const updates = checker(fakeGitHub(release(tag)));
			await updates.check();
			assert.equal(updates.notice(), null, tag);
		}
	});

	it('sends GitHub nothing about the owner: a plain request for the latest release number', async () => {
		const github = fakeGitHub(release('v1.4.0'));
		await checker(github).check();
		assert.equal(github.requests.length, 1);
		const [{ url, init }] = github.requests;
		assert.equal(url, 'https://api.github.com/repos/yuridivonis/whoop-mcp-server/releases/latest');
		assert.equal(init?.method ?? 'GET', 'GET');
		assert.equal(init?.body, undefined);
		assert.deepEqual(Object.keys(init?.headers ?? {}).sort(), ['Accept', 'User-Agent']);
		assert.equal((init?.headers as Record<string, string>)['User-Agent'], 'whoop-mcp-server', 'no version or other detail');
	});

	it('asks at most once a day', async () => {
		const clock = { now: 0 };
		const github = fakeGitHub(release('v1.4.0'));
		const updates = checker(github, clock);
		await Promise.all([updates.check(), updates.check()]);
		updates.notice();
		clock.now += DAY - 1;
		await updates.check();
		assert.equal(github.requests.length, 1);
		clock.now += 1;
		await updates.check();
		assert.equal(github.requests.length, 2);
	});

	it('stays quiet when GitHub fails, and tries again the next day', async () => {
		const clock = { now: 0 };
		let answer: () => Response | Promise<Response> = () => {
			throw new TypeError('fetch failed');
		};
		const github = fakeGitHub(() => answer());
		const updates = checker(github, clock);
		await updates.check();
		assert.equal(updates.notice(), null);

		answer = () => new Response('rate limited', { status: 403 });
		clock.now += DAY;
		await updates.check();
		assert.equal(updates.notice(), null);

		answer = release('v1.4.0');
		clock.now += DAY;
		await updates.check();
		assert.ok(updates.notice());
	});

	it('tells the server log once about each newer version', async () => {
		const clock = { now: 0 };
		const logged: string[] = [];
		let tag = 'v1.4.0';
		const updates = checker(fakeGitHub(() => release(tag)()), clock, logged);
		await updates.check();
		clock.now += DAY;
		await updates.check();
		tag = 'v1.5.0';
		clock.now += DAY;
		await updates.check();
		assert.deepEqual(logged.map(line => line.match(/is out: ([\d.]+)/)?.[1]), ['1.4.0', '1.5.0']);
	});

	it("links only to this project's own release pages", async () => {
		const updates = checker(fakeGitHub(release('v1.4.0', 'https://example.com/fake-release')));
		await updates.check();
		assert.match(updates.notice() ?? '', /Release notes: https:\/\/github\.com\/yuridivonis\/whoop-mcp-server\/releases$/);
	});

	it('is on unless UPDATE_CHECK turns it off', () => {
		const env = { MCP_MODE: 'stdio' };
		assert.equal(loadConfig(env).updateCheck, true);
		for (const off of ['false', '0', 'off', 'no', ' FALSE ']) {
			assert.equal(loadConfig({ ...env, UPDATE_CHECK: off }).updateCheck, false, off);
		}
		assert.equal(loadConfig({ ...env, UPDATE_CHECK: 'true' }).updateCheck, true);
	});
});

describe('the update notice in get_today', () => {
	async function today(t: TestContext, updates?: UpdateChecker): Promise<string> {
		const db = memoryDb(t);
		db.saveTokens({ access_token: 'whoop-access', refresh_token: 'whoop-refresh', expires_at: Date.now() + DAY });
		const whoop = new FakeWhoop();
		const server = createMcpServer({
			client: new WhoopClient({ clientId: 'id', clientSecret: 'secret', redirectUri: 'http://localhost:3000/callback', store: db.whoopTokens, fetch: whoop.fetch }),
			authStates: new PendingAuthStates(),
			redirectUri: 'http://localhost:3000/callback',
			mode: 'http',
			updates,
		});
		const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
		await server.connect(serverSide);
		const client = new Client({ name: 'test', version: '0' });
		await client.connect(clientSide);
		t.after(() => client.close());
		whoop.records.cycles.push({
			id: 1, user_id: 1, start: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(), end: null, timezone_offset: '+00:00',
			score_state: 'SCORED', score: { strain: 8, kilojoule: 8000, average_heart_rate: 60, max_heart_rate: 150 },
		});
		const result = await client.callTool({ name: 'get_today', arguments: {} });
		return (result.content as { text: string }[])[0].text;
	}

	it('ends the answer with the notice when a newer version is out', async t => {
		const updates = checker(fakeGitHub(release('v1.4.0')));
		await updates.check();
		const text = await today(t, updates);
		assert.match(text, /## Current Strain/);
		assert.match(text, /\n---\nUpdate available: version 1\.4\.0/);
	});

	it('has no notice when the check is off or finds nothing newer', async t => {
		assert.doesNotMatch(await today(t), /Update available/);
		const updates = checker(fakeGitHub(release('v1.3.0')));
		await updates.check();
		assert.doesNotMatch(await today(t, updates), /Update available/);
	});
});
