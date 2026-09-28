import { WhoopAuthError, WhoopRequestError, type WhoopError } from '@yuridivonis/whoop-client';

/**
 * What the tools and the log say about a WHOOP error. The WHOOP client's own messages are
 * neutral; this is where the server's wording lives, naming its own tool and settings.
 */
export function whoopMessage(error: WhoopError): string {
	if (error instanceof WhoopAuthError) {
		switch (error.reason) {
			case 'not_connected':
				return 'Not authenticated with Whoop. Use the get_auth_url tool to connect.';
			case 'refresh_interrupted':
				return "A WHOOP token refresh didn't finish, so WHOOP may have replaced the token without this server getting the new one. " +
					'Use the get_auth_url tool to reconnect.';
			case 'authorization_ended':
				return 'Whoop authorization expired. Use the get_auth_url tool to reconnect.';
			default:
				// A reason from a newer version of the client.
				return error.message;
		}
	}
	if (error instanceof WhoopRequestError && error.oauthError !== undefined) {
		return `WHOOP refused this server's app credentials (${error.oauthError}). Check WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET.`;
	}
	return error.message;
}
