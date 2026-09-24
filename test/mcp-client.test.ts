import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { CLIENT_REDIRECT_URI, PASSWORD, startTestServer, type TestServer } from './helpers.js';

/**
 * The official MCP client, with the "browser" step automated: when it asks the user to
 * sign in, this submits the password on the sign-in page and captures the returned code.
 */
class PasswordSigningClient implements OAuthClientProvider {
	private info?: OAuthClientInformationMixed;
	private savedTokens?: OAuthTokens;
	private verifier = '';
	authorizationCode?: string;

	constructor(private readonly password: string) {}

	get redirectUrl(): string {
		return CLIENT_REDIRECT_URI;
	}

	get clientMetadata() {
		return {
			client_name: 'MCP SDK test client',
			redirect_uris: [CLIENT_REDIRECT_URI],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none',
		};
	}

	clientInformation() {
		return this.info;
	}

	saveClientInformation(info: OAuthClientInformationMixed): void {
		this.info = info;
	}

	tokens() {
		return this.savedTokens;
	}

	saveTokens(tokens: OAuthTokens): void {
		this.savedTokens = tokens;
	}

	saveCodeVerifier(verifier: string): void {
		this.verifier = verifier;
	}

	codeVerifier(): string {
		return this.verifier;
	}

	async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
		const form = new URLSearchParams(authorizationUrl.searchParams);
		form.set('password', this.password);
		const res = await fetch(new URL('/authorize', authorizationUrl), {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: form,
			redirect: 'manual',
		});
		this.authorizationCode = new URL(res.headers.get('location') ?? CLIENT_REDIRECT_URI).searchParams.get('code') ?? undefined;
	}
}

describe('the official MCP client', () => {
	let server: TestServer;

	before(async () => {
		server = await startTestServer();
	});

	after(async () => {
		await server.close();
	});

	it('discovers the sign-in, registers, signs in and lists the tools', async () => {
		const mcpUrl = new URL('/mcp', server.baseUrl);
		const auth = new PasswordSigningClient(PASSWORD);

		// First attempt: 401 → discovery → registration → "open the sign-in page".
		const firstTransport = new StreamableHTTPClientTransport(mcpUrl, { authProvider: auth });
		await assert.rejects(new Client({ name: 'test', version: '0' }).connect(firstTransport), UnauthorizedError);
		assert.ok(auth.authorizationCode, 'signing in should return an authorization code');
		await firstTransport.finishAuth(auth.authorizationCode);

		// Second attempt: signed in.
		const client = new Client({ name: 'test', version: '0' });
		await client.connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: auth }));
		const { tools } = await client.listTools();
		assert.equal(tools.length, 6);

		const today = await client.callTool({ name: 'get_today', arguments: {} });
		assert.match(JSON.stringify(today.content), /Not authenticated with Whoop/);
		await client.close();
	});

	it('gets no code with the wrong password', async () => {
		const auth = new PasswordSigningClient('not the password at all');
		const transport = new StreamableHTTPClientTransport(new URL('/mcp', server.baseUrl), { authProvider: auth });
		await assert.rejects(new Client({ name: 'test', version: '0' }).connect(transport), UnauthorizedError);
		assert.equal(auth.authorizationCode, undefined);
	});
});
