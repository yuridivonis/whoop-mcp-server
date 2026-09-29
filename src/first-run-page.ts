import type { Response } from 'express';
import { PLACEHOLDER, type Config } from './config.js';
import { escapeHtml, page, send } from './auth/login-page.js';

const REPO = 'https://github.com/yuridivonis/whoop-mcp-server';
const PRIVACY = `${REPO}/blob/main/PRIVACY.md`;
const DASHBOARD = 'https://developer-dashboard.whoop.com';

/**
 * The Copy buttons. They start hidden and appear only once this runs, so without scripts
 * the page still reads well and each value box selects whole on a click. The script is
 * static (nothing from the config goes in), so its hash is fixed, and the page's
 * Content-Security-Policy allows exactly this script and nothing else (see send).
 */
export const COPY_SCRIPT = `for (const button of document.querySelectorAll('button[data-copy]')) {
  const value = button.previousElementSibling;
  if (!value || value.tagName !== 'CODE') continue;
  const label = button.textContent;
  let timer;
  button.hidden = false;
  button.addEventListener('click', async () => {
    let done = 'Copied';
    try {
      await navigator.clipboard.writeText(value.textContent);
    } catch {
      getSelection().selectAllChildren(value);
      done = 'Selected: copy it';
    }
    button.textContent = done;
    clearTimeout(timer);
    timer = setTimeout(() => { button.textContent = label; }, 2000);
  });
}`;

/**
 * The callback address as the page may show it: scheme, host, port and path only. An
 * operator could put credentials or a query in WHOOP_REDIRECT_URI, and this page is public.
 * The config has already checked that the value parses.
 */
export function publicRedirectUri(redirectUri: string): URL {
	const url = new URL(redirectUri);
	url.username = '';
	url.password = '';
	url.search = '';
	url.hash = '';
	return url;
}

/**
 * The page at /: what's left to do after deploying. Before the WHOOP app is configured it
 * walks through WHOOP's New App form in the form's own order, with the values to paste;
 * after, how to connect an AI app.
 *
 * SECURITY: it's public, and built from the config alone (nothing from the request). It
 * shows addresses, and whether the two WHOOP app variables are set: never a secret, the
 * version, the WHOOP connection, or where the server is hosted.
 */
export function renderFirstRunPage(config: Pick<Config, 'redirectUri' | 'publicUrl' | 'whoopConfigured'>): string {
	const redirectUrl = publicRedirectUri(config.redirectUri);
	const link = (href: string, label: string) => `<a href="${href}" rel="noopener">${label}</a>`;
	/** A value to paste, with its Copy button; `what` names the value for screen readers. */
	const box = (value: string, what: string) =>
		`<p class="box"><code>${escapeHtml(value)}</code><button type="button" data-copy hidden aria-live="polite" aria-label="Copy the ${what}">Copy</button></p>`;

	const httpsNote = redirectUrl.protocol === 'https:'
		? ''
		: `  <p class="note">WHOOP only accepts https addresses. On your own computer, set <code>WHOOP_REDIRECT_URI</code> to your tunnel's <code>/callback</code>.</p>\n`;
	// The page shows the address without credentials or a query; WHOOP gets the configured value.
	const redactedNote = redirectUrl.href === new URL(config.redirectUri).href
		? ''
		: `  <p class="note">Shown without any credentials or query in <code>WHOOP_REDIRECT_URI</code>. Register the exact value you configured.</p>\n`;
	const redirectBox = `${box(redirectUrl.href, 'Redirect URL')}\n${httpsNote}${redactedNote}`;

	const body = config.whoopConfigured
		? `  <h1>Your server is ready</h1>
  <p class="lede">This server is running.</p>
  <div class="setup">
  <h2>Connect your AI app</h2>
  <p>Add this address to it as a custom connector:</p>
${box(new URL('/mcp', config.publicUrl).href, 'server address')}
  <p>It asks for the server password. On Railway that's the <code>MCP_AUTH_PASSWORD</code> variable in the service's <strong>Variables</strong> tab. ${link(`${REPO}/blob/main/docs/add-to-your-ai.md`, 'Add to your AI')} has the steps for each app.</p>
  <p>Then ask it about your recovery. The first answer is a WHOOP link: open it, log in and approve the app, once. From then on it answers.</p>
  <h2>Your WHOOP app's Redirect URL</h2>
${redirectBox}  <p class="note">Check it matches the Redirect URL in your WHOOP app. Not created it yet, or pasted the wrong values? The README's ${link(`${REPO}#2-create-a-whoop-developer-app`, 'Create a Whoop Developer App')} step has the fields.</p>
  <h2>Updates</h2>
  <p>On Railway, turn on <strong>Configure Auto Updates</strong> under <strong>Settings → Source</strong>, and run the <code>:1</code> tag so each 1.x release redeploys it. With Docker, pull <code>:1</code> again and restart. With a fork, sync it and redeploy.</p>
  <p>If you add a custom domain later, open this page again. If the Redirect URL shown here changed, update it in your WHOOP app, or set <code>WHOOP_REDIRECT_URI</code>.</p>
  </div>`
		: `  <h1>Set up your server</h1>
  <p class="lede">This server is running. Two steps left.</p>
  <div class="setup">
  <h2>Step 1 of 2: create your WHOOP app</h2>
  <p>In the ${link(DASHBOARD, 'WHOOP Developer Dashboard')}, open <strong>New App</strong> and fill the form top to bottom:</p>
  <dl class="fields">
    <dt>Name</dt>
    <dd>Anything, e.g. <code>My MCP server</code>. You see it when you approve the app.</dd>
    <dt>Logo</dt>
    <dd>Skip it.</dd>
    <dt>Contacts</dt>
    <dd>Your email. Only WHOOP sees it.</dd>
    <dt>Privacy Policy</dt>
    <dd>This project's, or your own if you run the server for someone else:
${box(PRIVACY, 'privacy policy address')}</dd>
    <dt>Redirect URLs</dt>
    <dd>This server's callback, exactly:
${redirectBox}</dd>
    <dt>Scopes</dt>
    <dd>Tick <code>read:recovery</code>, <code>read:cycles</code>, <code>read:sleep</code> and <code>read:workout</code>. Not <code>read:profile</code> or <code>read:body_measurement</code>.</dd>
    <dt>Webhooks</dt>
    <dd>Skip it.</dd>
  </dl>
  <p>Click <strong>Create App</strong>. WHOOP shows the app's <strong>Client ID</strong> and <strong>Client Secret</strong>: keep that tab open.</p>
  <h2>Step 2 of 2: give this server the keys</h2>
  <ol>
    <li>On Railway, open the service's <strong>Variables</strong> tab.</li>
    <li><code>WHOOP_CLIENT_ID</code>: replace <code>${PLACEHOLDER}</code> with the Client ID.</li>
    <li><code>WHOOP_CLIENT_SECRET</code>: the same, with the Client Secret.</li>
    <li>Click <strong>Deploy</strong> at the top. When it's done, reload this page: it shows how to connect your AI app.</li>
  </ol>
  <p class="note">The two variables aren't there? Add them with <strong>New Variable</strong>. Not on Railway? Set them where you set <code>MCP_AUTH_PASSWORD</code> and restart.</p>
  </div>`;

	return page('Set-up', `${body}
  <footer>
    <p>${link(REPO, 'Source on GitHub')} · ${link(PRIVACY, 'Privacy')} · ${link(`${REPO}/blob/main/SECURITY.md`, 'Security')}</p>
    <p>Open-source project, not affiliated with WHOOP.</p>
  </footer>`, COPY_SCRIPT);
}

export function sendFirstRunPage(res: Response, config: Pick<Config, 'redirectUri' | 'publicUrl' | 'whoopConfigured'>): void {
	send(res, 200, renderFirstRunPage(config), { script: COPY_SCRIPT });
}
