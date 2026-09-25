# Privacy

This notice describes how a Whoop MCP Server deployment handles your data. Each deployment is run by whoever deployed it (the operator), usually for their own Whoop account. If you run one for other people, adapt this notice and add your contact details. You can link it as your Whoop app's privacy policy.

## What the server collects

When you connect your Whoop account, the server reads only this from the Whoop API:

- **Cycles:** day strain, calories, and average and maximum heart rate
- **Recovery:** recovery score, heart rate variability, resting heart rate, blood oxygen, and skin temperature
- **Sleep:** sleep times and stages, performance, efficiency, consistency, respiratory rate, and sleep need
- **Workouts:** activity type, times, strain, heart rate, calories, and time in heart-rate zones

It doesn't request your Whoop profile or body measurements.

## Where it's stored

Everything is stored in a SQLite database on the operator's server:

- **Whoop tokens** are encrypted.
- **Sign-in codes and tokens** for MCP clients are stored only as hashes.
- **Synced records** stay in the database until the operator deletes it. Each sync covers the last 7 to 90 days.

## Who it's shared with

- **The MCP client you sign in** (for example Claude) receives only the answers to the tools it calls. That client's provider handles your conversations under its own privacy terms.
- **Nothing else:** the server doesn't send your data anywhere else, and has no analytics or tracking.
- **Logs:** the server logs sign-ins (the app's name and where it returned) and sync errors. Neither includes your health data.

## How to delete it

- **Delete the server's database.** On Railway, delete the service's volume or the whole service.
- **Cut off access to Whoop:** deleting the database also deletes the Whoop tokens. The operator can additionally remove the app in the [Whoop Developer Dashboard](https://developer-dashboard.whoop.com).

## AI training

The server doesn't use your data to train or improve AI models. WHOOP's [API Terms of Use](https://developer.whoop.com/api-terms-of-use/) also restrict that.

## Contact

- **A specific deployment:** contact its operator.
- **This open-source project:** [open an issue](https://github.com/yuridivonis/whoop-mcp-server/issues).
- **Security problems:** follow [SECURITY.md](SECURITY.md) and report privately.
