/**
 * Where a sign-in code may be sent (the OAuth redirect URI).
 *
 * SECURITY: anyone can register a client, so without this check a phishing link to the
 * real sign-in page could send the owner's code to an attacker's website. Codes that land
 * on the internet must go to an allowlisted web client (MCP_ALLOWED_REDIRECT_HOSTS, with
 * Claude and ChatGPT by default). Loopback addresses and app schemes (cursor://,
 * vscode://) only reach apps on the owner's own device, so they are always allowed.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
// Schemes that are not an app on the device: web pages, files and script URLs.
const NON_APP_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:', 'ftp:', 'file:', 'data:', 'blob:', 'about:', 'javascript:', 'vbscript:']);

function parse(uri: string): URL | null {
	try {
		return new URL(uri);
	} catch {
		return null;
	}
}

export function redirectAllowed(uri: string, allowedHosts: readonly string[]): boolean {
	const url = parse(uri);
	if (!url) return false;
	if (url.protocol === 'https:') return allowedHosts.includes(url.hostname);
	if (url.protocol === 'http:') return LOOPBACK_HOSTS.has(url.hostname);
	return !NON_APP_SCHEMES.has(url.protocol);
}

/** How the sign-in page names the place the owner returns to after signing in. */
export function describeRedirect(uri: string): string {
	const url = parse(uri);
	if (!url) return uri;
	if (url.protocol === 'https:') return url.hostname;
	if (url.protocol === 'http:') return 'an app on this computer';
	return `the ${url.protocol.slice(0, -1)} app on this device`;
}

/** The host to name in errors about a redirect URI that is not allowed. */
export function redirectHost(uri: string): string {
	return parse(uri)?.hostname || uri;
}
