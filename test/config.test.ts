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
		assert.equal(loadConfig({ MCP_AUTH_PASSWORD: PASSWORD, RAILWAY_ENVIRONMENT_ID: 'env-123' }).trustProxy, 1);
	});

	it('takes TRUST_PROXY as a hop count, "false", or a list of proxy addresses', () => {
		assert.equal(loadConfig({ MCP_AUTH_PASSWORD: PASSWORD, TRUST_PROXY: '2' }).trustProxy, 2);
		assert.equal(loadConfig({ MCP_AUTH_PASSWORD: PASSWORD, TRUST_PROXY: 'false', RAILWAY_ENVIRONMENT_ID: 'x' }).trustProxy, false);
		assert.equal(loadConfig({ MCP_AUTH_PASSWORD: PASSWORD, TRUST_PROXY: 'loopback, 10.0.0.0/8' }).trustProxy, 'loopback, 10.0.0.0/8');
	});

	it('refuses TRUST_PROXY=true, which would let any client pick its own address', () => {
		assert.throws(() => loadConfig({ MCP_AUTH_PASSWORD: PASSWORD, TRUST_PROXY: 'true' }), /TRUST_PROXY/);
	});

	it('refuses a plain-http public URL outside localhost', () => {
		assert.throws(
			() => loadConfig({ MCP_AUTH_PASSWORD: PASSWORD, PUBLIC_URL: 'http://my-app.example.com' }),
			/must use https/,
		);
	});
});
