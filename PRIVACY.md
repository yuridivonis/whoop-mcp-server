# Privacy

This notice describes how a Whoop MCP Server deployment handles your data. Each deployment is run by whoever deployed it (the operator), usually for their own Whoop account. If you run one for other people, adapt this notice and add your contact details. You can link it as your Whoop app's privacy policy.

## What the server collects

When you connect your Whoop account, the server reads only this from the Whoop API:

- **Cycles:** day strain, calories, and average and maximum heart rate
- **Recovery:** recovery score, heart rate variability, resting heart rate, blood oxygen, and skin temperature
- **Sleep:** sleep times and stages, performance, efficiency, consistency, respiratory rate, and sleep need
- **Workouts:** activity type, times, strain, heart rate, calories, and time in heart-rate zones

Each record also carries its start and end times, the timezone offset where it was recorded, and your Whoop user ID. The server doesn't request your Whoop profile or body measurements.

## Where it's stored

Everything is stored in a SQLite database on the operator's server:

- **Hosting:** the database and the server's logs live with whichever provider hosts the server (for example Railway), which processes them under its own terms.
- **Whoop tokens** are encrypted.
- **Sign-in codes and tokens** for MCP clients are stored only as hashes.
- **Synced records** stay in the database until the operator deletes it. Each sync covers the last 7 to 90 days.

## Who it's shared with

- **The MCP client you sign in** (for example Claude) receives only the answers to the tools it calls. That client's provider handles your conversations under its own privacy terms.
- **Nothing else:** the server itself doesn't send your data anywhere else, and has no analytics or tracking. If the operator runs it through a tunnel (such as Cloudflare or ngrok), that provider carries the traffic.
- **Logs:** the server logs sign-ins (the app's name, its client ID, and where it returned) and sync errors. Neither includes your health data.

## How to delete it

- **Delete the server's database.** On Railway, delete the service's volume or the whole service. This removes the server's copy of your data and of its Whoop tokens.
- **Revoke access at Whoop:** deleting the database doesn't end the authorization at Whoop. You can revoke it yourself in the WHOOP app, under Integrations, and the operator can remove the app in the [Whoop Developer Dashboard](https://developer-dashboard.whoop.com).

## AI training

The server doesn't use your data to train or improve AI models. WHOOP's [API Terms of Use](https://developer.whoop.com/api-terms-of-use/) also restrict that. The tools' answers do become part of your conversation with the MCP client, and whether that provider uses conversations for training depends on its terms and your settings.

## Contact

- **A specific deployment:** contact its operator.
- **This open-source project:** [open an issue](https://github.com/yuridivonis/whoop-mcp-server/issues).
- **Security problems:** follow [SECURITY.md](SECURITY.md) and report privately.
