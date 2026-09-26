# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.3.x   | Yes |
| 1.1.x to 1.2.x | No. They keep a copy of your Whoop data. Upgrade as described in [Upgrading to 1.3.0](README.md#upgrading-to-130). |
| 1.0.x   | No. `/mcp` has no authentication. Upgrade as described in [Upgrading from 1.0.0](README.md#upgrading-from-100), then to 1.3.0. |

## Reporting a vulnerability

Please report vulnerabilities privately: open the [Security tab](https://github.com/yuridivonis/whoop-mcp-server/security) and choose **Report a vulnerability**. Please don't open a public issue.

Include what you found, how to reproduce it, and what an attacker could do with it. I'll acknowledge your report within 7 days, keep you updated while it's being fixed, and credit you in the advisory unless you'd rather stay anonymous.

**In scope:** the code in this repository, including the sign-in for `/mcp`, the Whoop authorization callback, token storage, and the MCP tools.

**Out of scope:** the Whoop API and MCP clients such as Claude, and problems that need a misconfigured deployment (for example a guessable `MCP_AUTH_PASSWORD`).

## Threat model

**What's worth protecting:**
- **Your WHOOP data**, while the server fetches it and hands it to an app.
- **Your WHOOP tokens**, which can read that data until you revoke them.
- **The server password**, which decides which apps get in.

**What the server defends against:**

| Threat | Defense |
|---|---|
| Someone finds your server's address | `/mcp` answers only signed-in apps, password guesses are rate-limited, and the public `/health` endpoint reveals nothing. |
| A phishing link to your sign-in page | Codes only go to allowed destinations. The page names where you'll return, warns about links from others, and needs your consent. Every sign-in is logged. |
| A rogue app registers itself | Only apps returning to allowed addresses can register, and an app's chosen name is shown as plain text, never trusted. |
| A stolen code or token is replayed | Codes and refresh tokens work once. A replay revokes the whole sign-in, and tokens expire. |
| Someone copies the database file | It holds no health data. WHOOP tokens are encrypted, and sign-in codes and tokens are stored only as hashes. |
| Someone listens on the network | Public addresses must use https. |
| Tampered code or images | Every GitHub Action is pinned to a commit, and release images carry signed build provenance (`gh attestation verify`). CI audits dependencies and their licences, and [OpenSSF Scorecard](https://scorecard.dev/viewer/?uri=github.com/yuridivonis/whoop-mcp-server) rates the repository's practices every week. |

**What it can't defend against:**
- **Anyone with the server password,** or control of the machine or hosting account it runs on.
- **The AI app and its provider:** what they do with the answers they receive.
- **WHOOP itself,** and your own devices.

## How the server protects your data

- **No stored Whoop data:** every answer is fetched from Whoop when a tool is called, and nothing of it is kept. The database holds only sign-ins, settings and the encrypted Whoop tokens.
- **Consent:** an app is signed in only after the owner ticks a box on the sign-in page allowing that destination to read their Whoop data.
- **Sign-in:** `/mcp` requires an OAuth 2.1 access token. Clients register themselves and use PKCE, and the owner signs in with `MCP_AUTH_PASSWORD`. In `http` mode the server refuses to start without a password of at least 16 characters, or with a public URL that isn't https.
- **Tokens:** access tokens last an hour. Refresh tokens rotate on every use and expire after 30 days unused. Codes and tokens are stored only as SHA-256 hashes, and are only issued for this server's `/mcp`.
- **Replay protection:** if a code or refresh token is ever used twice, the whole sign-in it belongs to is revoked.
- **Where codes go:** sign-in codes are only sent to Claude, ChatGPT, desktop apps on the owner's own computer (local addresses, and Cursor, VS Code, and Windsurf links), or web clients added with `MCP_ALLOWED_REDIRECT_HOSTS`. The sign-in page names the destination and warns not to sign in from a link someone else sent, and every successful sign-in is logged.
- **Password changes:** every code and token is tied to the password it was issued under, so changing `MCP_AUTH_PASSWORD` signs every client out. A server still running with the old password stops accepting sign-ins and tokens too.
- **Password guessing:** failed sign-ins are limited to 10 per address every 15 minutes, and 50 per hour in total. Client addresses come from proxies you trust (`TRUST_PROXY`: one hop on Railway, none elsewhere), so they can't be forged.
- **Whoop authorization:** each link from `get_auth_url` carries a one-time `state` that expires after 10 minutes.
- **Least data:** the server asks Whoop only for recovery, cycles, sleep, and workouts.
- **Stored Whoop tokens:** encrypted with AES-256-GCM, using a key derived from `ENCRYPTION_SECRET` (or `WHOOP_CLIENT_SECRET` if that isn't set).
- **Public endpoints:** `/health` only reports that the server is up, and says nothing about your data or your Whoop connection.
- **Supply chain:** actions are pinned to commits, release images are attested, and CI checks dependencies for known vulnerabilities and non-permissive licences. The README's OpenSSF Scorecard badge shows the current rating.

## If you run a deployment

- **Stay up to date:** deploy the image rather than a fork. On Railway, turn on auto updates (see [Setup](README.md#2-deploy)); with Docker, run the `:1` tag, which picks up every 1.x release when you pull and restart. If you run a fork, keep it updated with GitHub's **Sync fork** button. Watch this repository's releases (**Watch → Custom → Releases**) to hear about security fixes. Unless `UPDATE_CHECK=false`, `get_today` also mentions a newer version once it's out.
- **Secrets:** use a long random `MCP_AUTH_PASSWORD` and set `ENCRYPTION_SECRET`.
- **Signing everyone out:** change `MCP_AUTH_PASSWORD` and redeploy. Every existing sign-in stops working, so your MCP clients will ask you to sign in again. Do this if you think your password may have leaked.
- **Watching for strangers:** every successful sign-in is logged as `Signed in: client <id>, returning to <destination>, app "<name>"`. Check your server logs for any you don't recognize.
- **If your data was accessed:** you registered your own Whoop developer app, so you are the developer under WHOOP's [API Terms of Use](https://developer.whoop.com/api-terms-of-use/). Under 2. Company Applications, *Application Security*, you must notify WHOOP of a security incident as soon as possible, and within 48 hours of discovering it, at security-notifications@whoop.com. You must also tell the people affected as the law requires. If your Whoop client secret may have leaked, notify WHOOP at the same address (3. Restrictions; Confidentiality, *Confidentiality*) and rotate it in the Whoop developer dashboard.

Published advisories are listed under [Security → Advisories](https://github.com/yuridivonis/whoop-mcp-server/security/advisories).
