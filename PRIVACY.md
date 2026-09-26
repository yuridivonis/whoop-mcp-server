# Privacy

This notice describes how a Whoop MCP Server deployment handles your data. Each deployment is run by whoever deployed it (the operator), usually for their own Whoop account, and the operator can link this notice as their Whoop app's privacy policy.

**The operator is the developer** under WHOOP's API Terms of Use. If you run a deployment for someone else, this notice has to become yours: add your name and contact details under Contact, and change anything that differs in your setup. The README's [If you run it for someone else](README.md#if-you-run-it-for-someone-else) lists what else you're responsible for.

## What the server collects

When a tool needs it, the server reads only this from the Whoop API:

- **Cycles:** day strain, calories, and average and maximum heart rate
- **Recovery:** recovery score, heart rate variability, resting heart rate, blood oxygen, and skin temperature
- **Sleep:** sleep times and stages, performance, efficiency, consistency, respiratory rate, and sleep need
- **Workouts:** activity type, times, strain, heart rate, calories, and time in heart-rate zones

Each record also carries its start and end times, the timezone offset where it was recorded, and your Whoop user ID. The server doesn't request your Whoop profile or body measurements.

## Where it's stored

**Your Whoop data isn't stored.** The server fetches it from Whoop each time a tool is called, and keeps nothing of it once the answer is sent. Earlier versions kept a copy; this version deletes it the first time it starts.

The server's SQLite database, on the operator's server, holds only:

- **Whoop tokens,** encrypted, with a note of when a token refresh started, while one is under way;
- **the MCP clients that have registered,** with their app names and the addresses they return to after signing in;
- **sign-in codes and tokens** for MCP clients, stored only as hashes;
- the server's own settings.

The database and the server's logs live with whichever provider hosts the server (for example Railway), which processes them under its own terms.

## Who it's shared with

- **The MCP client you sign in** (for example Claude) receives only the answers to the tools it calls, and only after you allow it. The sign-in page names where your data goes and asks you to tick a box allowing it. That client's provider handles your conversations under its own privacy terms.
- **To stop sharing:** remove the server from the app, or have the operator change the server password (`MCP_AUTH_PASSWORD`), which signs every app out.
- **Nothing else:** the server itself doesn't send your data anywhere else, and has no analytics or tracking. If the operator runs it through a tunnel (such as Cloudflare or ngrok), that provider carries the traffic.
- **Logs:** the server logs sign-ins (the app's name, its client ID, and where it returned) and errors from Whoop. Neither includes your health data.

## How to delete it

- **Delete the server's database.** On Railway, delete the service's volume or the whole service. This removes its Whoop tokens and sign-ins; there's no copy of your data to remove.
- **Revoke access at Whoop:** deleting the database doesn't end the authorization at Whoop. You can revoke it yourself in the WHOOP app, under Integrations, and the operator can remove the app in the [Whoop Developer Dashboard](https://developer-dashboard.whoop.com).

## AI training

The server doesn't use your data to train or improve AI models, and the project's tests use synthetic data only. WHOOP's [API Terms of Use](https://developer.whoop.com/api-terms-of-use/) also forbid using WHOOP data to create, develop, test, train or improve AI (4. WHOOP Data, *Prohibitions on WHOOP Data*). The tools' answers do become part of your conversation with the MCP client, and whether that provider uses conversations for training depends on its terms and your settings.

## Contact

- **A specific deployment:** contact its operator.
- **This open-source project:** [open an issue](https://github.com/yuridivonis/whoop-mcp-server/issues).
- **Security problems:** follow [SECURITY.md](SECURITY.md) and report privately.
