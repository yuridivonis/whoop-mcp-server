/**
 * @yuridivonis/whoop-client: a small, typed client for the WHOOP API v2.
 *
 * Independent open source, not affiliated with, endorsed by, or sponsored by WHOOP.
 * Every export is named here, and nothing else in the package is public.
 */
export { WhoopClient } from './client.js';
export type { WhoopClientOptions } from './client.js';
export {
	WhoopAuthError,
	WhoopError,
	WhoopProtocolError,
	WhoopRateLimitError,
	WhoopRequestError,
	WhoopUnavailableError,
} from './errors.js';
export type { WhoopAuthReason } from './errors.js';
export type {
	ScoreState,
	StoredWhoopTokens,
	TokenStore,
	WhoopCycle,
	WhoopQuery,
	WhoopRecovery,
	WhoopScope,
	WhoopSleep,
	WhoopTokens,
	WhoopWorkout,
	WhoopProfile,
	WhoopBodyMeasurement,
} from './types.js';
export { localDate, localTime, parseOffset, wakeDay } from './days.js';
export { timeAsleepMilli } from './sleep.js';
