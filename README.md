# Whoop MCP Server

[![CI](https://github.com/yuridivonis/whoop-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/yuridivonis/whoop-mcp-server/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A Model Context Protocol (MCP) server that connects your Whoop health data to Claude. You host it yourself and add it to Claude.ai as a custom connector. The server fetches your data from Whoop when Claude asks and keeps no copy, Claude signs in with a password you choose, and it receives only the answers to the tools it calls.

Built on the [Whoop Developer API v2](https://developer.whoop.com/docs/introduction).

> This is an independent open-source project. It uses the WHOOP API to access data from WHOOP products, and is not affiliated with, endorsed by, or sponsored by WHOOP.

## Features

- **Recovery**: daily recovery score, HRV, resting heart rate, SpO2, skin temperature
- **Sleep**: duration, stages, efficiency, performance, respiratory rate
- **Strain**: daily strain score and calories burned
- **Workouts**: activity, local start time, duration, strain, heart rate, calories, and time in heart-rate zones 4–5
- **Live data**: every answer is fetched from Whoop when you ask, so it's always current. The server stores only its sign-ins and your encrypted Whoop tokens, never your health data
- **Private by default**: Claude signs in with a password you choose (OAuth 2.1), so nobody else can read your data

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

### 1. Create a Whoop Developer App

1. In the [Whoop Developer Dashboard](https://developer-dashboard.whoop.com), create an app and fill in:
   - **Contacts**: your email. Only Whoop sees it.
   - **Privacy Policy**: the [PRIVACY.md](PRIVACY.md) in your fork, e.g. `https://github.com/<you>/whoop-mcp-server/blob/main/PRIVACY.md`. People see this link when they approve the app.
   - **Redirect URL**: your server's callback, e.g. `https://your-app.up.railway.app/callback`
   - **Scopes**: `read:recovery`, `read:cycles`, `read:sleep`, and `read:workout`. The server doesn't use the others. The login also asks for `offline`, which lets the server renew its Whoop access without you logging in again; the dashboard doesn't list it.
   - **Webhooks**: leave empty.
2. Note your **Client ID** and **Client Secret**.

### 2. Deploy to Railway

1. Fork this repo to your GitHub account
2. Create a new project on [Railway](https://railway.app) and deploy it from your fork
3. Add environment variables:
   - `WHOOP_CLIENT_ID`: Your Whoop app client ID
   - `WHOOP_CLIENT_SECRET`: Your Whoop app client secret
   - `WHOOP_REDIRECT_URI`: `https://your-app.up.railway.app/callback`
   - `MCP_AUTH_PASSWORD`: the password Claude will ask for when you connect. Generate one with `openssl rand -base64 24` and keep it in your password manager. The server refuses to start without it (at least 16 characters).
   - `ENCRYPTION_SECRET` (optional, recommended): generate one with `openssl rand -base64 32`. It encrypts your stored Whoop tokens, so rotating the Whoop client secret later won't disconnect your account.
4. Add a volume mounted at `/data`. It holds the sign-ins and your encrypted Whoop tokens; without it, every redeploy signs Claude out and disconnects Whoop.
5. Deploy, then open `https://your-app.up.railway.app/health` to check it's running.

### 3. Connect Claude

1. Go to Claude.ai settings → Connectors
2. Click "Add custom connector"
3. Enter:
   - **Name**: Whoop
   - **Remote MCP server URL**: `https://your-app.up.railway.app/mcp`
4. Claude opens your server's sign-in page. Enter your `MCP_AUTH_PASSWORD`, and tick the box allowing Claude to read your Whoop data.

Claude stays signed in across redeploys. Anyone without the password gets `401 Unauthorized` from `/mcp`.

**Other MCP clients**

- **Claude's desktop and mobile apps** use the connectors you add on Claude.ai.
- **Claude Code**: run `claude mcp add --transport http whoop https://your-app.up.railway.app/mcp`, then `/mcp` in Claude Code to sign in.
- **ChatGPT** and desktop apps such as Cursor, VS Code, or Windsurf sign in the same way with your `/mcp` address.
- Other web-based clients need their host name in `MCP_ALLOWED_REDIRECT_HOSTS` first.

### 4. Connect your Whoop account

1. In a chat, ask Claude to connect Whoop. It calls `get_auth_url` and gives you a link.
2. Open the link, log in to Whoop, and authorize the app. You're redirected back, and Claude can answer right away.
3. Ask away: "How did I sleep last night?"

## Upgrading to 1.3.0

1.3.0 stops keeping a copy of your Whoop data, and asks you before each app receives it. To upgrade:

1. Update your fork (GitHub's **Sync fork** button) or pull the new Docker image, then redeploy.
2. On its first start, the server deletes the recovery, sleep, strain and workout data earlier versions stored, and rewrites the database file so none of it is left on disk. Your Whoop connection is kept. The log says `Deleted the WHOOP data stored by an earlier version`.
3. Every app is signed out once. The next time you use one, it opens the sign-in page: enter your password and tick the box allowing it to read your Whoop data.
4. `sync_data` is gone. If your app still lists it, remove the connector and add it again.
5. If your host keeps backups or snapshots of the volume, delete the ones from before the upgrade. They still hold the old copy.

## Upgrading from 1.0.0

1.1.0 puts a sign-in in front of `/mcp`. Version 1.0.0 had no authentication there, so any 1.0.0 server that worked with Claude over HTTP served its data to anyone who knew the URL. (Unmodified 1.0.0 also had a request-parsing bug that stopped Claude from connecting over HTTP at all; 1.1.0 fixes both.) To upgrade:

1. Update your fork (GitHub's **Sync fork** button, or merge the upstream `main` branch).
2. Set `MCP_AUTH_PASSWORD` in your Railway variables (see Setup, step 2). Without it, the new version won't start. That's deliberate.
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

## How this server follows WHOOP's terms

When you deploy this server, you register your own Whoop developer app, so you are the developer (the "Company") under WHOOP's [API Terms of Use](https://developer.whoop.com/api-terms-of-use/), effective 6 October 2026. The terms number their sections but not the paragraphs inside them, so this cites each paragraph by its section and heading. It's a summary, not legal advice: read the terms before you deploy.

| WHOOP's terms | What they require | What this server does |
|---|---|---|
| 4. WHOOP Data, *Prohibitions on WHOOP Data* | Explicit opt-in consent before WHOOP data reaches a third party | Every app you connect is a third party. The sign-in page names where the data goes, and doesn't sign the app in until you tick the box allowing it. |
| 4. WHOOP Data, *Prohibitions on WHOOP Data* | No databases or permanent copies, and no cached copies kept longer than WHOOP's cache headers allow | Nothing is stored. Each answer is fetched from WHOOP when you ask; tools that ask at the same moment share one request, and nothing is kept once it's done. |
| 4. WHOOP Data, *Prohibitions on WHOOP Data* | No using WHOOP data to create, develop, test, train, fine-tune or improve AI | The server trains nothing, and this project's tests and evaluations use synthetic data only. Check your AI app's settings too: some providers improve their models with your conversations unless you opt out. |
| 2. Company Applications, *Application Security* | WHOOP data encrypted in transit and at rest; security incidents reported to WHOOP within 48 hours | The server refuses to run on a public address without https, and the only WHOOP data it stores is your encrypted tokens. Reporting an incident is your job: see below. |
| 1. Use of WHOOP APIs, *Permitted Access* | One set of WHOOP credentials per application | Give each deployment its own Whoop developer app. |
| 3. Restrictions; Confidentiality, *Confidentiality* | Developer credentials kept confidential, and never embedded in open-source projects | The server reads them from environment variables. Never commit them to your fork. |
| 3. Restrictions; Confidentiality, *API Prohibitions* | No medical advice | The tools report WHOOP's numbers. They don't give medical advice. |
| 5. WHOOP Brand, *Use Restrictions* | Nothing that suggests partnership with or endorsement by WHOOP | This project carries no WHOOP logo, and says it isn't affiliated with, endorsed by or sponsored by WHOOP. |

### If you run it for someone else

Each deployment serves one Whoop account. If you deploy it for someone else, they're your end user, and under 2. Company Applications you're responsible for:

- **Consent:** they connect their own Whoop account through Whoop's login, and tick the box for each app themselves (*End User Authorization and Consent*).
- **A privacy policy:** adapt [PRIVACY.md](PRIVACY.md) with your contact details, and link it from your Whoop app (*End User Privacy*).
- **Support:** give them an easy way to reach you (*End User Authorization and Consent*, *Application Support*).
- **Security incidents:** if anyone gets unauthorized access to their data, notify WHOOP within 48 hours of discovering it, at security-notifications@whoop.com, and tell them as the law requires (*Application Security*). See [SECURITY.md](SECURITY.md).
- **Updates:** keep the deployment on a supported version.
- **AI:** never use their data to test or improve any AI system, including your own experiments.

## Docker

Each release is published as an image for amd64 and arm64 on GitHub's container registry. It runs the same server as the Railway setup above:

```bash
docker run -d --name whoop-mcp -p 3000:3000 -v whoop-data:/data \
  -e WHOOP_CLIENT_ID=your_client_id \
  -e WHOOP_CLIENT_SECRET=your_client_secret \
  -e WHOOP_REDIRECT_URI=https://your-server.example.com/callback \
  -e MCP_AUTH_PASSWORD=a-password-of-16-or-more-characters \
  ghcr.io/yuridivonis/whoop-mcp-server:latest
```

- **On a server with a public https address:** set `WHOOP_REDIRECT_URI` to that address's `/callback`, and connect Claude to its `/mcp`, as with Railway.
- **On your own computer:** Whoop's login still needs an https address, so point a tunnel at port 3000 (see below) and use the tunnel's `/callback`. Add `-e PUBLIC_URL=http://localhost:3000`, so MCP clients on the same computer connect to `http://localhost:3000/mcp`.
- **The sign-ins and Whoop tokens** live in the `whoop-data` volume, so restarts and upgrades keep you connected.

To check that an image was built by this repository's release workflow, run `gh attestation verify oci://ghcr.io/yuridivonis/whoop-mcp-server:latest --owner yuridivonis`.

The server is also listed in the official [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.yuridivonis/whoop-mcp-server`.

## Running on Your Own Computer

Requires Node.js 22 or later.

```bash
# Install dependencies
npm install

# Create .env file (npm run dev loads it)
cat > .env << EOF
WHOOP_CLIENT_ID=your_client_id
WHOOP_CLIENT_SECRET=your_client_secret
# Whoop needs an https address: use your tunnel's (see below)
WHOOP_REDIRECT_URI=https://your-tunnel.example.com/callback
MCP_AUTH_PASSWORD=choose-a-local-password
MCP_MODE=http
EOF

# Run in development mode (restarts on changes)
npm run dev

# Run the tests and the type check
npm test
npm run typecheck
```

Whoop's redirect URLs must be `https` (or an app scheme), so a server on your computer needs an https tunnel, for example `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`. Then:

1. Set `WHOOP_REDIRECT_URI` to the tunnel's `/callback` address.
2. Add that address to your Whoop app.
3. Connect your MCP client to the tunnel's `/mcp` address.

Quick tunnels get a new address every time they start, so you'd repeat steps 1 to 3; a named tunnel keeps one address. The tunnel provider carries the traffic, including the tools' answers.

`MCP_MODE=stdio` runs the server for MCP clients that start it as a local command. It has no sign-in, because only the app that started it can reach it. It can't receive the Whoop login either, so connect Whoop once with the server in `http` mode and the same `DB_PATH`, stop it, then start the `stdio` server. Don't run both at once: Whoop replaces the refresh token on every use, so two servers sharing one database log each other out.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `WHOOP_CLIENT_ID` | Whoop OAuth client ID | Required |
| `WHOOP_CLIENT_SECRET` | Whoop OAuth client secret | Required |
| `WHOOP_REDIRECT_URI` | OAuth callback URL | `http://localhost:3000/callback` |
| `MCP_AUTH_PASSWORD` | Password for the sign-in page that protects `/mcp` (16+ characters) | Required in `http` mode |
| `PUBLIC_URL` | Public address of the server, if it differs from `WHOOP_REDIRECT_URI`'s. Claude must connect to `PUBLIC_URL/mcp`. | Origin of `WHOOP_REDIRECT_URI` |
| `ENCRYPTION_SECRET` | Key for encrypting stored Whoop tokens | `WHOOP_CLIENT_SECRET` |
| `MCP_ALLOWED_REDIRECT_HOSTS` | Extra web clients allowed to receive sign-in codes, as host names separated by commas (e.g. `app.example.com`). Claude, ChatGPT, and desktop apps on your own computer (local addresses, and Cursor, VS Code, and Windsurf links) are always allowed. | None |
| `TRUST_PROXY` | Proxies allowed to report the client's IP (used by the sign-in rate limits): a hop count, `false`, or addresses/subnets | `1` on Railway, otherwise `false` |
| `DB_PATH` | SQLite database path (sign-ins and encrypted Whoop tokens) | `./whoop.db` |
| `PORT` | HTTP server port | `3000` |
| `MCP_MODE` | `http` for a server, or `stdio` for an MCP client that starts it as a local command (see [Running on Your Own Computer](#running-on-your-own-computer)) | `http` |

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Claude.ai (custom connector)                   │
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
│  │ Whoop API   │─── tokens ────┘                │
│  │ Client      │   (no health data is stored)   │
│  └─────────────┘                                │
└─────────┬───────────────────────────────────────┘
          │  Whoop OAuth + API v2, live on every call
          ▼
┌─────────────────────────────────────────────────┐
│  Whoop API                                      │
└─────────────────────────────────────────────────┘
```

## Whoop API Endpoints Used

- `GET /v2/cycle` - Physiological cycles (strain data)
- `GET /v2/recovery` - Recovery scores
- `GET /v2/activity/sleep` - Sleep records
- `GET /v2/activity/workout` - Workout records

## Contributing

Issues and pull requests are welcome. Before opening a pull request, run `npm test` and `npm run typecheck`; CI runs both, along with a Docker smoke test.

**Synthetic data only.** The tests run against a fake Whoop API that serves made-up records ([test/fake-whoop.ts](test/fake-whoop.ts)), and evaluations will too. Never put real Whoop data, yours or anyone else's, in tests, fixtures, issues or pull requests: WHOOP's terms forbid using it to test AI systems, and it's personal health data.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT - See [LICENSE](LICENSE) for details.
