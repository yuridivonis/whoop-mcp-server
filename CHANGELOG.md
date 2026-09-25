# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [1.1.0] - Unreleased

Upgrading takes a few minutes: see [Upgrading from 1.0.0](README.md#upgrading-from-100).

### Security

- **Sign-in required:** `/mcp` now requires sign-in. In 1.0.0, any server that worked with Claude served its Whoop data and tools to anyone who knew its URL. Claude.ai now signs in with OAuth 2.1 (client registration, PKCE) using a password you choose, `MCP_AUTH_PASSWORD`, and the server refuses to start without one. (#5)
- **Token handling:** sign-in tokens are stored as hashes, rotate on every refresh, and are only issued for this server. Reusing a code or refresh token revokes the whole sign-in, and failed sign-ins are rate-limited. (#5)
- **Whoop links:** the Whoop authorization callback only accepts one-time links issued by `get_auth_url`. (#5)
- **Password changes:** changing `MCP_AUTH_PASSWORD` signs every client out, and a server still running with the old password stops accepting sign-ins and tokens. (#6)
- **Where sign-in codes go:** codes are only sent to Claude, ChatGPT, desktop apps on your own computer, or web clients you add with `MCP_ALLOWED_REDIRECT_HOSTS`. The sign-in page shows where you'll return, and warns against signing in from a link someone else sent. (#6)
- **Health check:** `/health` no longer reveals whether a Whoop account is connected. (#6)
- **SDK update:** `@modelcontextprotocol/sdk` is updated to 1.26 or later, for GHSA-345p-7cg4-v4c7 and GHSA-8r9q-7v3j-jr4g. This server didn't use the affected features, but scanners flagged the old version. (#5)
- **Docker image:** it now runs on Node 24. It used Node 20, which no longer receives security updates. better-sqlite3 is upgraded to 13 alongside, because older versions can crash the process on Node 24.19 and later ([nodejs/node#65446](https://github.com/nodejs/node/issues/65446)). (#6)

### Fixed

- **Connecting over HTTP:** Claude couldn't connect over HTTP, because the JSON middleware consumed request bodies before the MCP transport read them. (#5)
- **Workouts:** workouts never synced on Whoop API v2, which renamed the heart-rate zone field to `zone_durations`. Thanks to @nkondratyk93, who proposed the same fix in #2. (#5)
- **Whoop logouts:** parallel token refreshes could log you out of Whoop. They now share one refresh, and a rejected request is retried once. (#5)
- **Stale sessions:** after a redeploy, clients failed with stale session IDs. The server is now stateless. Thanks to @Dealing1191 for raising this in #4. (#5)
- **Changed encryption key:** a changed key crashed the server at startup. Stored tokens that can't be decrypted now read as disconnected. (#5)
- **Architecture diagram:** the diagram in the README was misaligned. Thanks to @sweenzor. (#1)

### Added

- **Tests:** a test suite that drives the server over HTTP, including a full sign-in with the official MCP client. (#5)
- **CI:** type checks, tests on Node 22 and 24, a dependency audit, and a Docker smoke test run on every pull request. (#6)
- **Security policy:** `SECURITY.md`, with private vulnerability reporting. (#6)

### Changed

- **Bounded paging:** paging through Whoop results stops after 100 pages or on a repeated cursor, and each request times out after 15 seconds. (#5)
- **Syncs:** syncs never overlap, and failed syncs are written to the server log. (#5)
- **Stale data:** tools say when data couldn't be refreshed, instead of silently showing the last sync. (#5)
- **Node version:** Node.js 22 or later is required. (#6)
- **Sign-in log:** each successful sign-in is written to the server log, with the app's name, its client ID, and where it returned. (#6)
- **ChatGPT compatibility:** the server accepts its bare address as the OAuth resource, which ChatGPT may send. (#6)
- **One-time sign-out:** a server that ran `main` before #6 signs its clients out once when it upgrades. (#6)
- **Local development:** `npm run dev` loads `.env`. (#5)

### Removed

- **Unused API calls:** the Whoop profile and body-measurement calls, which nothing used. (#5)

## [1.0.0] - 2025-12-15

Initial release: a remote MCP server with Whoop recovery, sleep, and strain tools, a local SQLite cache, and Railway deployment.
