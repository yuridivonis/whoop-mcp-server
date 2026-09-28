/**
 * Every error the client throws for WHOOP is a WhoopError. Each class sets a stable `name`,
 * for code that can't rely on instanceof (for example with two copies of this package).
 * Every constructor takes the standard `cause`: the library never logs, so the cause is how
 * a caller sees what went wrong underneath.
 */

/** Anything that went wrong talking to WHOOP, as opposed to the token store. */
export class WhoopError extends Error {
	constructor(message?: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'WhoopError';
	}
}

/**
 * Why WHOOP can't be used until the user authorizes again. New reasons may be added in a
 * minor release, so a `switch` over them needs a default branch.
 */
export type WhoopAuthReason = 'not_connected' | 'refresh_interrupted' | 'authorization_ended';

const AUTH_MESSAGES: Record<WhoopAuthReason, string> = {
	not_connected: "WHOOP isn't connected: there are no tokens.",
	refresh_interrupted: "A token refresh didn't finish, so WHOOP may have replaced the refresh token. Authorize again.",
	authorization_ended: 'WHOOP ended the authorization. Authorize again.',
};

/** WHOOP isn't connected, or the authorization can't be used any more: the user has to authorize again. */
export class WhoopAuthError extends WhoopError {
	readonly reason: WhoopAuthReason;
	/** The OAuth error code WHOOP gave when it refused the code or refresh token itself (`invalid_grant`), if it gave one. */
	readonly oauthError?: string;

	constructor(reason: WhoopAuthReason, message: string = AUTH_MESSAGES[reason], { oauthError, ...options }: { oauthError?: string } & ErrorOptions = {}) {
		super(message, options);
		this.name = 'WhoopAuthError';
		this.reason = reason;
		this.oauthError = oauthError;
	}
}

/** WHOOP's rate limit was reached. */
export class WhoopRateLimitError extends WhoopError {
	/** Seconds until the limit resets, from WHOOP's X-RateLimit-Reset header, when it sent one. */
	readonly resetSeconds?: number;

	constructor({ resetSeconds, ...options }: { resetSeconds?: number } & ErrorOptions = {}) {
		super("WHOOP's rate limit was reached. Try again in a minute.", options);
		this.name = 'WhoopRateLimitError';
		this.resetSeconds = resetSeconds;
	}
}

/** WHOOP failed (5xx), didn't answer in time, or couldn't be reached. */
export class WhoopUnavailableError extends WhoopError {
	/** WHOOP's HTTP status, when it answered at all. */
	readonly status?: number;
	/** False when the request certainly never reached WHOOP, such as when its address couldn't be looked up. */
	readonly reachedWhoop: boolean;

	constructor(message: string, { status, reachedWhoop = true, ...options }: { status?: number; reachedWhoop?: boolean } & ErrorOptions = {}) {
		super(message, options);
		this.name = 'WhoopUnavailableError';
		this.status = status;
		this.reachedWhoop = reachedWhoop;
	}
}

/** WHOOP turned the request away: a 4xx that isn't about the user's authorization or the rate limit. */
export class WhoopRequestError extends WhoopError {
	readonly status: number;
	/** The OAuth error code, when the token endpoint refused the app itself (for example `invalid_client`). */
	readonly oauthError?: string;

	constructor(message: string, status: number, { oauthError, ...options }: { oauthError?: string } & ErrorOptions = {}) {
		super(message, options);
		this.name = 'WhoopRequestError';
		this.status = status;
		this.oauthError = oauthError;
	}
}

/** WHOOP answered in a form the client can't use: a malformed token response, or paging that doesn't end. */
export class WhoopProtocolError extends WhoopError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'WhoopProtocolError';
	}
}
