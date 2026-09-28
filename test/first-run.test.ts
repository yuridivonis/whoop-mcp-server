import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SERVER_VERSION } from '../src/tools.js';
import { PASSWORD, startTestServer, type TestServer } from './helpers.js';

/** What the public page must never contain, whatever the server's state. */
function assertRevealsNothing(body: string): void {
	for (const secret of [PASSWORD, 'test-client-secret', 'test-client-id', SERVER_VERSION]) {
		assert.ok(!body.includes(secret), `the page must not show ${secret}`);
	}
	assert.doesNotMatch(body, /connected/i, 'the page says nothing about the WHOOP connection');
	assert.doesNotMatch(body, /RAILWAY/, 'the page says nothing about where the server is hosted');
}

async function page(server: TestServer): Promise<{ res: Response; body: string }> {
	const res = await fetch(`${server.baseUrl}/`);
	return { res, body: await res.text() };
}

describe('the set-up page, once the WHOOP app is configured', () => {
	let server: TestServer;
	before(async () => {
		server = await startTestServer();
	});
	after(() => server.close());

	it('says where to connect an AI app, where the password is, and how updates work', async () => {
		const { res, body } = await page(server);
		assert.equal(res.status, 200);
		assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
		assert.ok(body.includes('<h1>Your server is ready</h1>'));
		assert.ok(body.includes(`<code>${server.baseUrl}/mcp</code>`));
		assert.ok(body.includes('<code>MCP_AUTH_PASSWORD</code>'));
		assert.ok(body.includes('Configure Auto Updates'));
		assert.ok(body.includes('With Docker, pull <code>:1</code> again and restart. With a fork, sync it and redeploy.'));
		assert.ok(!body.includes('Step 1'));
	});

	it('still shows the Redirect URL to check, and how to find the WHOOP app step', async () => {
		const { body } = await page(server);
		assert.ok(body.includes(`<code>${server.baseUrl}/callback</code>`));
		assert.ok(body.includes('Check it matches the Redirect URL in your WHOOP app.'));
		assert.ok(body.includes('Not created it yet, or pasted a placeholder?'));
		assert.ok(body.includes('If you add a custom domain later'));
	});

	it('sends the same headers as the sign-in pages, and asks not to be indexed', async () => {
		const { res, body } = await page(server);
		assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
		assert.equal(res.headers.get('x-frame-options'), 'DENY');
		assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
		assert.equal(res.headers.get('cache-control'), 'no-store');
		assert.ok(body.includes('<meta name="robots" content="noindex">'));
	});

	it('reveals no secret, no version, no connection state, and nothing about the host', async () => {
		assertRevealsNothing((await page(server)).body);
	});

	it('is built from the config alone: the request changes nothing', async () => {
		const plain = (await page(server)).body;
		const res = await fetch(`${server.baseUrl}/?next=https://evil.example/<script>`, { headers: { Host: 'evil.example' } });
		assert.equal(await res.text(), plain);
	});

	it("warns when the Redirect URL isn't https, and not otherwise", async () => {
		assert.ok((await page(server)).body.includes('WHOOP only accepts https addresses'), 'the test server has an http callback');
		const secure = await startTestServer({ env: { WHOOP_REDIRECT_URI: 'https://whoop.example.com/callback' } });
		try {
			const { body } = await page(secure);
			assert.ok(body.includes('<code>https://whoop.example.com/callback</code>'));
			assert.ok(!body.includes('WHOOP only accepts https addresses'));
		} finally {
			await secure.close();
		}
	});
});

describe("the set-up page, before the WHOOP app is configured", () => {
	let server: TestServer;
	before(async () => {
		server = await startTestServer({ env: { WHOOP_CLIENT_ID: '', WHOOP_CLIENT_SECRET: '' } });
	});
	after(() => server.close());

	it('shows the exact Redirect URL to register and the two steps, and nothing about connecting an AI yet', async () => {
		const { res, body } = await page(server);
		assert.equal(res.status, 200);
		assert.ok(body.includes('<h1>Set up your server</h1>'));
		assert.ok(body.includes(`<code>${server.baseUrl}/callback</code>`));
		assert.ok(body.includes('Step 1 of 2: create your WHOOP app'));
		assert.ok(body.includes('href="https://developer-dashboard.whoop.com"'));
		for (const scope of ['read:recovery', 'read:cycles', 'read:sleep', 'read:workout']) {
			assert.ok(body.includes(`<code>${scope}</code>`), scope);
		}
		assert.ok(body.includes('Step 2 of 2'));
		assert.ok(body.includes('<code>WHOOP_CLIENT_ID</code> and <code>WHOOP_CLIENT_SECRET</code>'));
		assert.ok(!body.includes('/mcp'));
		assert.ok(!body.includes('Configure Auto Updates'));
	});

	it('reveals no secret, no version, no connection state, and nothing about the host', async () => {
		assertRevealsNothing((await page(server)).body);
	});
});
