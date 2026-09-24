import type { Response } from 'express';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

interface LoginPageOptions {
	client: OAuthClientInformationFull;
	params: AuthorizationParams;
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

/**
 * The page Claude opens when you add the connector. It posts back to /authorize with the
 * original OAuth parameters, so the SDK re-validates them before the password is checked.
 */
export function sendLoginPage(res: Response, { client, params, error, status = 200 }: LoginPageOptions): void {
	const clientName = client.client_name ? escapeHtml(client.client_name) : 'An MCP client';

	const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in · Whoop MCP Server</title>
<style>
  :root { --bg: #f4f4f5; --card: #ffffff; --text: #18181b; --muted: #71717a; --border: #d4d4d8; --accent: #18181b; --accent-text: #ffffff; --error-bg: #fef2f2; --error: #b91c1c; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #09090b; --card: #18181b; --text: #fafafa; --muted: #a1a1aa; --border: #3f3f46; --accent: #fafafa; --accent-text: #09090b; --error-bg: #450a0a; --error: #fca5a5; }
  }
  * { box-sizing: border-box; margin: 0; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; display: grid; place-items: center; padding: 16px; }
  main { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 28px; width: 100%; max-width: 380px; }
  h1 { font-size: 1.2rem; margin-bottom: 6px; }
  p { color: var(--muted); font-size: 0.9rem; line-height: 1.4; margin-bottom: 20px; }
  label { display: block; font-size: 0.85rem; margin-bottom: 6px; }
  input[type="password"] { width: 100%; padding: 10px 12px; font-size: 1rem; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: inherit; margin-bottom: 16px; }
  button { width: 100%; padding: 10px; font-size: 1rem; font-weight: 600; border: 0; border-radius: 8px; background: var(--accent); color: var(--accent-text); cursor: pointer; }
  .error { background: var(--error-bg); color: var(--error); border-radius: 8px; padding: 10px 12px; font-size: 0.9rem; margin-bottom: 16px; }
  footer { color: var(--muted); font-size: 0.75rem; margin-top: 20px; text-align: center; }
</style>
</head>
<body>
<main>
  <h1>Sign in to your Whoop MCP Server</h1>
  <p><strong>${clientName}</strong> is asking to read your Whoop data through this server.</p>
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
    <button type="submit">Sign in</button>
  </form>
  <footer>Open-source project, not affiliated with WHOOP.</footer>
</main>
</body>
</html>`;

	res.setHeader('Content-Type', 'text/html; charset=utf-8');
	// SECURITY: the page must never be framed (clickjacking) or cached with its parameters.
	res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
	res.setHeader('X-Frame-Options', 'DENY');
	res.setHeader('Referrer-Policy', 'no-referrer');
	res.setHeader('Cache-Control', 'no-store');
	res.status(status).send(html);
}
