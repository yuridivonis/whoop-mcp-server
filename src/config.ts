export interface Config {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	dbPath: string;
	port: number;
	mode: 'http' | 'stdio';
	/** Public origin of this server, used as the OAuth issuer and to build the /mcp URL. */
	publicUrl: URL;
	/** Password for the sign-in page that protects /mcp. Required in http mode. */
	authPassword: string;
}

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConfigError';
	}
}

const MIN_PASSWORD_LENGTH = 16;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const mode = env.MCP_MODE === 'stdio' ? 'stdio' : 'http';
	const redirectUri = env.WHOOP_REDIRECT_URI ?? 'http://localhost:3000/callback';
	const authPassword = env.MCP_AUTH_PASSWORD ?? '';

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
					'Claude asks for it once when you add the connector. Generate one with: openssl rand -base64 24',
			);
		}
		if (publicUrl.protocol !== 'https:' && !LOOPBACK_HOSTS.has(publicUrl.hostname)) {
			throw new ConfigError(`PUBLIC_URL must use https (got ${publicUrl.origin}). Sign-in tokens must never travel over plain http.`);
		}
	}

	return {
		clientId: env.WHOOP_CLIENT_ID ?? '',
		clientSecret: env.WHOOP_CLIENT_SECRET ?? '',
		redirectUri,
		dbPath: env.DB_PATH ?? './whoop.db',
		port: Number.parseInt(env.PORT ?? '3000', 10),
		mode,
		publicUrl,
		authPassword,
	};
}
