# Whoop MCP Server

A Model Context Protocol (MCP) server that connects your Whoop health data to Claude. Designed to be hosted remotely and used as a custom connector in Claude.ai.

Built using the [Whoop Developer API v2](https://developer.whoop.com/docs/introduction).

## Features

- **Recovery**: daily recovery score, HRV, resting heart rate, SpO2, skin temperature
- **Sleep**: duration, stages, efficiency, performance, respiratory rate
- **Strain**: daily strain score and calories burned
- **Auto-sync**: before answering, the server pulls new data from Whoop if the last sync is more than an hour old, and keeps 90 days locally for trends
- **Private by default**: Claude signs in with a password you choose (OAuth 2.1), so nobody else can read your data

## MCP Tools

| Tool | Description |
|------|-------------|
| `get_today` | Morning briefing with recovery, sleep, and strain |
| `get_recovery_trends` | Recovery patterns over time with HRV/RHR |
| `get_sleep_analysis` | Sleep quality trends and stage breakdowns |
| `get_strain_history` | Daily strain and calorie trends |
| `sync_data` | Manually trigger a data sync (`full: true` pulls the last 90 days) |
| `get_auth_url` | Link to connect your Whoop account (works once, expires in 10 minutes) |

## Setup

### 1. Create a Whoop Developer App

1. Go to [developer.whoop.com](https://developer.whoop.com)
2. Create a new application
3. Note your **Client ID** and **Client Secret**
4. Set the redirect URI to your server's callback URL (e.g., `https://your-app.up.railway.app/callback`)

### 2. Deploy to Railway

1. Fork this repo to your GitHub account
2. Create a new project on [Railway](https://railway.app) and deploy it from your fork
3. Add environment variables:
   - `WHOOP_CLIENT_ID`: Your Whoop app client ID
   - `WHOOP_CLIENT_SECRET`: Your Whoop app client secret
   - `WHOOP_REDIRECT_URI`: `https://your-app.up.railway.app/callback`
   - `MCP_AUTH_PASSWORD`: the password Claude will ask for when you connect. Generate one with `openssl rand -base64 24` and keep it in your password manager. The server refuses to start without it (at least 16 characters).
   - `ENCRYPTION_SECRET` (optional, recommended): generate one with `openssl rand -base64 32`. It encrypts your stored Whoop tokens, so rotating the Whoop client secret later won't disconnect your account.
4. Add a volume mounted at `/data`. The database lives there; without a volume, every redeploy loses your data and signs Claude out.
5. Deploy, then open `https://your-app.up.railway.app/health` to check it's running.

### 3. Connect Claude

1. Go to Claude.ai settings → Connectors
2. Click "Add custom connector"
3. Enter:
   - **Name**: Whoop
   - **Remote MCP server URL**: `https://your-app.up.railway.app/mcp`
4. Claude opens your server's sign-in page. Enter your `MCP_AUTH_PASSWORD`.

Claude stays signed in across redeploys. Anyone without the password gets `401 Unauthorized` from `/mcp`.

### 4. Connect your Whoop account

1. In a chat, ask Claude to connect Whoop. It calls `get_auth_url` and gives you a link.
2. Open the link, log in to Whoop, and authorize the app. You're redirected back, and the first 90-day sync starts.
3. Ask away: "How did I sleep last night?"

## Upgrading from 1.0.0

1.1.0 puts a sign-in in front of `/mcp`. Version 1.0.0 had no authentication there, so any 1.0.0 server that worked with Claude over HTTP served its data to anyone who knew the URL. (Unmodified 1.0.0 also had a request-parsing bug that stopped Claude from connecting over HTTP at all; 1.1.0 fixes both.) To upgrade:

1. Update your fork (GitHub's **Sync fork** button, or merge the upstream `main` branch).
2. Set `MCP_AUTH_PASSWORD` in your Railway variables (see Setup, step 2). Without it, the new version won't start. That's deliberate.
3. Redeploy.
4. In Claude.ai → Settings → Connectors, remove the Whoop connector and add it again with the same URL. Claude shows the sign-in page once.
5. If a tool says your Whoop authorization expired, run `get_auth_url` once to reconnect.
6. Ask Claude to run `sync_data` with `full: true` once. 1.0.0 never stored workouts (the sync failed at that step whenever a scored workout was in range); this backfills the last 90 days.

If your 1.0.0 server worked with Claude on a public URL, assume your data could have been read. As a precaution, rotate your client secret in the Whoop developer dashboard, update `WHOOP_CLIENT_SECRET`, and run `get_auth_url` once afterwards. Unless `ENCRYPTION_SECRET` is set, the stored Whoop tokens were encrypted with the old client secret. The server starts anyway and treats Whoop as disconnected until you reconnect.

## Security

- `/mcp` only answers signed-in clients. Sign-in codes and refresh tokens work once and are stored as hashes; if one is ever used twice, the whole sign-in is revoked.
- Failed sign-ins are limited to 10 per address every 15 minutes, and 50 per hour in total.
- Whoop tokens are encrypted at rest (AES-256-GCM). Your health data stays in your server's database and is only sent to the client you signed in.

## Local Development

```bash
# Install dependencies
npm install

# Create .env file (npm run dev loads it)
cat > .env << EOF
WHOOP_CLIENT_ID=your_client_id
WHOOP_CLIENT_SECRET=your_client_secret
WHOOP_REDIRECT_URI=http://localhost:3000/callback
MCP_AUTH_PASSWORD=choose-a-local-password
MCP_MODE=http
EOF

# Run in development mode (restarts on changes)
npm run dev

# Run the tests and the type check
npm test
npm run typecheck
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `WHOOP_CLIENT_ID` | Whoop OAuth client ID | Required |
| `WHOOP_CLIENT_SECRET` | Whoop OAuth client secret | Required |
| `WHOOP_REDIRECT_URI` | OAuth callback URL | `http://localhost:3000/callback` |
| `MCP_AUTH_PASSWORD` | Password for the sign-in page that protects `/mcp` (16+ characters) | Required in `http` mode |
| `PUBLIC_URL` | Public address of the server, if it differs from `WHOOP_REDIRECT_URI`'s. Claude must connect to `PUBLIC_URL/mcp`. | Origin of `WHOOP_REDIRECT_URI` |
| `ENCRYPTION_SECRET` | Key for encrypting stored Whoop tokens | `WHOOP_CLIENT_SECRET` |
| `TRUST_PROXY` | Proxies allowed to report the client's IP (used by the sign-in rate limits): a hop count, `false`, or addresses/subnets | `1` on Railway, otherwise `false` |
| `DB_PATH` | SQLite database path | `./whoop.db` |
| `PORT` | HTTP server port | `3000` |
| `MCP_MODE` | `http` for a remote server, or `stdio` for a local MCP client over stdin/stdout. `stdio` has no callback endpoint, so connect your Whoop account in `http` mode first. | `http` |

## Architecture

```
┌─────────────────────────────────────────────────┐
│              Whoop MCP Server                   │
│                                                 │
│  ┌─────────────┐      ┌──────────────────┐    │
│  │ MCP Server  │◄────►│  SQLite Database │    │
│  │ (HTTP)      │      │  - cycles        │    │
│  └─────────────┘      │  - recovery      │    │
│         │             │  - sleep         │    │
│         │             │  - workouts      │    │
│         ▼             │  - tokens        │    │
│  ┌─────────────┐      └──────────────────┘    │
│  │ Whoop API   │                               │
│  │ Client      │                               │
│  └─────────────┘                               │
└─────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────┐
│  Claude.ai (Custom Connector)                   │
│  "Hey, what's my recovery today?"               │
└─────────────────────────────────────────────────┘
```

## Whoop API Endpoints Used

- `GET /v2/cycle` - Physiological cycles (strain data)
- `GET /v2/recovery` - Recovery scores
- `GET /v2/activity/sleep` - Sleep records
- `GET /v2/activity/workout` - Workout records

## License

MIT - See [LICENSE](LICENSE) for details.
