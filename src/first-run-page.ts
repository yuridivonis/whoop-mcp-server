import type { Response } from 'express';
import type { Config } from './config.js';
import { escapeHtml, page, send } from './auth/login-page.js';

const REPO = 'https://github.com/yuridivonis/whoop-mcp-server';
const DASHBOARD = 'https://developer-dashboard.whoop.com';

/**
 * The page at /: what's left to do after deploying. Before the WHOOP app is configured it
 * shows the exact Redirect URL to register and where the two values go; after, how to
 * connect an AI app.
 *
 * SECURITY: it's public, and built from the config alone (nothing from the request). It
 * shows addresses, and whether the two WHOOP app variables are set: never a secret, the
 * version, the WHOOP connection, or where the server is hosted.
 */
/**
 * The callback address as the page may show it: scheme, host, port and path only. An
 * operator could put credentials or a query in WHOOP_REDIRECT_URI, and this page is public.
 */
export function publicRedirectUri(redirectUri: string): URL {
	const url = new URL(redirectUri);
	url.username = '';
	url.password = '';
	url.search = '';
	url.hash = '';
	return url;
}

export function renderFirstRunPage(config: Pick<Config, 'redirectUri' | 'publicUrl' | 'whoopConfigured'>): string {
	const redirectUrl = publicRedirectUri(config.redirectUri);
	const redirect = escapeHtml(redirectUrl.href);
	const mcp = escapeHtml(new URL('/mcp', config.publicUrl).href);
	const link = (href: string, label: string) => `<a href="${href}" rel="noopener">${label}</a>`;

	const httpsNote = redirectUrl.protocol === 'https:'
		? ''
		: `  <p class="note">WHOOP only accepts https addresses. On your own computer, set <code>WHOOP_REDIRECT_URI</code> to your tunnel's <code>/callback</code>.</p>\n`;

	const steps = config.whoopConfigured
		? `  <h2>Your WHOOP app</h2>
  <p>Not created it yet, or pasted a placeholder? The README's ${link(`${REPO}#2-create-a-whoop-developer-app`, 'Create a Whoop Developer App')} step has the fields.</p>
  <h2>Connect your AI app</h2>
  <p>Add this address to it as a custom connector:</p>
  <p class="box"><code>${mcp}</code></p>
  <p>It asks for the server password. On Railway that's the <code>MCP_AUTH_PASSWORD</code> variable in the service's <strong>Variables</strong> tab. ${link(`${REPO}/blob/main/docs/add-to-your-ai.md`, 'Add to your AI')} has the steps for each app.</p>
  <p>Then ask it to connect WHOOP: it gives you a link to authorize.</p>
  <h2>Updates</h2>
  <p>On Railway, turn on <strong>Configure Auto Updates</strong> under <strong>Settings → Source</strong>, and run the <code>:1</code> tag so each 1.x release redeploys it. With Docker, pull <code>:1</code> again and restart. With a fork, sync it and redeploy.</p>
  <p>If you add a custom domain later, open this page again. If the Redirect URL shown here changed, update it in your WHOOP app, or set <code>WHOOP_REDIRECT_URI</code>.</p>`
		: `  <h2>Step 1 of 2: create your WHOOP app</h2>
  <p>In the ${link(DASHBOARD, 'WHOOP Developer Dashboard')}, create an app and fill in:</p>
  <ul>
    <li><strong>Contacts:</strong> your email. Only WHOOP sees it.</li>
    <li><strong>Privacy Policy:</strong> this project's ${link(`${REPO}/blob/main/PRIVACY.md`, 'PRIVACY.md')}, or your own copy if you run the server for someone else.</li>
    <li><strong>Redirect URL:</strong> the address above, exactly.</li>
    <li><strong>Scopes:</strong> <code>read:recovery</code>, <code>read:cycles</code>, <code>read:sleep</code>, <code>read:workout</code>.</li>
    <li><strong>Webhooks:</strong> leave empty.</li>
  </ul>
  <h2>Step 2 of 2: give this server the app's keys</h2>
  <p>Paste the app's Client ID and Client Secret into the <code>WHOOP_CLIENT_ID</code> and <code>WHOOP_CLIENT_SECRET</code> variables. On Railway that's the service's <strong>Variables</strong> tab: save them and deploy the change. Elsewhere, set them where you set <code>MCP_AUTH_PASSWORD</code> and restart. This page then shows the next step.</p>`;

	return page('Set-up', `  <h1>${config.whoopConfigured ? 'Your server is ready' : 'Set up your server'}</h1>
  <p class="lede">This server is running${config.whoopConfigured ? '' : '. Two steps left'}.</p>
  <div class="setup">
  <h2>Your WHOOP app's Redirect URL</h2>
  <p class="box"><code>${redirect}</code></p>
${httpsNote}${config.whoopConfigured ? '  <p class="note">Check it matches the Redirect URL in your WHOOP app.</p>\n' : ''}${steps}
  </div>
  <footer>
    <p>${link(REPO, 'Source on GitHub')} · ${link(`${REPO}/blob/main/PRIVACY.md`, 'Privacy')} · ${link(`${REPO}/blob/main/SECURITY.md`, 'Security')}</p>
    <p>Open-source project, not affiliated with WHOOP.</p>
  </footer>`);
}

export function sendFirstRunPage(res: Response, config: Pick<Config, 'redirectUri' | 'publicUrl' | 'whoopConfigured'>): void {
	send(res, 200, renderFirstRunPage(config));
}
