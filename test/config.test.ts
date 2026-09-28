import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig } from '../src/config.js';

const PASSWORD = 'a-long-enough-password';

describe('loadConfig', () => {
	it('refuses to start in http mode without a password', () => {
		assert.throws(() => loadConfig({}), ConfigError);
		assert.throws(() => loadConfig({}), /MCP_AUTH_PASSWORD/);
	});

	it('refuses a password shorter than 16 characters', () => {
		assert.throws(() => loadConfig({ MCP_AUTH_PASSWORD: 'short' }), /at least 16 characters/);
	});

	it('does not need a password in stdio mode', () => {
		assert.equal(loadConfig({ MCP_MODE: 'stdio' }).mode, 'stdio');
	});

	it('takes the public URL from the WHOOP redirect URI', () => {
		const config = loadConfig({
			MCP_AUTH_PASSWORD: PASSWORD,
			WHOOP_REDIRECT_URI: 'https://my-app.up.railway.app/callback',
		});
		assert.equal(config.publicUrl.href, 'https://my-app.up.railway.app/');
	});

	it('lets PUBLIC_URL override the redirect URI', () => {
		const config = loadConfig({
			MCP_AUTH_PASSWORD: PASSWORD,
			WHOOP_REDIRECT_URI: 'https://my-app.up.railway.app/callback',
			PUBLIC_URL: 'https://whoop.example.com',
		});
		assert.equal(config.publicUrl.href, 'https://whoop.example.com/');
	});

	it('does not trust X-Forwarded-For by default', () => {
		assert.equal(loadConfig({ MCP_AUTH_PASSWORD: PASSWORD }).trustProxy, false);
	});

	it('trusts the one proxy hop in front of a Railway deployment', () => {
		assert.equal(loadConfig({ MCP_AUTH_PASSWORD: PASSWORD, RAILWAY_ENVIRONMENT_ID: 'env-123', RAILWAY_PUBLIC_DOMAIN: 'my-app.up.railway.app' }).trustProxy, 1);
	});

	it('takes TRUST_PROXY as a hop count, "false", or a list of proxy addresses', () => {
		assert.equal(loadConfig({ MCP_AUTH_PASSWORD: PASSWORD, TRUST_PROXY: '2' }).trustProxy, 2);
		assert.equal(loadConfig({ MCP_AUTH_PASSWORD: PASSWORD, TRUST_PROXY: 'false', RAILWAY_ENVIRONMENT_ID: 'x', RAILWAY_PUBLIC_DOMAIN: 'my-app.up.railway.app' }).trustProxy, false);
		assert.equal(loadConfig({ MCP_AUTH_PASSWORD: PASSWORD, TRUST_PROXY: 'loopback, 10.0.0.0/8' }).trustProxy, 'loopback, 10.0.0.0/8');
	});

	it('refuses TRUST_PROXY=true, which would let any client pick its own address', () => {
		assert.throws(() => loadConfig({ MCP_AUTH_PASSWORD: PASSWORD, TRUST_PROXY: 'true' }), /TRUST_PROXY/);
	});

	it('allows Claude and ChatGPT as sign-in destinations by default', () => {
		assert.deepEqual(loadConfig({ MCP_AUTH_PASSWORD: PASSWORD }).allowedRedirectHosts, ['claude.ai', 'claude.com', 'chatgpt.com']);
	});

	it('adds hosts from MCP_ALLOWED_REDIRECT_HOSTS', () => {
		const config = loadConfig({ MCP_AUTH_PASSWORD: PASSWORD, MCP_ALLOWED_REDIRECT_HOSTS: ' Mcp-Client.example, claude.ai ,' });
		assert.deepEqual(config.allowedRedirectHosts, ['claude.ai', 'claude.com', 'chatgpt.com', 'mcp-client.example']);
	});

	it('refuses MCP_ALLOWED_REDIRECT_HOSTS entries that are not host names', () => {
		assert.throws(
			() => loadConfig({ MCP_AUTH_PASSWORD: PASSWORD, MCP_ALLOWED_REDIRECT_HOSTS: 'https://example.com/callback' }),
			/MCP_ALLOWED_REDIRECT_HOSTS/,
		);
	});

	it('refuses a plain-http public URL outside localhost', () => {
		assert.throws(
			() => loadConfig({ MCP_AUTH_PASSWORD: PASSWORD, PUBLIC_URL: 'http://my-app.example.com' }),
			/must use https/,
		);
	});
});

describe('the WHOOP callback address, when WHOOP_REDIRECT_URI is not set', () => {
	it('is derived from PUBLIC_URL', () => {
		const config = loadConfig({ MCP_AUTH_PASSWORD: PASSWORD, PUBLIC_URL: 'https://whoop.example.com/' });
		assert.equal(config.redirectUri, 'https://whoop.example.com/callback');
	});

	it("is derived from the service's domain on Railway, so nobody has to type it", () => {
		const config = loadConfig({ MCP_AUTH_PASSWORD: PASSWORD, RAILWAY_ENVIRONMENT_ID: 'env-123', RAILWAY_PUBLIC_DOMAIN: ' My-App.up.railway.app ' });
		assert.equal(config.redirectUri, 'https://my-app.up.railway.app/callback');
		assert.equal(config.publicUrl.href, 'https://my-app.up.railway.app/');
	});

	it('takes PUBLIC_URL before the Railway domain, and an explicit WHOOP_REDIRECT_URI before both', () => {
		const railway = { RAILWAY_ENVIRONMENT_ID: 'env-123', RAILWAY_PUBLIC_DOMAIN: 'my-app.up.railway.app' };
		assert.equal(loadConfig({ MCP_AUTH_PASSWORD: PASSWORD, ...railway, PUBLIC_URL: 'https://whoop.example.com' }).redirectUri, 'https://whoop.example.com/callback');
		assert.equal(
			loadConfig({ MCP_AUTH_PASSWORD: PASSWORD, ...railway, PUBLIC_URL: 'https://whoop.example.com', WHOOP_REDIRECT_URI: 'https://other.example.com/cb' }).redirectUri,
			'https://other.example.com/cb',
		);
	});

	it('stays on this computer when neither is set', () => {
		assert.equal(loadConfig({ MCP_AUTH_PASSWORD: PASSWORD }).redirectUri, 'http://localhost:3000/callback');
	});

	it('refuses to start on Railway until the service has a domain, and says how to get one', () => {
		assert.throws(() => loadConfig({ MCP_AUTH_PASSWORD: PASSWORD, RAILWAY_ENVIRONMENT_ID: 'env-123' }), /generate a domain.*or set WHOOP_REDIRECT_URI/);
		assert.throws(() => loadConfig({ MCP_AUTH_PASSWORD: PASSWORD, RAILWAY_ENVIRONMENT_ID: 'env-123', RAILWAY_PUBLIC_DOMAIN: '  ' }), /generate a domain/);
		assert.throws(() => loadConfig({ MCP_AUTH_PASSWORD: PASSWORD, RAILWAY_ENVIRONMENT_ID: 'env-123', RAILWAY_PUBLIC_DOMAIN: 'not a host' }), /RAILWAY_PUBLIC_DOMAIN.*WHOOP_REDIRECT_URI/);
	});

	it('refuses an address whose host is missing, as a reference to a domain that does not exist yet gives', () => {
		assert.throws(() => loadConfig({ MCP_AUTH_PASSWORD: PASSWORD, WHOOP_REDIRECT_URI: 'https:///callback' }), /WHOOP_REDIRECT_URI has no host/);
		assert.throws(() => loadConfig({ MCP_AUTH_PASSWORD: PASSWORD, PUBLIC_URL: 'https:///' }), /PUBLIC_URL has no host/);
		// A single-label host is unusual but valid, and was accepted before.
		assert.equal(loadConfig({ MCP_AUTH_PASSWORD: PASSWORD, WHOOP_REDIRECT_URI: 'https://myserver/callback' }).publicUrl.href, 'https://myserver/');
	});

	it('does not apply the http-mode guards in stdio mode', () => {
		assert.equal(loadConfig({ MCP_MODE: 'stdio', RAILWAY_ENVIRONMENT_ID: 'env-123' }).mode, 'stdio');
		assert.equal(loadConfig({ MCP_MODE: 'stdio', RAILWAY_ENVIRONMENT_ID: 'env-123', RAILWAY_PUBLIC_DOMAIN: 'not a host' }).mode, 'stdio');
	});
});

describe('whoopConfigured', () => {
	it('needs both WHOOP app values, and ignores whitespace', () => {
		const base = { MCP_AUTH_PASSWORD: PASSWORD };
		assert.equal(loadConfig({ ...base, WHOOP_CLIENT_ID: 'id', WHOOP_CLIENT_SECRET: 'secret' }).whoopConfigured, true);
		assert.equal(loadConfig({ ...base, WHOOP_CLIENT_ID: '', WHOOP_CLIENT_SECRET: 'secret' }).whoopConfigured, false);
		assert.equal(loadConfig({ ...base, WHOOP_CLIENT_ID: 'id', WHOOP_CLIENT_SECRET: '' }).whoopConfigured, false);
		assert.equal(loadConfig({ ...base, WHOOP_CLIENT_ID: '  ', WHOOP_CLIENT_SECRET: 'secret' }).whoopConfigured, false);
		assert.equal(loadConfig(base).whoopConfigured, false);
	});
});
