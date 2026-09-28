import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WhoopAuthError, WhoopRateLimitError, WhoopRequestError, WhoopUnavailableError } from '@yuridivonis/whoop-client';
import { whoopMessage } from '../src/whoop-messages.js';

describe('the server wording for WHOOP errors', () => {
	it('tells the agent to use get_auth_url for every authorization failure', () => {
		assert.equal(whoopMessage(new WhoopAuthError('not_connected')), 'Not authenticated with Whoop. Use the get_auth_url tool to connect.');
		assert.equal(
			whoopMessage(new WhoopAuthError('refresh_interrupted')),
			"A WHOOP token refresh didn't finish, so WHOOP may have replaced the token without this server getting the new one. Use the get_auth_url tool to reconnect.",
		);
		assert.equal(whoopMessage(new WhoopAuthError('authorization_ended')), 'Whoop authorization expired. Use the get_auth_url tool to reconnect.');
	});

	it('names the settings to check when WHOOP refuses the app credentials, with the code WHOOP gave', () => {
		for (const code of ['invalid_client', 'unauthorized_client']) {
			assert.equal(
				whoopMessage(new WhoopRequestError(`WHOOP refused the app's client credentials (${code}).`, 401, { oauthError: code })),
				`WHOOP refused this server's app credentials (${code}). Check WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET.`,
			);
		}
	});

	it("passes everything else through in the client's own words", () => {
		for (const error of [new WhoopRateLimitError(), new WhoopUnavailableError('WHOOP is unavailable right now.'), new WhoopRequestError('WHOOP refused the request.', 404)]) {
			assert.equal(whoopMessage(error), error.message);
		}
		// A reason from a newer version of the client.
		assert.equal(whoopMessage(new WhoopAuthError('some_new_reason' as never, 'Authorize again.')), 'Authorize again.');
	});
});
