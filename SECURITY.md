# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.1.x   | Yes |
| 1.0.x   | No. `/mcp` has no authentication. Upgrade as described in [Upgrading from 1.0.0](README.md#upgrading-from-100). |

## Reporting a vulnerability

Please report vulnerabilities privately: open the [Security tab](https://github.com/yuridivonis/whoop-mcp-server/security) and choose **Report a vulnerability**. Please don't open a public issue.

Include what you found, how to reproduce it, and what an attacker could do with it. I'll acknowledge your report within 7 days, keep you updated while it's being fixed, and credit you in the advisory unless you'd rather stay anonymous.

**In scope:** the code in this repository, including the sign-in for `/mcp`, the Whoop authorization callback, token storage, and the MCP tools.

**Out of scope:** the Whoop API and MCP clients such as Claude, and problems that need a misconfigured deployment (for example a guessable `MCP_AUTH_PASSWORD`).

## How the server protects your data

- **Sign-in:** `/mcp` requires an OAuth 2.1 access token. Clients register themselves and use PKCE, and the owner signs in with `MCP_AUTH_PASSWORD`. In `http` mode the server refuses to start without a password of at least 16 characters, or with a public URL that isn't https.
- **Tokens:** access tokens last an hour. Refresh tokens rotate on every use and expire after 30 days unused. Codes and tokens are stored only as SHA-256 hashes, and are only issued for this server's `/mcp`.
- **Replay protection:** if a code or refresh token is ever used twice, the whole sign-in it belongs to is revoked.
- **Where codes go:** sign-in codes are only sent to Claude, ChatGPT, desktop apps on the owner's own computer (local addresses, and Cursor, VS Code, and Windsurf links), or web clients added with `MCP_ALLOWED_REDIRECT_HOSTS`. The sign-in page names the destination and warns not to sign in from a link someone else sent, and every successful sign-in is logged.
- **Password changes:** every code and token is tied to the password it was issued under, so changing `MCP_AUTH_PASSWORD` signs every client out. A server still running with the old password stops accepting sign-ins and tokens too.
- **Password guessing:** failed sign-ins are limited to 10 per address every 15 minutes, and 50 per hour in total. Client addresses come from proxies you trust (`TRUST_PROXY`: one hop on Railway, none elsewhere), so they can't be forged.
- **Whoop authorization:** each link from `get_auth_url` carries a one-time `state` that expires after 10 minutes.
- **Stored Whoop tokens:** encrypted with AES-256-GCM, using a key derived from `ENCRYPTION_SECRET` (or `WHOOP_CLIENT_SECRET` if that isn't set).
- **Public endpoints:** `/health` only reports that the server is up, and says nothing about your data or your Whoop connection.

## If you run a deployment

- **Stay up to date:** keep your fork updated (GitHub's **Sync fork** button), and watch this repository's releases (**Watch → Custom → Releases**) to hear about security fixes.
- **Secrets:** use a long random `MCP_AUTH_PASSWORD` and set `ENCRYPTION_SECRET`.
- **Signing everyone out:** change `MCP_AUTH_PASSWORD` and redeploy. Every existing sign-in stops working, so your MCP clients will ask you to sign in again. Do this if you think your password may have leaked.
- **Watching for strangers:** every successful sign-in is logged as `Signed in: client <id>, returning to <destination>, app "<name>"`. Check your server logs for any you don't recognize.
- **If your data was accessed:** you registered your own Whoop developer app, so you are the developer under WHOOP's [API Terms of Use](https://developer.whoop.com/api-terms-of-use/). They require you to notify WHOOP within 48 hours of discovering a security incident (§2.4).

Published advisories are listed under [Security → Advisories](https://github.com/yuridivonis/whoop-mcp-server/security/advisories).
