<img src="docs/icon.png" alt="" width="96" height="96" align="left">

# Whoop MCP Server

[![CI](https://github.com/yuridivonis/whoop-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/yuridivonis/whoop-mcp-server/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/yuridivonis/whoop-mcp-server/badge)](https://scorecard.dev/viewer/?uri=github.com/yuridivonis/whoop-mcp-server)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/14971/badge)](https://www.bestpractices.dev/projects/14971)
[![Latest release](https://img.shields.io/github/v/release/yuridivonis/whoop-mcp-server)](https://github.com/yuridivonis/whoop-mcp-server/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Your WHOOP data in whichever AI you use, or, soon, in your own code.** Self-hosted, private, and open source.

Ask Claude, ChatGPT or another MCP app "How did I sleep this week?" and get the answer from your own recovery, sleep, strain and workouts. You run the server yourself: it fetches your data from WHOOP when you ask and keeps no copy, and only the apps you've allowed can reach it.

> This is an independent open-source project. It uses the WHOOP API to access data from WHOOP products, and is not affiliated with, endorsed by, or sponsored by WHOOP.

## Two ways in

- **Talk to your data.** Deploy the server, connect it to your AI, and ask. Start with [Setup](#setup), then [Add to your AI](docs/add-to-your-ai.md), which also lists the apps [tested so far](docs/add-to-your-ai.md#compatibility).
- **Build with it.** The WHOOP client inside this server (typed, tested, and careful with WHOOP's single-use refresh tokens) is being split out as a library for your own code. It isn't published yet: watch this repository's releases to hear when it is.

Built on the [Whoop Developer API v2](https://developer.whoop.com/docs/introduction), and the [Model Context Protocol](https://modelcontextprotocol.io) (MCP), the open standard AI apps use to call tools like these.

## Features

- **Recovery**: daily recovery score, HRV, resting heart rate, SpO2, skin temperature
- **Sleep**: duration, stages, efficiency, performance, respiratory rate
- **Strain**: daily strain score and calories burned
- **Workouts**: activity, local start time, duration, strain, heart rate, calories, and time in heart-rate zones 4–5
- **Live data**: every answer is fetched from Whoop when you ask, so it's always current. The server stores only its sign-ins and your encrypted Whoop tokens, never your health data
- **Private by default**: each app signs in with a password you choose (OAuth 2.1), and only after you tick a box allowing it, so nobody else can read your data
- **Your choice of AI**: tested live with Claude and ChatGPT; other apps that sign in with OAuth should work the same way (see [compatibility](docs/add-to-your-ai.md#compatibility))

## MCP Tools

| Tool | Description |
|------|-------------|
| `get_today` | Morning briefing with recovery, sleep, and strain |
| `get_recovery_trends` | Recovery patterns over time with HRV/RHR |
| `get_sleep_analysis` | Sleep trends: time asleep, performance, and efficiency |
| `get_strain_history` | Daily strain and calorie trends |
| `get_workouts` | Recent workouts with activity, duration, strain, heart rate, and calories |
| `get_auth_url` | Link to connect your Whoop account (works once, expires in 10 minutes) |

## Setup

### Fastest: Deploy on Railway

The template is published by this project's maintainer. Railway pays template creators a share of what deployments spend, and the link carries a referral code; neither costs you anything extra. Railway's Hobby plan is enough.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/rt-2HZ?referralCode=U4Y3-R&utm_medium=integration&utm_source=button&utm_campaign=whoop-mcp-server)

One click creates a Railway project running the `:1` image with a volume, auto updates and generated secrets; there's nothing to fill in. Tested live on 2026-09-29. Then:

1. Click the service card. Its address is at the top of the **Deployments** tab, `whoop-mcp-server-production-xxxx.up.railway.app`. Open it.
2. The page walks you through the rest: create a Whoop developer app (it shows every field), paste the app's two keys over the placeholders in the service's variables, add the address it shows to Claude or ChatGPT, and approve Whoop once on your first question.

To set it up by hand instead, or elsewhere, read on.

### 1. Deploy

Every release is published as a ready-made image, `ghcr.io/yuridivonis/whoop-mcp-server`. Deploy that: there's no need to fork this repository unless you want to change the code (see [Changing the code](#changing-the-code)). The steps below use [Railway](https://railway.com); to run it anywhere else, see [Docker](#docker).

1. In a Railway project, click **New**, choose **Docker Image**, and enter `ghcr.io/yuridivonis/whoop-mcp-server:1`. Then, in the service's **Settings → Networking → Public Networking**, choose **Generate Domain**: that's your server's address, `your-app.up.railway.app` below. The server works out its Whoop callback address from it.
2. Add environment variables:
   - `MCP_AUTH_PASSWORD`: the password each AI app asks for when you connect it. Generate one with `openssl rand -base64 24` and keep it in your password manager. The server refuses to start without it (at least 16 characters).
   - `ENCRYPTION_SECRET` (optional, recommended): generate one with `openssl rand -base64 32`. It encrypts your stored Whoop tokens, so rotating the Whoop client secret later won't disconnect your account.
   - `WHOOP_CLIENT_ID` = `replace-with-your-client-id` and `WHOOP_CLIENT_SECRET` = `replace-with-your-client-secret` for now. The server treats those as unset; you replace them in [Create a Whoop Developer App](#2-create-a-whoop-developer-app).
3. Add a volume mounted at `/data`. It holds the sign-ins and your encrypted Whoop tokens; without it, every redeploy signs your apps out and disconnects Whoop.
4. Turn on updates: in the service's **Settings**, under **Source**, choose **Configure Auto Updates** and a maintenance window (for example **Night**). The `:1` tag moves with every 1.x release, and Railway then redeploys the service; on the Pro plan it backs up the volume first.
5. Deploy, then open `https://your-app.up.railway.app/`: the set-up page walks you through the rest. If the deploy fails, open its logs: the server says what's missing.

**Already running a fork on Railway?** Switch it to the image: open the service's **Settings**, change **Service Source** to `ghcr.io/yuridivonis/whoop-mcp-server:1`, and turn on auto updates as in step 4. Keep the same variables and volume, so Whoop stays connected. If your fork is older than 1.3.0, read [Upgrading to 1.3.0](#upgrading-to-130) first: every app signs in once more. Your fork is then no longer used.

### 2. Create a Whoop Developer App

Your server's set-up page, `https://your-app.up.railway.app/`, walks through Whoop's New App form in the form's own order, with a Copy button on each value to paste. The same, in short:

1. In the [Whoop Developer Dashboard](https://developer-dashboard.whoop.com), open **New App** and fill the form top to bottom:
   - **Name**: anything. You see it when you approve the app.
   - **Logo**: skip it.
   - **Contacts**: your email. Only Whoop sees it.
   - **Privacy Policy**: this project's [PRIVACY.md](PRIVACY.md), `https://github.com/yuridivonis/whoop-mcp-server/blob/main/PRIVACY.md`, or your own adapted copy if you run the server for someone else. People see this link when they approve the app.
   - **Redirect URLs**: your server's callback, `https://your-app.up.railway.app/callback`, exactly as the set-up page shows it.
   - **Scopes**: `read:recovery`, `read:cycles`, `read:sleep` and `read:workout`. The server doesn't use the others. The login also asks for `offline`, which lets the server renew its Whoop access without you logging in again; the dashboard doesn't list it.
   - **Webhooks**: skip it.

   Click **Create App**: Whoop shows the app's **Client ID** and **Client Secret**.
2. In the service's **Variables** tab, select `replace-with-your-client-id` in `WHOOP_CLIENT_ID` and paste the Client ID over it; the same for `replace-with-your-client-secret` in `WHOOP_CLIENT_SECRET`; then click **Deploy** at the top. The set-up page then ticks steps 2 and 3.

If you add a custom domain later, open the set-up page again: if the Redirect URL it shows changed, update it in your Whoop app, or set `WHOOP_REDIRECT_URI`.

### 3. Connect your AI

Add your server's address, `https://your-app.up.railway.app/mcp`, to your AI app as a custom connector. It opens your server's sign-in page: check it names the app you're connecting, enter your `MCP_AUTH_PASSWORD`, and tick the box allowing it to read your Whoop data. For example, in Claude.ai: **Customize → Connectors → + → Add custom connector**.

[Add to your AI](docs/add-to-your-ai.md) has the steps for Claude, ChatGPT, Claude Code, Cursor, VS Code and Windsurf, and which have been tested. Apps stay signed in across redeploys; anyone without the password gets `401 Unauthorized` from `/mcp`.

### 4. Connect your Whoop account

1. In a chat, ask your AI about your recovery. The first answer is a Whoop link (it calls `get_auth_url`).
2. Open the link, log in to Whoop, and approve the app, once. You're redirected back, and your AI answers from then on.
3. Ask away: "How did I sleep last night?"

## Upgrading to 1.3.0

1.3.0 stops keeping a copy of your Whoop data, and asks you before each app receives it. To upgrade:

1. Get the new version: with the image, Railway's auto updates do it for you, or switch the **Service Source** to the `:1` tag and redeploy (Docker with `:1`: pull it again and restart). With a fork, use GitHub's **Sync fork** button, then redeploy, or switch to the image as described in [Deploy](#1-deploy).
2. On its first start, the server deletes the recovery, sleep, strain and workout data earlier versions stored, and rewrites the database file so none of it is left on disk. Your Whoop connection is kept. The log says `Deleted the WHOOP data stored by an earlier version`.
3. Every app is signed out once. The next time you use one, it opens the sign-in page: enter your password and tick the box allowing it to read your Whoop data.
4. `sync_data` is gone. If your app still lists it, remove the connector and add it again.
5. If your host keeps backups or snapshots of the volume, delete the ones from before the upgrade. They still hold the old copy.

There's no going back to 1.2.x on the upgraded database: it can't sign apps in with the new sign-in tables.

## Upgrading from 1.0.0

1.1.0 puts a sign-in in front of `/mcp`. Version 1.0.0 had no authentication there, so any 1.0.0 server that worked with Claude over HTTP served its data to anyone who knew the URL. (Unmodified 1.0.0 also had a request-parsing bug that stopped Claude from connecting over HTTP at all; 1.1.0 fixes both.) To upgrade:

1. Update your fork (GitHub's **Sync fork** button, or merge the upstream `main` branch), or switch the service to the image as described in [Deploy](#1-deploy).
2. Set `MCP_AUTH_PASSWORD` in your Railway variables (see Setup, step 1). Without it, the new version won't start. That's deliberate.
3. Redeploy.
4. In Claude.ai → Settings → Connectors, remove the Whoop connector and add it again with the same URL. Claude shows the sign-in page once.
5. If a tool says your Whoop authorization expired, run `get_auth_url` once to reconnect.
6. Optional: in your Whoop app, untick `read:profile` and `read:body_measurement`. 1.1.0 no longer uses them.

If your 1.0.0 server worked with Claude on a public URL, assume your data could have been read. As a precaution, rotate your client secret in the Whoop developer dashboard, update `WHOOP_CLIENT_SECRET`, and run `get_auth_url` once afterwards. Unless `ENCRYPTION_SECRET` is set, the stored Whoop tokens were encrypted with the old client secret. The server starts anyway and treats Whoop as disconnected until you reconnect.

## Security

- `/mcp` only answers signed-in clients. Sign-in codes and refresh tokens work once and are stored as hashes; if one is ever used twice, the whole sign-in is revoked.
- Failed sign-ins are limited to 10 per address every 15 minutes, and 50 per hour in total.
- Sign-in codes only go to Claude, ChatGPT, desktop apps on your own computer, or web clients you add with `MCP_ALLOWED_REDIRECT_HOSTS`. The sign-in page shows where you'll return: only sign in if you started the connection yourself.
- Each app is signed in only after you tick a box allowing it to read your Whoop data.
- Whoop tokens are encrypted at rest (AES-256-GCM). Your health data isn't stored: the server fetches it from Whoop for each question and sends it only to the client you signed in.
- Changing `MCP_AUTH_PASSWORD` signs every client out.
- The server asks Whoop only for recovery, cycles, sleep, and workouts.

See [SECURITY.md](SECURITY.md) for the full security model and how to report a vulnerability privately, and [PRIVACY.md](PRIVACY.md) for what a deployment stores and shares.

## WHOOP's terms: what the server does, and what's up to you

When you deploy this server, you register your own Whoop developer app, so you are the developer (the "Company") under WHOOP's [API Terms of Use](https://developer.whoop.com/api-terms-of-use/), effective 6 October 2026. The terms number their sections but not the paragraphs inside them, so this cites each paragraph by its section and heading. It's a summary of the obligations that touch how the server handles data, not legal advice, and not a promise that any deployment complies: read the terms before you deploy.

| WHOOP's terms | What they require | What the server does, and what's up to you |
|---|---|---|
| 4. WHOOP Data, *Prohibitions on WHOOP Data* | Explicit opt-in consent before WHOOP data reaches a third party | Every app you connect is a third party. The sign-in page names where the data goes, and doesn't sign the app in until you tick the box allowing it. |
| 4. WHOOP Data, *Prohibitions on WHOOP Data* | No databases or permanent copies, and no cached copies kept longer than WHOOP's cache headers allow | Nothing is stored. Each answer is fetched from WHOOP when you ask; tools that ask at the same moment share one request, and nothing is kept once it's done. |
| 4. WHOOP Data, *Prohibitions on WHOOP Data* | No using WHOOP data to create, develop, test, train, fine-tune or improve AI | The server trains nothing, and this project's tests use synthetic data only. Before you connect an app, turn off any setting that lets its provider use your conversations to improve its models. |
| 2. Company Applications, *Application Security* | WHOOP data encrypted in transit and at rest; security incidents reported to WHOOP within 48 hours | The server refuses to run on a public address without https, and the only WHOOP data it stores is your encrypted tokens. Reporting an incident is your job: see below. |
| 1. Use of WHOOP APIs, *Permitted Access* | One set of WHOOP credentials per application | Give each deployment its own Whoop developer app. |
| 3. Restrictions; Confidentiality, *Confidentiality* | Developer credentials kept confidential, and never embedded in open-source projects | The server reads them from environment variables. Never commit them to a repository, including a fork. |
| 3. Restrictions; Confidentiality, *API Prohibitions* | No medical, legal or other professional advice, and no medical devices | The tools report WHOOP's numbers. They don't give advice or diagnose anything, and neither should anything you build on them. |

### If you run it for someone else

Each deployment serves one Whoop account. If you deploy it for someone else, they're your end user, and under 2. Company Applications you're responsible for:

- **Consent:** they connect their own Whoop account through Whoop's login, and tick the box for each app themselves, so they need the server password (`MCP_AUTH_PASSWORD`). Don't tick it for them (*End User Authorization and Consent*).
- **A privacy policy:** adapt [PRIVACY.md](PRIVACY.md) with your contact details, and link it from your Whoop app (*End User Privacy*).
- **Support:** give them an easy way to reach you (*End User Authorization and Consent*, *Application Support*).
- **Security incidents:** if anyone gets unauthorized access to their data, notify WHOOP within 48 hours of discovering it, at security-notifications@whoop.com, and tell them as the law requires (*Application Security*). See [SECURITY.md](SECURITY.md).
- **Updates:** keep the deployment on a supported version.
- **AI:** never use their data to test or improve any AI system, including your own experiments.

## Docker

Each release is published as an image for amd64 and arm64 on GitHub's container registry. It runs the same server as the Railway setup above:

```bash
docker run -d --name whoop-mcp -p 3000:3000 -v whoop-data:/data \
  -e WHOOP_CLIENT_ID=replace-with-your-client-id \
  -e WHOOP_CLIENT_SECRET=replace-with-your-client-secret \
  -e WHOOP_REDIRECT_URI=https://your-server.example.com/callback \
  -e MCP_AUTH_PASSWORD=replace-with-a-password-of-16-or-more-characters \
  ghcr.io/yuridivonis/whoop-mcp-server:1
```

- **On a server with a public https address:** set `WHOOP_REDIRECT_URI` to that address's `/callback`, and connect your AI app to its `/mcp`, as with Railway. The set-up page at the server's root shows what's left to do.
- **On your own computer:** Whoop's login still needs an https address, so point a tunnel at port 3000 (see below) and use the tunnel's `/callback`. Add `-e PUBLIC_URL=http://localhost:3000`, so MCP clients on the same computer connect to `http://localhost:3000/mcp`.
- **The sign-ins and Whoop tokens** live in the `whoop-data` volume, so restarts and upgrades keep you connected.
- **Tags:** `:1` always points to the newest 1.x release, so pulling it again (or redeploying) picks up fixes and new features without breaking changes. `:1.3.0` and the like pin one exact version; `:latest` follows every release, including a future 2.0.

To check that an image was built by this repository's release workflow, run `gh attestation verify oci://ghcr.io/yuridivonis/whoop-mcp-server:1 --owner yuridivonis`.

The server is also listed in the official [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.yuridivonis/whoop-mcp-server`.

## Running on Your Own Computer

Requires Node.js 22 or later.

```bash
# Install dependencies
npm install

# Create .env file (npm run dev loads it)
cat > .env << EOF
WHOOP_CLIENT_ID=replace-with-your-client-id
WHOOP_CLIENT_SECRET=replace-with-your-client-secret
# Whoop needs an https address: use your tunnel's (see below)
WHOOP_REDIRECT_URI=https://your-tunnel.example.com/callback
MCP_AUTH_PASSWORD=replace-with-a-password-of-16-or-more-characters
MCP_MODE=http
EOF

# Run in development mode (restarts on changes)
npm run dev

# Run the tests and the type check
npm test
npm run typecheck
```

The repository is an npm workspace: the server in `src/`, and the WHOOP API client it's built on in `packages/whoop-client`, a library you can also use on its own. `npm install` links the two, and `npm test`, `npm run typecheck`, `npm run build` and `npm run dev` build the library first. When you're changing the library itself, `npx tsc -b -w packages/whoop-client` rebuilds it as you go.

Whoop's redirect URLs must be `https` (or an app scheme), so a server on your computer needs an https tunnel, for example `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`. Then:

1. Set `WHOOP_REDIRECT_URI` to the tunnel's `/callback` address.
2. Add that address to your Whoop app.
3. Connect your MCP client to the tunnel's `/mcp` address.

Quick tunnels get a new address every time they start, so you'd repeat steps 1 to 3; a named tunnel keeps one address. The tunnel provider carries the traffic, including the tools' answers.

`MCP_MODE=stdio` runs the server for MCP clients that start it as a local command. It has no sign-in, because only the app that started it can reach it. It can't receive the Whoop login either, so connect Whoop once with the server in `http` mode and the same `DB_PATH`, stop it, then start the `stdio` server. Don't run both at once: Whoop replaces the refresh token on every use, so two servers sharing one database log each other out.

## Changing the code

To run your own changes, fork this repository and deploy the fork instead of the image: on Railway, **New → GitHub Repo**, which builds the Dockerfile. A fork doesn't update itself: to pick up new releases, use GitHub's **Sync fork** button and redeploy, and merge your changes as you go. If you don't need changes, the image is simpler and keeps itself up to date.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `WHOOP_CLIENT_ID` | Whoop OAuth client ID | Needed to connect Whoop. Until both are set, the set-up page at `/` shows the steps; a value containing `replace-with` counts as unset |
| `WHOOP_CLIENT_SECRET` | Whoop OAuth client secret | As above |
| `WHOOP_REDIRECT_URI` | OAuth callback URL | `PUBLIC_URL` + `/callback`; on Railway `https://<the service's domain>/callback`; else `http://localhost:3000/callback` |
| `MCP_AUTH_PASSWORD` | Password for the sign-in page that protects `/mcp` (16+ characters) | Required in `http` mode |
| `PUBLIC_URL` | Public address of the server, if it differs from `WHOOP_REDIRECT_URI`'s. AI apps must connect to `PUBLIC_URL/mcp`. | Origin of `WHOOP_REDIRECT_URI` |
| `ENCRYPTION_SECRET` | Key for encrypting stored Whoop tokens | `WHOOP_CLIENT_SECRET` |
| `MCP_ALLOWED_REDIRECT_HOSTS` | Extra web clients allowed to receive sign-in codes, as host names separated by commas (e.g. `app.example.com`). Claude, ChatGPT, and desktop apps on your own computer (local addresses, and Cursor, VS Code, and Windsurf links) are always allowed. | None |
| `TRUST_PROXY` | Proxies allowed to report the client's IP (used by the sign-in rate limits): a hop count, `false`, or addresses/subnets | `1` on Railway, otherwise `false` |
| `DB_PATH` | SQLite database path (sign-ins and encrypted Whoop tokens) | `./whoop.db` |
| `PORT` | HTTP server port | `3000` |
| `MCP_MODE` | `http` for a server, or `stdio` for an MCP client that starts it as a local command (see [Running on Your Own Computer](#running-on-your-own-computer)) | `http` |
| `UPDATE_CHECK` | Once a day, ask GitHub for the latest release number, and end `get_today`'s answer with a one-line notice when a newer version is out. The request carries nothing about you or your data. `false` turns it off. | `true` |

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Your AI app (Claude, ChatGPT, ...)             │
│  "How did I sleep last night?"                  │
└────────────────────────┬────────────────────────┘
                         │  signs in once (OAuth 2.1),
                         │  then calls tools on /mcp
                         ▼
┌─────────────────────────────────────────────────┐
│                Whoop MCP Server                 │
│                                                 │
│  ┌─────────────┐      ┌──────────────────┐      │
│  │ Sign-in     │─────►│  SQLite Database │      │
│  │ (OAuth 2.1) │      │  - sign-ins      │      │
│  └─────────────┘      │  - Whoop tokens  │      │
│  ┌─────────────┐      │    (encrypted)   │      │
│  │ MCP tools   │      └──────────────────┘      │
│  └──────┬──────┘               ▲                │
│         ▼                      │                │
│  ┌─────────────┐               │                │
│  │ whoop-client│─── tokens ────┘                │
│  │ (library)   │   (no health data is stored)   │
│  └─────────────┘                                │
└─────────┬───────────────────────────────────────┘
          │  Whoop OAuth + API v2, live on every call
          ▼
┌─────────────────────────────────────────────────┐
│  Whoop API                                      │
└─────────────────────────────────────────────────┘
```

The server talks to WHOOP through `whoop-client`, in [packages/whoop-client](packages/whoop-client): the same small, typed library anyone can use to build on WHOOP data, with the sign-in and token refresh handled. It isn't published to npm yet.

## Whoop API Endpoints Used

- `GET /v2/cycle` - Physiological cycles (strain data)
- `GET /v2/recovery` - Recovery scores
- `GET /v2/activity/sleep` - Sleep records
- `GET /v2/activity/workout` - Workout records

## Contributing

Issues and pull requests are welcome. Every change goes through a pull request, and can merge only once CI passes and the maintainer has reviewed it.

- **Tests come with changes.** A new feature or bug fix adds tests for it to the automated suite: the server's in `test/`, the WHOOP client's in `packages/whoop-client/test/`. Before opening a pull request, run `npm test` and `npm run typecheck`. Every pull request runs both in CI, along with a Docker smoke test, and a CodeQL scan.
- **Code style:** TypeScript in strict mode, as in `src/`, `packages/whoop-client/src/` and the tests, written like the code around it. No new dependency without a reason in the pull request.
- **The server uses the WHOOP client by its package name,** `@yuridivonis/whoop-client`, never by a path into `packages/whoop-client/src`: a second copy of the library would break `instanceof` checks on its errors. The one exception is the tests' fake WHOOP, imported from `packages/whoop-client/test/`.
- **Security issues:** report them privately, as [SECURITY.md](SECURITY.md) describes, not in an issue.

**Synthetic data only.** The tests run against a fake Whoop API that serves made-up records ([packages/whoop-client/test/fake-whoop.ts](packages/whoop-client/test/fake-whoop.ts)), and future evaluations will too. Never put real Whoop data, yours or anyone else's, in tests, fixtures, issues or pull requests: WHOOP's terms forbid using it to test AI systems, and it's personal health data.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT - See [LICENSE](LICENSE) for details.
