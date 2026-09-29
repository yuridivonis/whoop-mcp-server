import type { Response } from 'express';
import { PLACEHOLDERS, type Config } from './config.js';
import { escapeHtml, page, send } from './auth/login-page.js';

const REPO = 'https://github.com/yuridivonis/whoop-mcp-server';
const PRIVACY = `${REPO}/blob/main/PRIVACY.md`;
const ADD_TO_YOUR_AI = `${REPO}/blob/main/docs/add-to-your-ai.md`;
const DASHBOARD = 'https://developer-dashboard.whoop.com';

/** How often the page checks for the keys while it's waiting for them and its tab is hidden. */
export const REFRESH_SECONDS = 30;

/**
 * The page's only script: the Copy buttons, and the reload while the keys are awaited.
 *
 * The buttons start hidden and appear only once this runs, so without scripts the page
 * still reads well and each value box selects whole on a click. The reload happens only
 * while the tab is hidden (never under a reader, a selection or a screen reader), and only
 * on a page that marks itself as waiting. The script is static (nothing from the config
 * goes in), so its hash is fixed, and the Content-Security-Policy allows exactly this script
 * and nothing else (see send).
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
}
if (document.querySelector('[data-wait]')) {
  setInterval(() => { if (document.hidden) location.reload(); }, ${REFRESH_SECONDS * 1000});
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
 * The page at /: the whole journey from a running server to the first answer, as five
 * steps on one page, with the done ones ticked and the current one marked. Before the WHOOP
 * app is configured it walks through WHOOP's New App form in the form's own order and, while
 * its tab is hidden, reloads until the keys are in; after, it shows how to connect an AI app
 * and what the first question does. Nothing is hidden until later: the connector address is
 * on the page from the start, marked for its step. Steps 4 and 5 happen in the AI app, so the
 * page never ticks them: it shows no connection state.
 *
 * SECURITY: it's public, and built from the config alone (nothing from the request). It
 * shows addresses, and whether the two WHOOP app variables are set: never a secret, the
 * version, the WHOOP connection, or where the server is hosted.
 */
export function renderFirstRunPage(config: Pick<Config, 'redirectUri' | 'publicUrl' | 'whoopConfigured'>): string {
	const configured = config.whoopConfigured;
	const redirectUrl = publicRedirectUri(config.redirectUri);
	const link = (href: string, label: string) => `<a href="${href}" rel="noopener">${label}</a>`;
	/** A value to paste, with its Copy button; `what` names the value for screen readers. */
	const box = (value: string, what: string) =>
		`<p class="box"><code>${escapeHtml(value)}</code><button type="button" data-copy hidden aria-live="polite" aria-label="Copy the ${what}">Copy</button></p>`;
	const step = (n: number, title: string, body: string) => {
		const state = configured ? (n <= 3 ? 'done' : n === 4 ? 'current' : 'todo') : (n === 1 ? 'done' : n === 2 ? 'current' : 'todo');
		return `    <li class="${state}"${state === 'current' ? ' aria-current="step"' : ''}>
      <h2>${title}</h2>
${body}
    </li>`;
	};

	const httpsNote = redirectUrl.protocol === 'https:'
		? ''
		: `      <p class="note">WHOOP only accepts https addresses. On your own computer, set <code>WHOOP_REDIRECT_URI</code> to your tunnel's <code>/callback</code>.</p>\n`;
	// The page shows the address without credentials or a query; WHOOP gets the configured value.
	const redactedNote = redirectUrl.href === new URL(config.redirectUri).href
		? ''
		: `      <p class="note">Shown without any credentials or query in <code>WHOOP_REDIRECT_URI</code>. Register the exact value you configured.</p>\n`;
	const redirectBox = `${box(redirectUrl.href, 'Redirect URL')}\n${httpsNote}${redactedNote}`;

	const whoopApp = configured
		? `      <p>The Redirect URL in your WHOOP app:</p>
${redirectBox}      <p class="note">Check it matches the Redirect URL in your WHOOP app. Not created it yet, or pasted the wrong values? The README's ${link(`${REPO}#2-create-a-whoop-developer-app`, 'Create a Whoop Developer App')} step has the fields.</p>`
		: `      <p>In the ${link(DASHBOARD, 'WHOOP Developer Dashboard')}, open <strong>New App</strong> and fill the form top to bottom:</p>
      <dl class="fields">
        <dt>Name</dt>
        <dd>Anything, e.g. <code>My MCP server</code>. You see it when you approve the app.</dd>
        <dt>Logo</dt>
        <dd>Optional. Skip it, or upload an image to see it on WHOOP's approval screen.</dd>
        <dt>Contacts</dt>
        <dd>Your email. Only WHOOP sees it.</dd>
        <dt>Privacy Policy</dt>
        <dd>This project's, or your own if you run the server for someone else:
${box(PRIVACY, 'privacy policy address')}</dd>
        <dt>Redirect URLs</dt>
        <dd>This server's callback, exactly:
${redirectBox}</dd>
        <dt>Scopes</dt>
        <dd>Tick these four, and leave the other two: the server reads recovery, sleep, strain and workouts, and asks for nothing it doesn't use.
          <ul class="scopes">
            <li class="on"><code>read:recovery</code></li>
            <li class="on"><code>read:cycles</code></li>
            <li class="on"><code>read:sleep</code></li>
            <li class="on"><code>read:workout</code></li>
            <li class="off"><code>read:profile</code></li>
            <li class="off"><code>read:body_measurement</code></li>
          </ul>
        </dd>
        <dt>Webhooks</dt>
        <dd>Leave empty. The server asks WHOOP when you do, and needs no pushes.</dd>
      </dl>
      <p>Click <strong>Create App</strong>. WHOOP shows the app's <strong>Client ID</strong> and <strong>Client Secret</strong>: keep that tab open.</p>`;

	const keys = configured
		? `      <p>Both keys are in.</p>`
		: `      <ol data-wait>
        <li>On Railway, open the service's <strong>Variables</strong> tab.</li>
        <li><code>WHOOP_CLIENT_ID</code>: select <code>${PLACEHOLDERS.clientId}</code> and paste the Client ID over it.</li>
        <li><code>WHOOP_CLIENT_SECRET</code>: select <code>${PLACEHOLDERS.clientSecret}</code> and paste the Client Secret over it.</li>
        <li>Click <strong>Deploy</strong> at the top. When it's done, reload this page: steps 2 and 3 tick. (If you left this tab meanwhile, it has reloaded by itself.) An error page instead means the new deploy is still starting: reload in a few seconds.</li>
      </ol>
      <p class="note">The two variables aren't there? Add them with <strong>New Variable</strong>. Not on Railway? Set them where you set <code>MCP_AUTH_PASSWORD</code> and restart. Steps 2 and 3 still unticked a minute after the deploy? Each variable must hold WHOOP's value alone, with nothing left of <code>replace-with-…</code>.</p>`;

	const connect = `${configured ? '' : `      <p class="note">After step 3. Step 3 doesn't change the address.</p>\n`}      <p>Add this address to your AI app as a custom connector:</p>
${box(new URL('/mcp', config.publicUrl).href, 'server address')}
      <p>It asks for the server password, which lets your AI app talk to this server: on Railway, that's the <code>MCP_AUTH_PASSWORD</code> variable in the service's <strong>Variables</strong> tab (click the eye to reveal it). WHOOP then has to allow this server to read your data; that's the link in step 5.</p>
      <p><strong>Optional: keep your WHOOP data out of model training.</strong> WHOOP's terms ask for this, and it's your call. In Claude, turn off <strong>Settings → Privacy → Help Improve our AI models</strong>; in ChatGPT, turn off <strong>Settings → Data controls → Improve the model for everyone</strong>.</p>
      <dl class="fields">
        <dt>Claude</dt>
        <dd>On claude.ai, go to <strong>Customize → Connectors</strong>, click <strong>+</strong>, then <strong>Add custom connector</strong>. Paste the address, name it, click <strong>Add</strong>, then <strong>Connect</strong>: enter the password, tick the box, sign in. In a chat, turn it on under <strong>+ → Connectors</strong>.</dd>
        <dt>ChatGPT</dt>
        <dd>On the web, go to <strong>Settings → Plugins → Add → Create MCP App</strong> (no such button? Turn on <strong>Developer mode</strong> under <strong>Settings → Security and login</strong>). Name it, set the MCP server URL to the address, choose <strong>OAuth</strong> (and <strong>Dynamic client registration</strong>, if asked), sign in with the password and tick the box, then create the app. In a new chat, mention it (<code>@Whoop</code>) and ask.</dd>
        <dt>Other apps</dt>
        <dd>${link(ADD_TO_YOUR_AI, 'Add to your AI')} has Team and Business workspaces, ChatGPT's Memory, Claude Code, Cursor, VS Code and Windsurf.</dd>
      </dl>`;

	const firstQuestion = `      <p>Ask it about your recovery. The first answer is a WHOOP link, because WHOOP has to allow this server to read your data: open it, log in and approve the app, once. From then on it answers.</p>`;

	const later = configured
		? `  <h2>Later</h2>
  <p>On Railway, turn on <strong>Configure Auto Updates</strong> under <strong>Settings → Source</strong>, and run the <code>:1</code> tag so each 1.x release redeploys it. With Docker, pull <code>:1</code> again and restart. With a fork, sync it and redeploy.</p>
  <p>If you add a custom domain later, open this page again. If the Redirect URL shown here changed, update it in your WHOOP app, or set <code>WHOOP_REDIRECT_URI</code>.</p>
`
		: '';

	const body = `  <h1>${configured ? 'Your server is ready' : 'Set up your server'}</h1>
  <p class="lede">${configured
		? 'It has your WHOOP app\'s keys. Two steps to go: connect your AI app, then ask it a question.'
		: 'Your server is up. Five steps get your AI app talking to your WHOOP data. Keep this page open until the end: steps 2 and 3 tick here once the keys are in; steps 4 and 5 happen in your AI app.'}</p>
  <div class="setup">
  <ol class="journey" role="list">
${step(1, 'Server running', `      <p>It serves this page.</p>`)}
${step(2, 'Create your WHOOP app', whoopApp)}
${step(3, 'Give this server the keys', keys)}
${step(4, 'Connect your AI app', connect)}
${step(5, 'Ask your first question', firstQuestion)}
  </ol>
${later}  </div>
  <footer>
    <p>${link(REPO, 'Source on GitHub')} · ${link(PRIVACY, 'Privacy')} · ${link(`${REPO}/blob/main/SECURITY.md`, 'Security')}</p>
    <p>Open-source project, not affiliated with WHOOP.</p>
  </footer>`;

	return page('Set-up', body, COPY_SCRIPT);
}

export function sendFirstRunPage(res: Response, config: Pick<Config, 'redirectUri' | 'publicUrl' | 'whoopConfigured'>): void {
	send(res, 200, renderFirstRunPage(config), { script: COPY_SCRIPT });
}
