export interface Config {
	clientId: string;
	clientSecret: string;
	/** Both WHOOP app values are set. Until then the set-up page at / shows what to do, and get_auth_url points there. */
	whoopConfigured: boolean;
	redirectUri: string;
	dbPath: string;
	port: number;
	mode: 'http' | 'stdio';
	/** Public origin of this server, used as the OAuth issuer and to build the /mcp URL. */
	publicUrl: URL;
	/** Password for the sign-in page that protects /mcp. Required in http mode. */
	authPassword: string;
	/** Express `trust proxy`: which proxies in front of the app may report the client's address. */
	trustProxy: number | string | false;
	/** Web clients whose sign-in redirect addresses are allowed; see auth/redirects.ts. */
	allowedRedirectHosts: string[];
	/** Whether to ask GitHub once a day for a newer release; see updates.ts. */
	updateCheck: boolean;
}

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConfigError';
	}
}

const MIN_PASSWORD_LENGTH = 16;
// Claude (web, desktop and mobile) returns to claude.ai, moving to claude.com; ChatGPT
// returns to chatgpt.com. Other web clients are added with MCP_ALLOWED_REDIRECT_HOSTS.
const DEFAULT_REDIRECT_HOSTS = ['claude.ai', 'claude.com', 'chatgpt.com'];
const HOST_NAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function parseTrustProxy(env: NodeJS.ProcessEnv): number | string | false {
	const value = env.TRUST_PROXY?.trim();
	if (!value) {
		// SECURITY: Railway routes every request through one edge proxy. Anywhere else,
		// X-Forwarded-For is only trusted when configured: on a directly exposed server it
		// would let each client choose its own address and dodge the per-address rate limits.
		return env.RAILWAY_ENVIRONMENT_ID ? 1 : false;
	}
	if (value === 'false' || value === '0') return false;
	if (/^\d+$/.test(value)) return Number(value);
	if (value === 'true') {
		throw new ConfigError(
			'TRUST_PROXY=true would let any client choose its own IP address. ' +
				'Set the number of proxies in front of the server (usually 1), or their addresses.',
		);
	}
	// Proxy addresses or subnets, e.g. "loopback, 10.0.0.0/8".
	return value;
}

function parseRedirectHosts(env: NodeJS.ProcessEnv): string[] {
	const extra = (env.MCP_ALLOWED_REDIRECT_HOSTS ?? '')
		.split(',')
		.map(host => host.trim().toLowerCase())
		.filter(Boolean);
	for (const host of extra) {
		if (!HOST_NAME.test(host)) {
			throw new ConfigError(`MCP_ALLOWED_REDIRECT_HOSTS takes host names separated by commas, like example.com (got "${host}").`);
		}
	}
	return [...new Set([...DEFAULT_REDIRECT_HOSTS, ...extra])];
}

/**
 * The WHOOP callback address when WHOOP_REDIRECT_URI isn't set: PUBLIC_URL's, else the
 * Railway domain's, else this computer's. So a Railway deploy never has to type it.
 */
function defaultRedirectUri(env: NodeJS.ProcessEnv, mode: 'http' | 'stdio'): string {
	if (env.PUBLIC_URL) {
		try {
			return new URL('/callback', new URL(env.PUBLIC_URL).origin).href;
		} catch {
			return env.PUBLIC_URL; // reported by the PUBLIC_URL check below
		}
	}
	const domain = env.RAILWAY_PUBLIC_DOMAIN?.trim().toLowerCase();
	// A stdio server has no public address, so a domain it can't use doesn't stop it.
	if (domain && mode === 'http') {
		// The URL parser decides what a host is (it accepts punycode and a trailing dot); the
		// value must be exactly a host, not a URL, a path or a port.
		let parsed: URL | undefined;
		try {
			parsed = new URL(`https://${domain}/callback`);
		} catch {
			parsed = undefined;
		}
		if (!parsed || parsed.hostname !== domain) {
			throw new ConfigError(`RAILWAY_PUBLIC_DOMAIN isn't a host name (got "${domain}"). Set WHOOP_REDIRECT_URI instead.`);
		}
		return parsed.href;
	}
	return 'http://localhost:3000/callback';
}

/**
 * The values a deployment can give WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET before the WHOOP
 * app exists, so the owner edits a variable instead of creating one. Anything starting with
 * "replace-with" counts as unset (WHOOP's real values are hex), as does 1.4.3's placeholder.
 */
export const PLACEHOLDERS = { clientId: 'replace-with-your-client-id', clientSecret: 'replace-with-your-client-secret' };

/** Whether a WHOOP app value has been filled in: not empty, and not a placeholder. */
function isSet(value: string | undefined): boolean {
	const trimmed = (value ?? '').trim().toLowerCase();
	return trimmed !== '' && !trimmed.startsWith('replace-with') && trimmed !== 'paste-after-deploy';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const mode = env.MCP_MODE === 'stdio' ? 'stdio' : 'http';
	const redirectUri = env.WHOOP_REDIRECT_URI ?? defaultRedirectUri(env, mode);
	const authPassword = env.MCP_AUTH_PASSWORD ?? '';
	const whoopConfigured = isSet(env.WHOOP_CLIENT_ID) && isSet(env.WHOOP_CLIENT_SECRET);

	if (mode === 'http') {
		// Both addresses must be http(s) with a real host. The URL parser is lenient: a
		// reference to a domain that doesn't exist yet gives "https:///callback", and
		// "https:/callback" or a backslash form parse to the host "callback"; an opaque scheme
		// keeps credentials in its path. All are refused here, on the raw strings.
		for (const [name, value] of [['PUBLIC_URL', env.PUBLIC_URL], ['WHOOP_REDIRECT_URI', env.WHOOP_REDIRECT_URI]] as const) {
			if (value !== undefined && !/^\s*https?:\/\/[^/\\?#\s]+/i.test(value)) {
				throw new ConfigError(`${name} must be an http(s) address with a host, e.g. https://your-app.up.railway.app (got "${value}"). Is the service's domain generated yet?`);
			}
		}
		if (env.RAILWAY_ENVIRONMENT_ID && !env.WHOOP_REDIRECT_URI && !env.PUBLIC_URL && !env.RAILWAY_PUBLIC_DOMAIN?.trim()) {
			throw new ConfigError('On Railway, generate a domain for the service (Settings → Networking → Generate Domain) or set WHOOP_REDIRECT_URI.');
		}
		// With PUBLIC_URL set, nothing below parses the callback, but the set-up page shows it.
		if (env.WHOOP_REDIRECT_URI !== undefined) {
			try {
				new URL(env.WHOOP_REDIRECT_URI);
			} catch {
				throw new ConfigError('WHOOP_REDIRECT_URI must be a valid URL, e.g. https://your-app.up.railway.app/callback');
			}
		}
	}

	let publicUrl: URL;
	try {
		// The WHOOP redirect URI already names this server's public address, so most
		// deployments never need to set PUBLIC_URL.
		publicUrl = new URL(new URL(env.PUBLIC_URL ?? redirectUri).origin);
	} catch {
		throw new ConfigError('PUBLIC_URL (or WHOOP_REDIRECT_URI) must be a valid URL, e.g. https://your-app.up.railway.app');
	}

	if (mode === 'http') {
		// SECURITY: fail closed. Without a password there is no sign-in, and /mcp would
		// serve health data to anyone who finds the URL.
		if (authPassword.length < MIN_PASSWORD_LENGTH) {
			throw new ConfigError(
				`MCP_AUTH_PASSWORD must be set to at least ${MIN_PASSWORD_LENGTH} characters. ` +
					'Each AI app asks for it once when you connect it. Generate one with: openssl rand -base64 24',
			);
		}
		if (publicUrl.protocol !== 'https:' && !LOOPBACK_HOSTS.has(publicUrl.hostname)) {
			throw new ConfigError(`PUBLIC_URL must use https (got ${publicUrl.origin}). Sign-in tokens must never travel over plain http.`);
		}
	}

	return {
		// The placeholder never reaches WHOOP as a credential: it's unset here as well.
		clientId: isSet(env.WHOOP_CLIENT_ID) ? env.WHOOP_CLIENT_ID! : '',
		clientSecret: isSet(env.WHOOP_CLIENT_SECRET) ? env.WHOOP_CLIENT_SECRET! : '',
		whoopConfigured,
		redirectUri,
		dbPath: env.DB_PATH ?? './whoop.db',
		port: Number.parseInt(env.PORT ?? '3000', 10),
		mode,
		publicUrl,
		authPassword,
		trustProxy: parseTrustProxy(env),
		allowedRedirectHosts: parseRedirectHosts(env),
		updateCheck: !['false', '0', 'off', 'no'].includes((env.UPDATE_CHECK ?? '').trim().toLowerCase()),
	};
}
