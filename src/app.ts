import express, { type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { Config } from './config.js';
import { McpAuthProvider } from './auth/provider.js';
import { createMcpServer, type ToolDeps } from './tools.js';

export interface AppDeps extends Omit<ToolDeps, 'redirectUri'> {
	config: Config;
}

function jsonRpcError(res: Response, status: number, message: string): void {
	res.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}

/**
 * The MCP spec requires clients to accept both JSON and SSE responses, and the SDK answers
 * 406 when `text/event-stream` is missing. Some clients omit it, so it is added here. The
 * SDK reads the raw header list, which is why rawHeaders is patched as well.
 */
function acceptEventStream(req: Request, _res: Response, next: NextFunction): void {
	const accept = req.headers.accept ?? '';
	if (!accept.includes('text/event-stream') || !accept.includes('application/json')) {
		const value = 'application/json, text/event-stream';
		req.headers.accept = value;
		const index = req.rawHeaders.findIndex((header, i) => i % 2 === 0 && header.toLowerCase() === 'accept');
		if (index === -1) {
			req.rawHeaders.push('Accept', value);
		} else {
			req.rawHeaders[index + 1] = value;
		}
	}
	next();
}

export function createApp({ config, db, client, sync, authStates }: AppDeps): express.Express {
	const app = express();
	// The rate limits below need the client's address; see TRUST_PROXY in config.ts.
	app.set('trust proxy', config.trustProxy);
	app.use(express.json());

	const mcpUrl = new URL('/mcp', config.publicUrl);
	const provider = new McpAuthProvider({ db, password: config.authPassword, resourceUrl: mcpUrl });

	// SECURITY: forkers choose their own passwords, so failed sign-ins are limited per
	// address and in total. Successful sign-ins (a redirect) do not count. Mounted with
	// app.use, like the SDK's own /authorize handler, so every path that reaches the
	// password check (/authorize/, /AUTHORIZE, ...) is counted too.
	const failedSignIn = {
		skip: (req: Request) => req.method !== 'POST',
		skipSuccessfulRequests: true,
		standardHeaders: 'draft-8' as const,
		legacyHeaders: false,
	};
	app.use(
		'/authorize',
		rateLimit({ ...failedSignIn, windowMs: 15 * 60 * 1000, limit: 10, message: 'Too many failed sign-in attempts. Try again in 15 minutes.' }),
		rateLimit({ ...failedSignIn, windowMs: 60 * 60 * 1000, limit: 50, keyGenerator: () => 'all', message: 'Too many failed sign-in attempts. Try again in an hour.' }),
	);

	// OAuth 2.1 endpoints and discovery metadata: /authorize, /token, /register, /revoke,
	// /.well-known/oauth-authorization-server and /.well-known/oauth-protected-resource/mcp.
	app.use(mcpAuthRouter({ provider, issuerUrl: config.publicUrl, resourceServerUrl: mcpUrl, resourceName: 'Whoop MCP Server' }));

	const requireAuth = requireBearerAuth({
		verifier: provider,
		resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
	});

	app.get('/callback', async (req: Request, res: Response) => {
		const { code, state, error } = req.query;

		if (error !== undefined) {
			res.status(400).send('Whoop authorization was not completed. Ask Claude for a new link with get_auth_url.');
			return;
		}

		// SECURITY: only accept callbacks for links this server issued, once each.
		if (typeof state !== 'string' || !authStates.consume(state)) {
			res.status(400).send('This authorization link is invalid or has expired. Ask Claude for a new one with get_auth_url.');
			return;
		}

		if (typeof code !== 'string' || !code) {
			res.status(400).send('Missing authorization code');
			return;
		}

		try {
			const tokens = await client.exchangeCodeForTokens(code);
			db.saveTokens(tokens);
			// Runs in the background; WhoopSync logs a failure, and the next tool call retries.
			sync.syncDays(90).catch(() => {});
			res.send('Authorization successful! You can close this window.');
		} catch {
			res.status(500).send('Authorization failed. Please try again.');
		}
	});

	app.get('/health', (_req: Request, res: Response) => {
		res.json({ status: 'ok', authenticated: Boolean(db.getTokens()) });
	});

	// Stateless Streamable HTTP: every request gets its own server and transport, so there
	// are no sessions to leak, expire or lose on redeploy, and nothing is shared between clients.
	app.post('/mcp', requireAuth, acceptEventStream, async (req: Request, res: Response) => {
		const server = createMcpServer({ db, client, sync, authStates, redirectUri: config.redirectUri });
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
		res.on('close', () => {
			transport.close().catch(() => {});
			server.close().catch(() => {});
		});

		try {
			await server.connect(transport);
			// express.json() has already consumed the body stream, so hand the parsed body over.
			await transport.handleRequest(req, res, req.body);
		} catch {
			if (!res.headersSent) {
				jsonRpcError(res, 500, 'Internal server error');
			}
		}
	});

	// A stateless server has no event stream to open (GET) and no session to end (DELETE).
	app.all('/mcp', requireAuth, (_req: Request, res: Response) => {
		res.set('Allow', 'POST');
		jsonRpcError(res, 405, 'Method not allowed');
	});

	app.get('/sse', (_req: Request, res: Response) => {
		res.status(410).send('SSE endpoint deprecated. Use /mcp with Streamable HTTP transport.');
	});

	return app;
}
