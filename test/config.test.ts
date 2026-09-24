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

	it('refuses a plain-http public URL outside localhost', () => {
		assert.throws(
			() => loadConfig({ MCP_AUTH_PASSWORD: PASSWORD, PUBLIC_URL: 'http://my-app.example.com' }),
			/must use https/,
		);
	});
});
