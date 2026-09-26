import type { Response } from 'express';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

interface LoginPageOptions {
	client: OAuthClientInformationFull;
	params: AuthorizationParams;
	/** Where the owner returns after signing in, from describeRedirect(). */
	destination: string;
	error?: string;
	status?: number;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * An app-chosen name, made safe to show: control and bidirectional-text characters
 * removed and the length capped, so a name can't add lines, reorder the text around it,
 * or push the warning off the screen.
 */
export function cleanName(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, ' ').slice(0, 80);
}

function hiddenField(name: string, value: string | undefined): string {
	return value ? `<input type="hidden" name="${name}" value="${escapeHtml(value)}">` : '';
}

// Inline SVG, since the pages' Content-Security-Policy allows no images or fonts.
const ICONS = {
	mark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2.5-6 5 12 2.5-6h4"/></svg>',
	shield: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>',
	eye: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
};

function page(title: string, body: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>${title} · Whoop MCP Server</title>
<style>
  :root {
    color-scheme: light;
    --bg: #f3f4f8; --card: #ffffff; --text: #111827; --muted: #5b6475; --faint: #667085; --border: #e2e5ee;
    --field: #ffffff; --accent: #4f46e5; --accent-strong: #4338ca; --on-accent: #ffffff; --accent-soft: #eef0ff;
    --warn-bg: #fff7e8; --warn-edge: #f0a927; --warn-text: #6b4300; --error-bg: #fdecec; --error: #b42318;
    --shadow: 0 1px 2px rgba(17, 24, 39, 0.04), 0 12px 32px rgba(17, 24, 39, 0.08);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --bg: #0a0c11; --card: #13161e; --text: #eceff5; --muted: #a0a8b8; --faint: #8892a6; --border: #252a36;
      --field: #0e1118; --accent: #8e8cff; --accent-strong: #a9a7ff; --on-accent: #0a0c11; --accent-soft: #1e2140;
      --warn-bg: #251d0e; --warn-edge: #d2911f; --warn-text: #f4d38e; --error-bg: #3a1414; --error: #fca5a5;
      --shadow: none;
    }
  }
  * { box-sizing: border-box; margin: 0; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; -webkit-font-smoothing: antialiased; }
  main { width: 100%; max-width: 440px; background: var(--card); border: 1px solid var(--border); border-radius: 20px; padding: 32px; box-shadow: var(--shadow); }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 28px; color: var(--muted); font-size: 0.9rem; font-weight: 600; }
  .mark { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 9px; background: var(--accent); color: var(--on-accent); }
  .mark svg { width: 20px; height: 20px; }
  h1 { font-size: 1.5rem; line-height: 1.25; letter-spacing: -0.02em; font-weight: 700; margin-bottom: 10px; overflow-wrap: anywhere; }
  .lede { color: var(--muted); font-size: 0.95rem; line-height: 1.5; margin-bottom: 20px; overflow-wrap: anywhere; }
  .lede strong { color: var(--text); font-weight: 600; }
  .reads { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; padding: 0; list-style: none; }
  .reads li { background: var(--accent-soft); color: var(--accent-strong); border-radius: 999px; padding: 5px 11px; font-size: 0.82rem; font-weight: 600; }
  .readonly { display: flex; align-items: center; gap: 6px; color: var(--faint); font-size: 0.82rem; margin-bottom: 24px; }
  .readonly svg { width: 15px; height: 15px; flex: none; }
  .warning { display: flex; gap: 10px; background: var(--warn-bg); border-left: 3px solid var(--warn-edge); border-radius: 10px; padding: 12px 14px; margin-bottom: 24px; color: var(--warn-text); font-size: 0.86rem; line-height: 1.45; }
  .warning svg { width: 18px; height: 18px; flex: none; margin-top: 1px; }
  .error { background: var(--error-bg); color: var(--error); border-radius: 10px; padding: 12px 14px; font-size: 0.9rem; line-height: 1.45; margin-bottom: 20px; }
  label.field { display: block; font-size: 0.9rem; font-weight: 600; margin-bottom: 8px; }
  input[type="password"] { width: 100%; height: 48px; padding: 0 14px; font: inherit; font-size: 1rem; color: inherit; background: var(--field); border: 1px solid var(--faint); border-radius: 12px; }
  .hint { color: var(--faint); font-size: 0.8rem; line-height: 1.4; margin: 8px 0 20px; }
  .hint code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.78rem; }
  .consent { display: flex; gap: 12px; align-items: flex-start; border: 1px solid var(--border); border-radius: 12px; padding: 14px; margin-bottom: 20px; cursor: pointer; }
  .consent:has(input:checked) { border-color: var(--accent); background: var(--accent-soft); }
  .consent input { width: 20px; height: 20px; margin-top: 1px; flex: none; accent-color: var(--accent); cursor: pointer; }
  .consent-text { min-width: 0; overflow-wrap: anywhere; }
  .consent-text strong { display: block; font-size: 0.95rem; line-height: 1.4; font-weight: 600; }
  .consent-detail { display: block; color: var(--muted); font-size: 0.82rem; line-height: 1.45; margin-top: 4px; }
  button { width: 100%; height: 50px; font: inherit; font-size: 1rem; font-weight: 600; border: 0; border-radius: 12px; background: var(--accent); color: var(--on-accent); cursor: pointer; }
  button:hover { background: var(--accent-strong); }
  input:focus-visible, button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  footer { border-top: 1px solid var(--border); margin-top: 28px; padding-top: 18px; color: var(--faint); font-size: 0.78rem; line-height: 1.5; }
  footer p + p { margin-top: 6px; }
  @media (max-width: 480px) {
    body { padding: 12px; place-items: start center; }
    main { padding: 24px 20px; border-radius: 16px; }
    h1 { font-size: 1.3rem; }
  }
</style>
</head>
<body>
<main>
  <div class="brand"><span class="mark" aria-hidden="true">${ICONS.mark}</span>Whoop MCP Server</div>
${body}
</main>
</body>
</html>`;
}

function send(res: Response, status: number, html: string): void {
	res.setHeader('Content-Type', 'text/html; charset=utf-8');
	// SECURITY: these pages must never be framed (clickjacking) or cached with their parameters.
	res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
	res.setHeader('X-Frame-Options', 'DENY');
	res.setHeader('Referrer-Policy', 'no-referrer');
	res.setHeader('Cache-Control', 'no-store');
	res.status(status).send(html);
}

/** What the owner allows by ticking the box on the sign-in page. */
export function consentText(destination: string): string {
	return `Allow ${destination} to read your WHOOP recovery, sleep, strain and workouts`;
}

/**
 * The page an MCP client opens when you connect it. It posts back to /authorize with the
 * original OAuth parameters, so the SDK re-validates them before the password is checked.
 *
 * SECURITY: the destination and the warning are the owner's defense against a phishing
 * link: a legitimate sign-in is one they just started themselves, returning to their app.
 * The heading names the destination, which the server checked, rather than the name the
 * app chose for itself. The page deliberately doesn't look like WHOOP's own login, so
 * nobody mistakes it for one and types their WHOOP password here.
 *
 * WHOOP's terms require explicit opt-in consent before WHOOP data reaches a third party,
 * and the app is one. So the owner has to tick a box naming where the data goes.
 */
export function sendLoginPage(res: Response, { client, params, destination, error, status = 200 }: LoginPageOptions): void {
	const clientName = client.client_name ? escapeHtml(cleanName(client.client_name)) : 'An app';
	const where = escapeHtml(destination);

	send(res, status, page('Sign in', `  <h1>Connect ${where} to your WHOOP data</h1>
  <p class="lede"><strong><bdi>${clientName}</bdi></strong> is asking to connect to your server. After you sign in, you'll return to <strong>${where}</strong>.</p>
  <ul class="reads" aria-label="What it can read"><li>Recovery</li><li>Sleep</li><li>Strain</li><li>Workouts</li></ul>
  <p class="readonly">${ICONS.eye}Read-only: nothing on WHOOP is changed, and the server keeps no copy.</p>
  <div class="warning" role="note">${ICONS.shield}<p><strong>Only continue if you started this yourself, just now.</strong> If someone sent you this link, close this page: signing in would give them your WHOOP data.</p></div>
  ${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ''}
  <form method="POST" action="/authorize">
    ${hiddenField('client_id', client.client_id)}
    ${hiddenField('redirect_uri', params.redirectUri)}
    ${hiddenField('response_type', 'code')}
    ${hiddenField('code_challenge', params.codeChallenge)}
    ${hiddenField('code_challenge_method', 'S256')}
    ${hiddenField('state', params.state)}
    ${hiddenField('scope', params.scopes?.join(' '))}
    ${hiddenField('resource', params.resource?.href)}
    <label class="field" for="password">Server password</label>
    <input type="password" id="password" name="password" required autofocus autocomplete="current-password" aria-describedby="password-hint">
    <p class="hint" id="password-hint">The <code>MCP_AUTH_PASSWORD</code> set when this server was deployed. Not your WHOOP password.</p>
    <label class="consent">
      <input type="checkbox" id="consent" name="consent" value="yes" required>
      <span class="consent-text"><strong>${escapeHtml(consentText(destination))}</strong><span class="consent-detail">Each time you ask, the server fetches it from WHOOP and sends it to ${where}, whose provider handles it under its own terms.</span></span>
    </label>
    <button type="submit">Allow and sign in</button>
  </form>
  <footer>
    <p>To stop sharing, remove this server from the app, or change the server password to sign every app out.</p>
    <p>Open-source project, not affiliated with WHOOP.</p>
  </footer>`));
}

/** Shown instead of the sign-in form when a sign-in can't be allowed. */
export function sendSignInError(res: Response, message: string, status = 400): void {
	send(res, status, page("Can't sign in", `  <h1>Can't sign in</h1>
  <div class="error" role="alert">${escapeHtml(message)}</div>
  <p class="lede">If you're setting up a new app, its address has to be added to <strong>MCP_ALLOWED_REDIRECT_HOSTS</strong> on your server first.</p>
  <footer><p>Open-source project, not affiliated with WHOOP.</p></footer>`));
}
