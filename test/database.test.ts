import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WhoopDatabase } from '../src/database.js';

const originalSecret = process.env.ENCRYPTION_SECRET;

describe('stored WHOOP tokens', () => {
	afterEach(() => {
		process.env.ENCRYPTION_SECRET = originalSecret;
	});

	it('read as "not connected" instead of crashing after the encryption key changes', () => {
		const db = new WhoopDatabase(':memory:');
		process.env.ENCRYPTION_SECRET = 'key-before-rotation';
		db.saveTokens({ access_token: 'access', refresh_token: 'refresh', expires_at: Date.now() + 3_600_000 });

		process.env.ENCRYPTION_SECRET = 'key-after-rotation';
		assert.equal(db.getTokens(), null);

		// Reconnecting stores fresh tokens under the new key.
		db.saveTokens({ access_token: 'new-access', refresh_token: 'new-refresh', expires_at: Date.now() + 3_600_000 });
		assert.equal(db.getTokens()?.access_token, 'new-access');
	});
});
