# Add to your AI

Once your server is running (see [Setup](../README.md#setup)), connect it to the AI apps you use. Each app signs in the same way:

1. **Add the address.** Add your server's address, `https://your-server/mcp`, to the app as a custom connector, MCP server or MCP app.
2. **Sign in.** The app opens your server's sign-in page:
   - Check that it names the app you're connecting, such as *claude.ai* or *chatgpt.com*.
   - Enter your `MCP_AUTH_PASSWORD`.
   - Tick the box allowing it to read your WHOOP data.
3. **Ask a question,** such as "How recovered am I today?"

**Before you connect an app, turn off anything that lets its provider use your conversations to improve its models.** WHOOP's terms forbid using WHOOP data to improve AI, and your answers pass through the app. Each section below says where that setting is.

**To stop sharing with an app,** remove the server from it. To sign every app out at once, change `MCP_AUTH_PASSWORD` and redeploy.

Menus, plans and policies below are as each vendor's own documentation described them in September 2026, with links. If something has moved, check the linked page.

## Compatibility

| App | Status | Last tested live |
|---|---|---|
| Claude (claude.ai on the web) | ✅ Works | 26 Sep 2026, server 1.3.0 |
| ChatGPT (Business workspace, on the web) | ✅ Works | 26 Sep 2026, server 1.3.0 |
| Claude Desktop and mobile | Should work: they use the connectors you add on claude.ai | Not yet |
| Claude Code | Should work: its documented callback address passes the automated tests | Not yet |
| Cursor (desktop) | Should work: its documented callback address passes the automated tests | Not yet |
| VS Code (desktop) | Should work: its documented callback address passes the automated tests | Not yet |
| Windsurf (now Devin Desktop) | Unknown: its docs don't say where it returns after sign-in | Not yet |
| Cursor agents on the web, VS Code for the Web | Blocked: they return to `www.cursor.com` and `vscode.dev`, which the server doesn't allow unless you add them to `MCP_ALLOWED_REDIRECT_HOSTS` | Not yet |

- **"Works"** means tested live on the owner's own account. The sign-in page has been redesigned since (1.3.1); the way apps sign in hasn't changed.
- **"Should work"** means the app's documented callback address, sent the way the app sends it, passes this server's automated tests, which run on every change. Nobody has confirmed it live yet.
- **If you've tried one of the untested apps,** please [open an issue](https://github.com/yuridivonis/whoop-mcp-server/issues) saying whether it worked, and which app and server versions you used.

## Claude

**Tested live on 26 Sep 2026.**

Per [Anthropic's help center](https://support.claude.com/en/articles/11175166) (Sep 2026):

1. On [claude.ai](https://claude.ai), go to **Customize → Connectors**, click **+**, then **Add custom connector**.
   - **Team and Enterprise:** an owner adds it first under **Organization settings → Connectors → Add → Custom → Web**. Members then click **Connect** under **Customize → Connectors**.
2. Paste `https://your-server/mcp`, give it a name such as `Whoop`, and click **Add**. Leave **Advanced settings** empty: the server registers Claude by itself.
3. Click **Connect**. On the sign-in page, check it says you'll return to **claude.ai**, then enter the password, tick the box, and sign in.
4. The connector lists six read-only tools. Claude asks before using each one ("Needs approval"). Because they only read, you can set them to **Always allow**.
5. In a chat, turn the connector on under **+ → Connectors** if it isn't already.

**Claude Desktop and the mobile apps** use the connectors on your account, so there's nothing more to add.

**Your chats and training:**
Per [Anthropic's privacy center](https://privacy.claude.com/en/articles/12109829) (Sep 2026):
- **Free, Pro and Max:** in **Settings → Privacy**, turn off **Help Improve our AI models**.
- **Team and Enterprise:** Anthropic says it doesn't train on these by default. Thumbs up or down feedback on a chat is the exception.

## ChatGPT

**Tested live on 26 Sep 2026, in a ChatGPT Business workspace.** ChatGPT calls these *MCP apps*.

1. In ChatGPT on the web, go to **Settings → Plugins → Add → Create MCP App**.
   - If there's no **Create MCP App**, turn on **Developer mode** under **Settings → Security and login**.
   - In a Business or Enterprise workspace, an admin may have to allow custom apps first.
2. Enter a **name** (such as `Whoop`) and a **description**, set the **MCP server URL** to `https://your-server/mcp`, and choose **OAuth**. If asked how the app registers, choose **Dynamic client registration**.
3. Complete the sign-in. The page should say you'll return to **chatgpt.com**. Enter the password, tick the box, sign in, and create the app.
4. In a new chat, mention the app (`@Whoop`) or click **Try in chat**, and ask.

**Other plans and older menus,** per [OpenAI's developer docs](https://developers.openai.com/api/docs/guides/developer-mode) (Sep 2026):
- **Plus and Pro:** OpenAI's docs list these plans too.
- **Older menus:** some versions put Developer mode under **Settings → Apps → Advanced settings**.
- **Mobile:** MCP apps are web-only.

**Keep it to yourself:** don't use **Publish to workspace**, which offers the app to everyone in the workspace.

**Your chats and training:**
Per [OpenAI's help center](https://help.openai.com/en/articles/7730893) (Sep 2026):
- **Business and Enterprise:** OpenAI says it doesn't train on workspace data by default.
- **Plus and Pro:** turn off **Settings → Data controls → Improve the model for everyone**, or ask not to be trained on at [privacy.openai.com](https://privacy.openai.com). OpenAI says either works.
- **Memory:** ChatGPT's page for the app says that, with **Memory** on, it may reuse what the app returned. Turn Memory off, or delete those memories, if you don't want a copy kept there.

**To stop sharing:** open the app under **Settings → Plugins** and choose **Uninstall**.

## Claude Code

**Not yet tested live.** From [Claude Code's docs](https://code.claude.com/docs/en/mcp):

```bash
claude mcp add --transport http whoop https://your-server/mcp
```

Then run `/mcp` in Claude Code, or `claude mcp login whoop` from the shell, and sign in in the browser that opens. The sign-in page says you'll return to *an app on this computer*. Claude Code with a Free, Pro or Max account follows that account's **Help Improve our AI models** setting.

## Cursor

**Not yet tested live.** From [Cursor's docs](https://cursor.com/docs/context/mcp), add the server to `~/.cursor/mcp.json`, or to `.cursor/mcp.json` in one project:

```json
{
  "mcpServers": {
    "whoop": { "url": "https://your-server/mcp" }
  }
}
```

Cursor opens the sign-in page when it first connects, and it should say you'll return to *an app on this computer*. Cursor's agents on the web return to `www.cursor.com` instead, which the server doesn't allow unless you add it to `MCP_ALLOWED_REDIRECT_HOSTS`.

## VS Code

**Not yet tested live.** From [VS Code's docs](https://code.visualstudio.com/docs/agent-customization/mcp-servers), run **MCP: Add Server** from the Command Palette, or add this to `.vscode/mcp.json` (or to your user configuration with **MCP: Open User Configuration**):

```json
{
  "servers": {
    "whoop": { "type": "http", "url": "https://your-server/mcp" }
  }
}
```

VS Code registers itself with the server and opens the sign-in page in your browser. It should say you'll return to *an app on this computer*. VS Code for the Web returns to `vscode.dev` instead, which the server doesn't allow unless you add it to `MCP_ALLOWED_REDIRECT_HOSTS`.

## Windsurf (now Devin Desktop)

**Not yet tested, and it might not work.** Per [its docs](https://docs.devin.ai/desktop/devin-desktop-faq) (Sep 2026), Windsurf was renamed Devin Desktop in June 2026. They don't say where it returns after sign-in. If that's a web address the server doesn't allow, registering fails, with a message naming the host to add to `MCP_ALLOWED_REDIRECT_HOSTS`. Its [MCP docs](https://docs.devin.ai/desktop/cascade/mcp) configure a remote server like this, in the file that **… → Open MCP config file** in the Cascade panel opens:

```json
{
  "mcpServers": {
    "whoop": { "serverUrl": "https://your-server/mcp" }
  }
}
```

If you try it, please [open an issue](https://github.com/yuridivonis/whoop-mcp-server/issues) saying whether it worked, and quoting any error message.

## Other apps

Any MCP app that signs in with OAuth (with dynamic client registration and PKCE) should work if it returns to one of these after sign-in:
- an address on your own computer (`localhost` or `127.0.0.1`);
- a desktop app link (`cursor://`, `vscode://`, `vscode-insiders://` or `windsurf://`);
- an `https` address on a host you've added to `MCP_ALLOWED_REDIRECT_HOSTS`.

Only add hosts that belong to an app you use. A host you add can receive sign-in codes for your server.

