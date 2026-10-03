/**
 * Type-level check, compiled by `npm run typecheck` and never run: every documented type is
 * exported by name. Dropping one fails the build.
 */
import type {
	ScoreState,
	StoredWhoopTokens,
	TokenStore,
	WhoopAuthReason,
	WhoopBodyMeasurement,
	WhoopClientOptions,
	WhoopCycle,
	WhoopProfile,
	WhoopQuery,
	WhoopRecovery,
	WhoopScope,
	WhoopSleep,
	WhoopTokens,
	WhoopWorkout,
} from '@yuridivonis/whoop-client';

export type Documented = [
	ScoreState,
	StoredWhoopTokens,
	TokenStore,
	WhoopAuthReason,
	WhoopBodyMeasurement,
	WhoopClientOptions,
	WhoopCycle,
	WhoopProfile,
	WhoopQuery,
	WhoopRecovery,
	WhoopScope,
	WhoopSleep,
	WhoopTokens,
	WhoopWorkout,
];
