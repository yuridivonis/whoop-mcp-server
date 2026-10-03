# whoop-client

A small, typed client for the [WHOOP API v2](https://developer.whoop.com/docs/introduction): sign-in, token refresh that survives WHOOP's rotating refresh tokens, and your recovery, sleep, strain and workouts. It's the library the [WHOOP MCP server](../../README.md) is built on, for anyone who wants WHOOP data in their own code.

> This is an independent open-source project. It uses the WHOOP API to access data from WHOOP products, and is not affiliated with, endorsed by, or sponsored by WHOOP.

**Status: not published yet.** Version 0.1.0 comes to npm as `@yuridivonis/whoop-client` with a later server release. Until then it lives in this repository, and the API may still change.

- **No runtime dependencies,** and no Node-only APIs: it runs wherever `fetch` does (Node 22 or later, and other runtimes with `fetch`).
- **It never logs.** Errors carry what went wrong, with a machine-readable `reason` where it matters, and the underlying `cause`.
- **Nothing is cached.** Every call fetches from WHOOP; only the tokens are kept, in a store you provide.

## Usage

```ts
import { WhoopClient, WhoopAuthError } from '@yuridivonis/whoop-client';

const whoop = new WhoopClient({
  clientId: process.env.WHOOP_CLIENT_ID!,
  clientSecret: process.env.WHOOP_CLIENT_SECRET!,
  redirectUri: 'https://your-app.example.com/callback',
  store: myTokenStore, // see "Token store" below
});

// 1. Send the user to WHOOP. Keep the state, and check it when they come back.
const link = whoop.authorizationUrl({ scopes: ['read:recovery', 'read:sleep', 'offline'], state });

// 2. On your callback, with the code WHOOP sends:
await whoop.connect(code);

// 3. Read data. Tokens are refreshed as needed.
try {
  const recoveries = await whoop.recoveries({ start: '2026-09-01T00:00:00.000Z' });
} catch (error) {
  if (error instanceof WhoopAuthError) {
    // error.reason: 'not_connected' | 'refresh_interrupted' | 'authorization_ended'.
    // Each means: send the user through sign-in again.
  }
}
```

## API

- **`new WhoopClient(options)`**:
  - `clientId`, `clientSecret`, `store`;
  - `redirectUri`, which `authorizationUrl()` and `connect()` need;
  - `fetch`, for example a fake WHOOP in tests;
  - `timeoutMs` per request (default 15 000);
  - `retry`: `false` turns the one retry off (below); `{ wait }` replaces its timer, for tests.
- **`authorizationUrl({ scopes, state })`**: the WHOOP sign-in link. It throws `TypeError` without `redirectUri`, without the `offline` scope (WHOOP then issues no refresh token), or for a `state` under 8 characters.
- **`connect(code)`**: exchanges the code from WHOOP's sign-in, saves the tokens and uses them from then on.
- **`cycles(query)`, `recoveries(query)`, `sleeps(query)`, `workouts(query)`**:
  - every record in the range, newest first;
  - `query` is `{ start?, end?, limit? }`, with times in ISO 8601;
  - identical calls made while one is still running share its request.
- **`revokeAccess()`**: revokes the app's access at WHOOP, then forgets the tokens (below).
- **Day helpers:**
  - `localDate(iso, offset)` and `localTime(iso, offset)`: the date and time where a record happened, from WHOOP's UTC time and timezone offset;
  - `wakeDay(sleepStart, offset)`: the day a night of sleep, and the cycle it starts, belong to;
  - `parseOffset(offset)`: returns `null` for an offset that can't be read (the helpers then use UTC);
  - `timeAsleepMilli(sleep)`: time asleep, summed from the stages.
- **Types:**
  - the records: `WhoopCycle`, `WhoopRecovery`, `WhoopSleep`, `WhoopWorkout`, with every field of WHOOP's API v2 models (steps, sleep need and disturbances, workout distance and elevation, the calibrating flag, …), each documented with its unit;
  - `WhoopProfile` and `WhoopBodyMeasurement`, WHOOP's profile and body models (no method fetches them yet: they need scopes the server doesn't ask for);
  - `WhoopQuery`, `WhoopScope`, `ScoreState`, `WhoopTokens`, `StoredWhoopTokens`, `TokenStore`, `WhoopClientOptions`, `WhoopAuthReason`.

## Retries

Each page of a data read (`cycles()` and the other three) is sent once more, and only once, when WHOOP answers 429 naming a wait of at most 10 seconds (the client waits that long plus a second), or 429 without a wait (it waits a second), or 500, 502, 503 or 504 (it waits what `Retry-After` names up to 10 seconds, else a second). So a many-page read can wait once per page, up to 11 seconds each. A 429 or a 5xx naming a longer wait isn't waited out: the error's message says how long, and `WhoopRateLimitError.resetSeconds` carries the number. A page resent after a 401 refresh is final: a 429 or 5xx on that resend is reported, not retried. The token endpoint and `revokeAccess()` are never retried, so the refresh rules below are untouched. Timeouts and network errors aren't retried either. `retry: false` turns it off.

## Errors

Every error from WHOOP is a `WhoopError`. Each class has a stable `name`, for code that can't rely on `instanceof`.

| Class | Meaning |
|---|---|
| `WhoopAuthError` | The user must sign in again. `reason` says why: `not_connected`, `refresh_interrupted` or `authorization_ended`. `oauthError` is `invalid_grant` when WHOOP refused the token explicitly. New reasons may come in a minor release, so a `switch` on it needs a default branch |
| `WhoopRateLimitError` | WHOOP's rate limit, after the retry if there was one. `resetSeconds` comes from WHOOP's `X-RateLimit-Reset` or `Retry-After`, when sent, and the message says "try again in N seconds" |
| `WhoopUnavailableError` | WHOOP failed (5xx), timed out, couldn't be reached, or its answer was cut off mid-body (then `status` is 200). Also carries `status` and `reachedWhoop` |
| `WhoopRequestError` | WHOOP turned the request away (another 4xx). Carries `status`, and `oauthError` when the app's own credentials were refused |
| `WhoopProtocolError` | WHOOP answered in a form the client can't use: a 200 whose body isn't JSON or whose `records` isn't an array (a page without `records` counts as empty), a malformed token response, or paging that doesn't end. The message names the endpoint and never quotes the body |

## Token store

WHOOP replaces the refresh token on every refresh, and presenting a used one can end the whole authorization. The client follows one set of refresh rules to avoid that. Its source comments have the detail, and it relies on your store:

```ts
interface TokenStore {
  load(): Promise<StoredWhoopTokens | null>;
  save(tokens: StoredWhoopTokens): Promise<void>;
  withLock?<T>(fn: () => Promise<T>): Promise<T>;
  clear?(): Promise<void>;
}
```

- **`save` and `clear` must be durable** before they resolve. The client retries each once. If `clear` fails twice, the client still forgets its tokens and throws the store's error.
- **Store the tokens exactly as given,** including `refresh_started_at`: it marks a refresh in progress.
- **Share one store object** between clients in the same process: they then refresh one at a time.
- **Implement `withLock` when several processes share the tokens.**
  - `load`, `save` and `clear` run inside it, so it must not block them. Never nest it.
  - Every writer of the tokens takes the same lock.
- **Implement `clear` if you use `revokeAccess()`.**
  - Without it, the store keeps tokens WHOOP has revoked, and their next use asks the user to sign in again.
  - `revokeAccess()` never clears tokens saved while it was running, such as a reconnect: they may be a new, live authorization.
  - It forgets tokens without a revoke only when WHOOP itself has ended the authorization: an explicit `invalid_grant`, or a 401 even after a refresh. A refusal it can't read (say, a proxy's 401 page) is thrown instead, so a live grant is never abandoned.
  - WHOOP's revoke may cover all of the user's tokens for your app, so a reconnect WHOOP handled before the revoke can end up revoked too, and asks to sign in again when used.

## Licence

MIT. See [LICENSE](LICENSE).
