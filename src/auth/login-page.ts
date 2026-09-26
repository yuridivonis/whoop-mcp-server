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

function hiddenField(name: string, value: string | undefined): string {
	return value ? `<input type="hidden" name="${name}" value="${escapeHtml(value)}">` : '';
}

function page(title: string, body: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · Whoop MCP Server</title>
<style>
  :root { --bg: #f4f4f5; --card: #ffffff; --text: #18181b; --muted: #71717a; --border: #d4d4d8; --accent: #18181b; --accent-text: #ffffff; --error-bg: #fef2f2; --error: #b91c1c; --notice-bg: #fffbeb; --notice: #92400e; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #09090b; --card: #18181b; --text: #fafafa; --muted: #a1a1aa; --border: #3f3f46; --accent: #fafafa; --accent-text: #09090b; --error-bg: #450a0a; --error: #fca5a5; --notice-bg: #422006; --notice: #fcd34d; }
  }
  * { box-sizing: border-box; margin: 0; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; display: grid; place-items: center; padding: 16px; }
  main { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 28px; width: 100%; max-width: 400px; }
  h1 { font-size: 1.2rem; margin-bottom: 6px; }
  p { color: var(--muted); font-size: 0.9rem; line-height: 1.4; margin-bottom: 16px; }
  p strong { color: var(--text); }
  label { display: block; font-size: 0.85rem; margin-bottom: 6px; }
  input[type="password"] { width: 100%; padding: 10px 12px; font-size: 1rem; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: inherit; margin-bottom: 16px; }
  .consent { display: flex; gap: 10px; align-items: flex-start; border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-bottom: 16px; }
  .consent input { margin-top: 3px; width: 18px; height: 18px; flex: none; }
  .consent label { margin: 0; font-size: 0.9rem; line-height: 1.4; }
  .consent small { display: block; color: var(--muted); font-size: 0.8rem; margin-top: 6px; }
  button { width: 100%; padding: 10px; font-size: 1rem; font-weight: 600; border: 0; border-radius: 8px; background: var(--accent); color: var(--accent-text); cursor: pointer; }
  .notice { background: var(--notice-bg); color: var(--notice); border-radius: 8px; padding: 10px 12px; font-size: 0.85rem; line-height: 1.4; margin-bottom: 16px; }
  .error { background: var(--error-bg); color: var(--error); border-radius: 8px; padding: 10px 12px; font-size: 0.9rem; margin-bottom: 16px; }
  footer { color: var(--muted); font-size: 0.75rem; margin-top: 20px; text-align: center; }
</style>
</head>
<body>
<main>
${body}
  <footer>Open-source project, not affiliated with WHOOP.</footer>
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
 *
 * WHOOP's terms require explicit opt-in consent before WHOOP data reaches a third party,
 * and the app is one. So the owner has to tick a box naming where the data goes.
 */
export function sendLoginPage(res: Response, { client, params, destination, error, status = 200 }: LoginPageOptions): void {
	const clientName = client.client_name ? escapeHtml(client.client_name) : 'An MCP client';

	send(res, status, page('Sign in', `  <h1>Sign in to your Whoop MCP Server</h1>
  <p><strong>${clientName}</strong> is asking to read your WHOOP data through this server. After you sign in, you'll return to <strong>${escapeHtml(destination)}</strong>.</p>
  <div class="notice">Only continue if you started this yourself, just now, by connecting this server in your app. If someone sent you this link, close this page: signing in would give them access to your WHOOP data.</div>
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
    <label for="password">Server password (MCP_AUTH_PASSWORD)</label>
    <input type="password" id="password" name="password" required autofocus autocomplete="current-password">
    <div class="consent">
      <input type="checkbox" id="consent" name="consent" value="yes" required>
      <label for="consent"><strong>${escapeHtml(consentText(destination))}</strong>
        <small>Each time you ask about your WHOOP data, this server fetches it from WHOOP and sends it to ${escapeHtml(destination)}, whose provider handles it under its own terms. To stop, remove this server from the app, or change MCP_AUTH_PASSWORD to sign every app out.</small></label>
    </div>
    <button type="submit">Allow and sign in</button>
  </form>`));
}

/** Shown instead of the sign-in form when a sign-in can't be allowed. */
export function sendSignInError(res: Response, message: string, status = 400): void {
	send(res, status, page("Can't sign in", `  <h1>Can't sign in</h1>
  <div class="error" role="alert">${escapeHtml(message)}</div>
  <p>If you're setting up a new app, its address has to be added to <strong>MCP_ALLOWED_REDIRECT_HOSTS</strong> on your server first.</p>`));
}
