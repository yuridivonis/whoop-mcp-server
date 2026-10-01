import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import { readFileSync } from 'node:fs';
import { COPY_SCRIPT, REFRESH_SECONDS } from '../src/first-run-page.js';
import { SERVER_VERSION } from '../src/tools.js';
import { PASSWORD, mcpRequest, readRpc, signIn, startTestServer, type TestServer } from './helpers.js';

/** What the public page must never contain, whatever the server's state. */
function assertRevealsNothing(body: string): void {
	for (const secret of [PASSWORD, 'test-client-secret', 'test-client-id', SERVER_VERSION]) {
		assert.ok(!body.includes(secret), `the page must not show ${secret}`);
	}
	assert.doesNotMatch(body, /connected/i, 'the page says nothing about the WHOOP connection');
	// It names Railway in its instructions for everyone; it must not name or branch on Railway's variables.
	assert.doesNotMatch(body, /RAILWAY/, "the page doesn't reveal which host's variables the server sees");
}

/** The page runs the Copy script and nothing else: the policy names it by hash, and it parses. */
function assertOnlyTheCopyScript(res: Response, body: string): void {
	// Counted as text, not with a tag regex: a <SCRIPT or <script src=…> in any spelling counts.
	assert.equal(body.toLowerCase().split('<script').length - 1, 1, 'exactly one script element');
	const start = body.indexOf('<script>') + '<script>'.length;
	const scripts = start > '<script>'.length - 1 ? [body.slice(start, body.indexOf('</script>', start))] : [];
	assert.deepEqual(scripts, [COPY_SCRIPT], 'the script is the static constant, served whole');
	new Script(COPY_SCRIPT); // throws on a syntax error, which would leave every button hidden
	const hash = createHash('sha256').update(scripts[0]).digest('base64');
	assert.equal(res.headers.get('content-security-policy'), `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${hash}'; frame-ancestors 'none'`);
	assert.doesNotMatch(COPY_SCRIPT, /\$\{|\bon\w+=/, 'nothing interpolated, no inline handlers');
	assert.doesNotMatch(body, /\son\w+="|javascript:/i, 'no inline handlers or javascript: links: the policy would block them');
}

/** The values to paste, in page order, each in a box with a Copy button. */
function boxes(body: string): string[] {
	return [...body.matchAll(/<p class="box"><code>([^<]+)<\/code><button type="button" data-copy hidden aria-live="polite" aria-label="Copy the [^"]+">Copy<\/button><\/p>/g)].map(match => match[1]);
}

/** The state and title of each chain step, in page order; the current one is marked for screen readers too. */
function steps(body: string): string[] {
	return [...body.matchAll(/<li class="(done|current|todo)"( aria-current="step")?>\n\s*<h2>([^<]+)<\/h2>/g)].map(match => {
		assert.equal(match[2] !== undefined, match[1] === 'current', `${match[3]}: aria-current marks exactly the current step`);
		return `${match[1]}:${match[3]}`;
	});
}

const JOURNEY = ['Server running', 'Create your WHOOP app', 'Give this server the keys'];
const IN_THE_APP = ['Connect your AI app', 'Ask your first question'];

/** The two parts that happen in the AI app: a panel between the chain and Updates, numbered 4 and 5, never chain steps. */
function appSections(body: string): string[] {
	const panel = body.slice(body.indexOf('</ol>\n  <section class="app"'), body.indexOf('<h2>Updates</h2>'));
	assert.ok(panel.includes('<section class="app" aria-labelledby="then">') && panel.includes('</section>'), 'the panel sits between the chain and Updates');
	const parts = [...panel.matchAll(/<article>\n\s*<h3><span class="badge"><span class="sr">Step <\/span>(\d)<\/span>([^<]+)<\/h3>/g)];
	assert.deepEqual(parts.map(match => match[1]), ['4', '5'], 'numbered on from the chain, in order');
	return parts.map(match => match[2]);
}

/** The click paths on the page must be the ones in docs/add-to-your-ai.md, which is checked against the vendors' docs. */
function assertPathsMatchTheDoc(body: string): void {
	const doc = readFileSync(new URL('../docs/add-to-your-ai.md', import.meta.url), 'utf8');
	for (const label of ['Customize → Connectors', 'Add custom connector', 'Create MCP App', 'Developer mode', 'Settings → Security and login', 'Dynamic client registration', 'Help Improve our AI models', 'Improve the model for everyone', 'MCP apps are web-only']) {
		assert.ok(body.includes(label), `page: ${label}`);
		assert.ok(doc.includes(label), `doc: ${label}`);
	}
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

	it('ticks all three chain steps, then shows the address, the password and the Claude and ChatGPT paths in the panel, and how updates work', async () => {
		const { res, body } = await page(server);
		assert.equal(res.status, 200);
		assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
		assert.ok(body.includes('<h1>Your MCP server is ready</h1>'));
		assert.deepEqual(steps(body), JOURNEY.map(title => `done:${title}`), 'the whole chain is ticked: nothing is left hanging');
		assert.deepEqual(appSections(body), IN_THE_APP);
		assert.ok(body.includes('<h2 class="eyebrow" id="then">Done here. The rest happens in your AI app</h2>'));
		assert.ok(body.includes('not affiliated with WHOOP.'));
		assert.ok(body.includes(`<code>${server.baseUrl}/mcp</code>`));
		assert.ok(body.includes('<code>MCP_AUTH_PASSWORD</code>'));
		assert.ok(body.includes('<dt>Claude</dt>') && body.includes('<dt>ChatGPT</dt>'));
		assertPathsMatchTheDoc(body);
		const training = body.indexOf('Keep your WHOOP data out of model training');
		assert.ok(training >= 0 && training < body.indexOf('<dt>Claude</dt>'), 'the opt-outs come before the paths');
		assert.ok(body.includes('The first such question brings an authorization link'));
		assert.ok(body.includes("ChatGPT's MCP apps are web-only"));
		assert.ok(body.includes('Configure Auto Updates'));
		assert.ok(body.includes('With Docker, pull <code>:1</code> again and restart.'));
		assert.doesNotMatch(body, /<[^>]*\sdata-wait/, 'nothing left to wait for, so no reload');
		assert.ok(!body.includes('reloaded by itself'));
		assert.ok(body.includes('Done: both keys are in. To change them later:'));
		// Nothing is hidden once done: the instructions, with the variable names, stay on the page, and stay true.
		assert.ok(body.includes('<code>WHOOP_CLIENT_ID</code>: paste the new Client ID over the current value.'));
		assert.ok(!body.includes('replace-with-your-client-id'), 'the placeholder is gone, so the page no longer asks to select it');
		assert.ok(body.includes('<dt>Redirect URLs</dt>'));
	});

	it('still shows the Redirect URL to check, with the WHOOP form around it', async () => {
		const { body } = await page(server);
		assert.deepEqual(boxes(body), ['https://github.com/yuridivonis/whoop-mcp-server/blob/main/PRIVACY.md', `${server.baseUrl}/callback`, `${server.baseUrl}/mcp`]);
		assert.ok(body.includes('Done. Check the Redirect URL below matches the one in your WHOOP app. To change a field, edit the app in the dashboard.'));
		assert.ok(body.includes('If you add a custom domain later'));
	});

	it('sends the same headers as the sign-in pages, allowing only its own Copy script, and asks not to be indexed', async () => {
		const { res, body } = await page(server);
		assertOnlyTheCopyScript(res, body);
		assert.equal(res.headers.get('x-frame-options'), 'DENY');
		assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
		assert.equal(res.headers.get('cache-control'), 'no-store');
		assert.ok(body.includes('<meta name="robots" content="noindex">'));
	});

	it('reveals no secret, no version, no connection state, and nothing server-specific about hosting', async () => {
		assertRevealsNothing((await page(server)).body);
	});

	it('is built from the config alone: the request changes nothing', async () => {
		const plain = (await page(server)).body;
		const res = await fetch(`${server.baseUrl}/?next=https://evil.example/<script>`, { headers: { Host: 'evil.example' } });
		assert.equal(await res.text(), plain);
	});

	it("warns when the Redirect URL isn't https, and not otherwise, however the scheme is spelled", async () => {
		assert.ok((await page(server)).body.includes('<strong>Running on your own computer?</strong> WHOOP only accepts https addresses'), 'the test server has an http callback');
		const secure = await startTestServer({ env: { WHOOP_REDIRECT_URI: ' HTTPS://whoop.example.com/callback' } });
		try {
			const { body } = await page(secure);
			assert.ok(body.includes('<code>https://whoop.example.com/callback</code>'));
			assert.ok(!body.includes('WHOOP only accepts https addresses'));
		} finally {
			await secure.close();
		}
	});

	it('shows the Redirect URL without any credentials or query the operator put in it, says so, and escapes it', async () => {
		const odd = await startTestServer({ env: { WHOOP_REDIRECT_URI: 'https://user:hunter2@whoop.example.com:8443/cb/&copy;/<x>?key=private-token#frag' } });
		try {
			const { body } = await page(odd);
			// The URL parser keeps & and percent-encodes < >; the page must escape what's left.
			assert.ok(body.includes('<code>https://whoop.example.com:8443/cb/&amp;copy;/%3Cx%3E</code>'));
			assert.ok(body.includes('Register the exact value you configured.'));
			for (const secret of ['hunter2', 'user:', 'private-token', 'frag', '<x>', '/&copy;']) {
				assert.ok(!body.includes(secret), `the page must not show ${secret}`);
			}
		} finally {
			await odd.close();
		}
		assert.ok(!(await page(server)).body.includes('Register the exact value'), 'no such note for an ordinary address');
	});

	it('looks the same whatever host it runs on, given the same addresses', async () => {
		const railway = await startTestServer({ env: { RAILWAY_ENVIRONMENT_ID: 'env-123', RAILWAY_PUBLIC_DOMAIN: 'whoop-abc.up.railway.app' } });
		try {
			// Both servers get explicit addresses from the helper; only the hosting variables differ.
			const a = (await page(server)).body.replaceAll(server.baseUrl, 'BASE');
			const b = (await page(railway)).body.replaceAll(railway.baseUrl, 'BASE');
			assert.equal(b, a);
		} finally {
			await railway.close();
		}
	});

	it('looks the same whether or not WHOOP is connected', async () => {
		const before = (await page(server)).body;
		server.db.saveTokens({ access_token: 'whoop-access-token', refresh_token: 'whoop-refresh-token', expires_at: Date.now() + 3_600_000 });
		const after = (await page(server)).body;
		assert.equal(after, before);
		assert.ok(!after.includes('whoop-access-token') && !after.includes('whoop-refresh-token'));
	});
});

describe("the set-up page, before the WHOOP app is configured", () => {
	let server: TestServer;
	before(async () => {
		server = await startTestServer({ env: { WHOOP_CLIENT_ID: '', WHOOP_CLIENT_SECRET: '' } });
	});
	after(() => server.close());

	it('ticks step 1, opens step 2 with the exact Redirect URL, shows the keys step and the connector step for later, and reloads itself', async () => {
		const { res, body } = await page(server);
		assert.equal(res.status, 200);
		assert.ok(body.includes('<h1>Configure your MCP server</h1>'));
		assert.deepEqual(steps(body), JOURNEY.map((title, i) => `${i === 0 ? 'done' : i === 1 ? 'current' : 'todo'}:${title}`));
		assert.deepEqual(appSections(body), IN_THE_APP, 'shown in full from the start');
		assert.ok(body.includes('<h2 class="eyebrow" id="then">Then, in your AI app</h2>'));
		assert.ok(!body.includes('Done'), 'no "Done" note while waiting');
		assert.ok(body.includes('not affiliated with WHOOP.'));
		assert.ok(body.includes(`<code>${server.baseUrl}/callback</code>`));
		assert.ok(body.includes('href="https://developer-dashboard.whoop.com"'));
		// The reload runs only while the tab is hidden, from the one script, and only on a waiting page.
		assert.ok(body.includes('<ol data-wait>'));
		assert.ok(!body.includes('http-equiv'), 'no meta refresh: it would restart screen readers and drop selections');
		assert.ok(COPY_SCRIPT.includes(`if (document.hidden) location.reload(); }, ${REFRESH_SECONDS * 1000});`));
		assert.ok(REFRESH_SECONDS >= 10, 'no reload loop');
		assert.ok(body.includes('Seeing an error page? Check on Railway that the deploy has finished, then reload.'));
		for (const scope of ['read:recovery', 'read:cycles', 'read:sleep', 'read:workout']) {
			assert.ok(body.includes(`<code>${scope}</code>`), scope);
		}
		assert.ok(body.includes('<h2>Give this server the keys</h2>'));
		assert.ok(body.includes('<code>WHOOP_CLIENT_ID</code>: select <code>replace-with-your-client-id</code> and paste the Client ID over it.'));
		assert.ok(body.includes('<code>WHOOP_CLIENT_SECRET</code>: select <code>replace-with-your-client-secret</code> and paste the Client Secret over it.'));
		assert.ok(body.includes('with nothing left of <code>replace-with-…</code>.'));
		assert.ok(body.includes(`<code>${server.baseUrl}/mcp</code>`), 'the address is on the page from the start');
		assert.ok(body.includes("Once step 3 is done. Step 3 doesn't change the address."));
		assertPathsMatchTheDoc(body);
		assert.ok(body.includes('Configure Auto Updates'), 'the Updates section is there in both states');
	});

	it('is built from the config alone here too: the request changes nothing', async () => {
		const plain = (await page(server)).body;
		const res = await fetch(`${server.baseUrl}/?next=https://evil.example/<script>`, { headers: { Host: 'evil.example' } });
		assert.equal(await res.text(), plain);
	});

	it("walks through WHOOP's New App form in its order, with a Copy button on each value to paste", async () => {
		const { body } = await page(server);
		const labels = [...body.matchAll(/<dt>([^<]+)<\/dt>/g)].map(match => match[1]);
		assert.deepEqual(labels, ['Name', 'Logo', 'Contacts', 'Privacy Policy', 'Redirect URLs', 'Scopes', 'Webhooks', 'Claude', 'ChatGPT', 'Other apps'], "WHOOP's form in its order, then the apps");
		assert.deepEqual(boxes(body), ['https://github.com/yuridivonis/whoop-mcp-server/blob/main/PRIVACY.md', `${server.baseUrl}/callback`, `${server.baseUrl}/mcp`]);
		const createApp = body.indexOf('Create App');
		assert.ok(createApp >= 0 && createApp < body.indexOf('<h2>Give this server the keys</h2>'), 'the keys come after the app exists');
		const scopes = [...body.matchAll(/<li class="(on|off)"><span class="sr">(Tick|Leave unticked) <\/span><code>([^<]+)<\/code><\/li>/g)].map(match => {
			assert.equal(match[2], match[1] === 'on' ? 'Tick' : 'Leave unticked', `${match[3]}: the words for screen readers match the box`);
			return `${match[1]}:${match[3]}`;
		});
		assert.deepEqual(scopes, ['on:read:recovery', 'on:read:cycles', 'on:read:sleep', 'on:read:workout', 'off:read:profile', 'off:read:body_measurement'], 'the four to tick, then the two to leave');
		assert.ok(body.includes('Keep this page open until the end'));
		assert.ok(body.includes("<strong>Keep your WHOOP data out of model training.</strong> WHOOP's terms forbid using it to train AI"), 'the terms, not a preference');
	});

	it('runs only the Copy script here too', async () => {
		const { res, body } = await page(server);
		assertOnlyTheCopyScript(res, body);
	});

	it('treats the placeholder the Railway template ships as not configured, whatever its case', async () => {
		// Each value alone would keep the page in set-up, so each needs the case and whitespace handling.
		const placeholder = await startTestServer({ env: { WHOOP_CLIENT_ID: ' Replace-With-Your-Client-ID', WHOOP_CLIENT_SECRET: ' REPLACE-WITH-YOUR-CLIENT-SECRET' } });
		try {
			const { body } = await page(placeholder);
			assert.ok(body.includes('<h1>Configure your MCP server</h1>'));
			assert.ok(!body.includes('Replace-With-Your-Client-ID'));
		} finally {
			await placeholder.close();
		}
	});

	it('reveals no secret, no version, no connection state, and nothing server-specific about hosting', async () => {
		assertRevealsNothing((await page(server)).body);
	});

	it('makes get_auth_url point at this page for a signed-in app, over HTTP', async () => {
		const { tokens } = await signIn(server.baseUrl);
		const call = await mcpRequest(server.baseUrl, tokens.access_token, { method: 'tools/call', params: { name: 'get_auth_url', arguments: {} } });
		const body = await readRpc<{ result: { content: { text: string }[] } }>(call);
		assert.equal(body.result.content[0].text, `This server's WHOOP app isn't configured yet. Open ${server.baseUrl}/ for the steps.`);
		assert.equal(server.whoop.requests.length, 0);
	});
});
