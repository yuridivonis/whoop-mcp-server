import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { WhoopClient } from './whoop-client.js';
import { WhoopDatabase } from './database.js';
import { WhoopSync } from './sync.js';
import { PendingAuthStates } from './auth-states.js';
import { createMcpServer } from './tools.js';
import { createApp } from './app.js';

let config: Config;
try {
	config = loadConfig();
} catch (error) {
	if (error instanceof ConfigError) {
		process.stderr.write(`Configuration error: ${error.message}\n`);
		process.exit(1);
	}
	throw error;
}

const db = new WhoopDatabase(config.dbPath);
const client = new WhoopClient({
	clientId: config.clientId,
	clientSecret: config.clientSecret,
	redirectUri: config.redirectUri,
	onTokenRefresh: tokens => db.saveTokens(tokens),
});

const existingTokens = db.getTokens();
if (existingTokens) {
	client.setTokens(existingTokens);
}

const sync = new WhoopSync(client, db);
const authStates = new PendingAuthStates();

async function main(): Promise<void> {
	if (config.mode === 'stdio') {
		const server = createMcpServer({ db, client, sync, authStates, redirectUri: config.redirectUri });
		const transport = new StdioServerTransport();
		await server.connect(transport);
		process.stderr.write('Whoop MCP server running on stdio\n');
		return;
	}

	const app = createApp({ config, db, client, sync, authStates });
	const server = app.listen(config.port, '0.0.0.0', () => {
		process.stdout.write(`Whoop MCP server running on http://0.0.0.0:${config.port}\n`);
		process.stdout.write(`Connect Claude to ${new URL('/mcp', config.publicUrl).href}\n`);
	});

	const shutdown = (): void => {
		process.stdout.write('\nShutting down...\n');
		server.close(() => {
			db.close();
			process.exit(0);
		});
	};

	process.on('SIGTERM', shutdown);
	process.on('SIGINT', shutdown);
}

main().catch(error => {
	process.stderr.write(`Fatal error: ${error}\n`);
	process.exit(1);
});
