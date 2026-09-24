# Whoop MCP Server

A Model Context Protocol (MCP) server that connects your Whoop health data to Claude. Designed to be hosted remotely and used as a custom connector in Claude.ai.

Built using the [Whoop Developer API v2](https://developer.whoop.com/docs/introduction).

## Features

- **Recovery Data**: Daily recovery scores, HRV, resting heart rate, SpO2, skin temperature
- **Sleep Analysis**: Sleep duration, stages, efficiency, performance, respiratory rate
- **Strain Tracking**: Daily strain scores, calories burned, heart rate zones
- **Workout History**: All logged workouts with detailed metrics
- **Auto-Sync**: Automatically keeps data fresh with smart sync logic
- **90-Day History**: Maintains local cache of your health data for trend analysis

## MCP Tools

| Tool | Description |
|------|-------------|
| `get_today` | Morning briefing with recovery, sleep, and strain |
| `get_recovery_trends` | Recovery patterns over time with HRV/RHR |
| `get_sleep_analysis` | Sleep quality trends and stage breakdowns |
| `get_strain_history` | Training load and calorie trends |
| `sync_data` | Manually trigger a data sync |
| `get_auth_url` | Get authorization URL for Whoop connection |

## Setup

### 1. Create a Whoop Developer App

1. Go to [developer.whoop.com](https://developer.whoop.com)
2. Create a new application
3. Note your **Client ID** and **Client Secret**
4. Set the redirect URI to your deployed server's callback URL (e.g., `https://your-app.railway.app/callback`)

### 2. Deploy to Railway

1. Fork/push this repo to GitHub
2. Create a new project on [Railway](https://railway.app)
3. Connect your GitHub repo
4. Add environment variables:
   - `WHOOP_CLIENT_ID`: Your Whoop app client ID
   - `WHOOP_CLIENT_SECRET`: Your Whoop app client secret
   - `WHOOP_REDIRECT_URI`: `https://your-app.railway.app/callback`
   - `MCP_AUTH_PASSWORD`: the password Claude will ask for when you connect. Generate one with `openssl rand -base64 24` and keep it in your password manager. The server refuses to start without it (at least 16 characters).
5. Add a volume mounted at `/data` for persistent SQLite storage
6. Deploy!

### 3. Authorize with Whoop

1. Visit `https://your-app.railway.app/health` to verify it's running
2. The first time you use the `get_auth_url` tool in Claude, it will provide an authorization link
3. Visit the link, log in to Whoop, and authorize the app
4. You'll be redirected back and the initial 90-day sync will begin

### 4. Connect to Claude

1. Go to Claude.ai settings → Connectors
2. Click "Add custom connector"
3. Enter:
   - **Name**: Whoop
   - **Remote MCP server URL**: `https://your-app.railway.app/mcp`
4. Claude opens your server's sign-in page. Enter your `MCP_AUTH_PASSWORD`.
5. Use it in any chat!

Claude stays signed in across redeploys. Anyone without the password gets `401 Unauthorized` from `/mcp`.

## Upgrading from 1.0.0

1.1.0 puts a sign-in in front of `/mcp`. Version 1.0.0 had no authentication there, so any 1.0.0 server that worked with Claude over HTTP served its data to anyone who knew the URL. (Unmodified 1.0.0 also had a request-parsing bug that stopped Claude from connecting over HTTP at all; 1.1.0 fixes both.) To upgrade:

1. Update your fork (GitHub's **Sync fork** button, or merge the upstream `main` branch).
2. Set `MCP_AUTH_PASSWORD` in your Railway variables (see Setup, step 2). Without it, the new version won't start. That's deliberate.
3. Redeploy.
4. In Claude.ai → Settings → Connectors, remove the Whoop connector and add it again with the same URL. Claude shows the sign-in page once.
5. If a tool says your Whoop authorization expired, run `get_auth_url` once to reconnect.

If your 1.0.0 server worked with Claude on a public URL, assume your data could have been read. As a precaution, rotate your client secret in the WHOOP developer dashboard, update `WHOOP_CLIENT_SECRET`, and run `get_auth_url` once afterwards. Unless `ENCRYPTION_SECRET` is set, the stored WHOOP tokens were encrypted with the old client secret. The server starts anyway and treats WHOOP as disconnected until you reconnect.

## Local Development

```bash
# Install dependencies
npm install

# Create .env file
cat > .env << EOF
WHOOP_CLIENT_ID=your_client_id
WHOOP_CLIENT_SECRET=your_client_secret
WHOOP_REDIRECT_URI=http://localhost:3000/callback
MCP_AUTH_PASSWORD=choose-a-local-password
MCP_MODE=http
EOF

# Run in development mode
npm run dev

# Run the tests
npm test
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `WHOOP_CLIENT_ID` | Whoop OAuth client ID | Required |
| `WHOOP_CLIENT_SECRET` | Whoop OAuth client secret | Required |
| `WHOOP_REDIRECT_URI` | OAuth callback URL | `http://localhost:3000/callback` |
| `MCP_AUTH_PASSWORD` | Password for the sign-in page that protects `/mcp` (16+ characters) | Required in `http` mode |
| `PUBLIC_URL` | Public address of the server, if it differs from `WHOOP_REDIRECT_URI`'s. Claude must connect to `PUBLIC_URL/mcp`. | Origin of `WHOOP_REDIRECT_URI` |
| `ENCRYPTION_SECRET` | Key for encrypting stored WHOOP tokens | `WHOOP_CLIENT_SECRET` |
| `TRUST_PROXY` | Proxies allowed to report the client's IP (used by the sign-in rate limits): a hop count, `false`, or addresses/subnets | `1` on Railway, otherwise `false` |
| `DB_PATH` | SQLite database path | `./whoop.db` |
| `PORT` | HTTP server port | `3000` |
| `MCP_MODE` | `http` for remote, `stdio` for local | `http` |

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

## API Endpoints Used

This server uses the following Whoop API v2 endpoints:

- `GET /v2/user/profile/basic` - User profile
- `GET /v2/user/measurement/body` - Body measurements
- `GET /v2/cycle` - Physiological cycles (strain data)
- `GET /v2/recovery` - Recovery scores
- `GET /v2/activity/sleep` - Sleep records
- `GET /v2/activity/workout` - Workout records

## License

MIT - See [LICENSE](LICENSE) for details.
