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
	// The chain holds only what this page can tick: the three server-side steps.
	const step = (n: number, title: string, body: string) => {
		const state = configured ? 'done' : (n === 1 ? 'done' : n === 2 ? 'current' : 'todo');
		return `    <li class="${state}"${state === 'current' ? ' aria-current="step"' : ''}>
      <h2>${title}</h2>
${body}
    </li>`;
	};

	const httpsNote = redirectUrl.protocol === 'https:'
		? ''
		: `      <p class="note"><strong>Advanced tip:</strong> WHOOP only accepts https addresses. On your own computer, set <code>WHOOP_REDIRECT_URI</code> to your tunnel's <code>/callback</code>.</p>\n`;
	// The page shows the address without credentials or a query; WHOOP gets the configured value.
	const redactedNote = redirectUrl.href === new URL(config.redirectUri).href
		? ''
		: `      <p class="note">Shown without any credentials or query in <code>WHOOP_REDIRECT_URI</code>. Register the exact value you configured.</p>\n`;
	const redirectBox = `${box(redirectUrl.href, 'Redirect URL')}\n${httpsNote}${redactedNote}`;

	// The same instructions in both states: only the tick changes, so nothing goes missing.
	const whoopApp = `${configured ? `      <p class="note">Done. Check the Redirect URL below matches the one in your WHOOP app. Not created it yet, or pasted the wrong values? Follow this step again.</p>
` : ''}      <p>In the ${link(DASHBOARD, 'WHOOP Developer Dashboard')}, open <strong>New App</strong> and fill the form top to bottom:</p>
      <dl class="fields">
        <dt>Name</dt>
        <dd>Anything, like <code>My MCP server</code>. You see it when you approve the app.</dd>
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
        <dd>Tick these four and leave the other two unticked: the server reads recovery, strain (WHOOP's cycles), sleep and workouts, and asks for nothing it doesn't use.
          <ul class="scopes" role="list">
            <li class="on"><span class="sr">Tick </span><code>read:recovery</code></li>
            <li class="on"><span class="sr">Tick </span><code>read:cycles</code></li>
            <li class="on"><span class="sr">Tick </span><code>read:sleep</code></li>
            <li class="on"><span class="sr">Tick </span><code>read:workout</code></li>
            <li class="off"><span class="sr">Leave unticked </span><code>read:profile</code></li>
            <li class="off"><span class="sr">Leave unticked </span><code>read:body_measurement</code></li>
          </ul>
        </dd>
        <dt>Webhooks</dt>
        <dd>Leave it empty. The server gets your data from WHOOP each time you ask, so WHOOP never has to send it anything.</dd>
      </dl>
      <p>Click <strong>Create App</strong>. WHOOP shows the app's <strong>Client ID</strong> and <strong>Client Secret</strong>: keep that tab open.</p>`;

	const keys = `${configured ? '      <p class="note">Done: both keys are in. To change them later:</p>\n' : ''}      <ol${configured ? '' : ' data-wait'}>
        <li>On Railway, open the service's <strong>Variables</strong> tab.</li>
        <li><code>WHOOP_CLIENT_ID</code>: select <code>${PLACEHOLDERS.clientId}</code> and paste the Client ID over it.</li>
        <li><code>WHOOP_CLIENT_SECRET</code>: select <code>${PLACEHOLDERS.clientSecret}</code> and paste the Client Secret over it.</li>
        <li>Click <strong>Deploy</strong> at the top. When it's done, reload this page: steps 2 and 3 tick. (If you left this tab meanwhile, it has reloaded by itself.) Seeing an error page? Check on Railway that the deploy has finished, then reload.</li>
      </ol>
      <p class="note">The two variables aren't there? Add them with <strong>New Variable</strong>. Running it with Docker instead? Set the two variables there and restart. Steps 2 and 3 still unticked a minute after the deploy? Each variable must hold WHOOP's value alone, with nothing left of <code>replace-with-…</code>.</p>`;

	const connect = `${configured ? '' : `      <p class="note">Once step 3 is done. Step 3 doesn't change the address.</p>\n`}      <p>The address to add as a custom connector:</p>
${box(new URL('/mcp', config.publicUrl).href, 'server address')}
      <p>It asks for the server password, which lets your AI app talk to this server: on Railway, that's the <code>MCP_AUTH_PASSWORD</code> variable in the service's <strong>Variables</strong> tab (click the eye to reveal it). Then you let this server read your WHOOP data, on WHOOP's own page: that's the link in step 5.</p>
      <p><strong>Keep your WHOOP data out of model training.</strong> WHOOP's terms forbid using it to train AI, and your answers pass through your AI app. These two switches keep it out. In Claude, turn off <strong>Settings → Privacy → Help Improve our AI models</strong>. In ChatGPT, turn off <strong>Settings → Data controls → Improve the model for everyone</strong>.</p>
      <dl class="fields">
        <dt>Claude</dt>
        <dd>On claude.ai, go to <strong>Customize → Connectors</strong>, click <strong>+</strong>, then <strong>Add custom connector</strong>. Paste the address, name it, click <strong>Add</strong>, then <strong>Connect</strong>: enter the password, tick the box, sign in. In a chat, turn it on under <strong>+ → Connectors</strong>.</dd>
        <dt>ChatGPT</dt>
        <dd>On the web, go to <strong>Settings → Plugins → Add → Create MCP App</strong> (no such button? Turn on <strong>Developer mode</strong> under <strong>Settings → Security and login</strong>). Name it, set the MCP server URL to the address, choose <strong>OAuth</strong> (and <strong>Dynamic client registration</strong>, if asked), sign in with the password and tick the box, then create the app. In a new chat, mention it (<code>@Whoop</code>) and ask.</dd>
        <dt>Other apps</dt>
        <dd>${link(ADD_TO_YOUR_AI, 'Add to your AI')} covers the other AI apps you may want to read your WHOOP data through this server.</dd>
      </dl>`;

	const firstQuestion = `      <p>Ask your AI app anything about your WHOOP data, like how you slept. The first such question brings an authorization link instead of an answer: click it and log in with your own WHOOP account, the one whose data you want to read (the same login as the WHOOP app on your phone, not the developer dashboard), to let this server read your data. That's a one-time step: the server keeps its access renewed, so you normally won't be asked again. And it runs in the cloud, so from then on you can ask from any device or place, mobile included.</p>`;

	const later = `  <h2>Updates</h2>
  <p>Deployed from the Railway template? New versions install themselves: nothing to do. Set up by hand on Railway? Turn on <strong>Configure Auto Updates</strong> under <strong>Settings → Source</strong>, with the <code>:1</code> image tag. With Docker, pull <code>:1</code> again and restart.</p>
  <p>If you add a custom domain later, open this page again: if the Redirect URL in step 2 changed, update it in your WHOOP app.</p>
`;

	const body = `  <h1>${configured ? 'Your MCP server is ready' : 'Configure your MCP server'}</h1>
  <p class="lede">${configured
		? 'Everything on this page is done. The rest happens in your AI app: connect it, then ask it a question.'
		: 'Your cloud server for the MCP is up. All that\'s left is to configure it, so the AI apps you use (Claude, ChatGPT and others) can talk to your WHOOP data. Three steps here, then two in your AI app. Keep this page open until the end.'}</p>
  <div class="setup">
  <ol class="journey" role="list">
${step(1, 'Server running', `      <p>It serves this page.</p>`)}
${step(2, 'Create your WHOOP app', whoopApp)}
${step(3, 'Give this server the keys', keys)}
  </ol>
  <section class="app" aria-labelledby="then">
    <p class="eyebrow" id="then">${configured ? 'Done here. The rest happens in your AI app' : 'Then, in your AI app'}</p>
    <article>
      <h3><span class="badge" aria-hidden="true">4</span>Connect your AI app</h3>
${connect}
    </article>
    <article>
      <h3><span class="badge" aria-hidden="true">5</span>Ask your first question</h3>
${firstQuestion}
    </article>
  </section>
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
