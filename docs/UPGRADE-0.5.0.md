# Upgrading the DBHawk MCP plugin to 0.5.0

Version 0.5.0 of the DBHawk MCP server (Claude Code plugin `dbhawk`, Claude Desktop extension `dbhawk-0.5.0.mcpb`,
npm package `@dbhawk/mcp`) can **sign in to DBHawk through the browser**, so no personal MCP token has to be
generated, pasted or rotated. Tools are unchanged; a configured token keeps working exactly as before.

## How it works

Leave **API Token** (`DBHAWK_TOKEN`) empty. On the first DBHawk tool call the server:

1. registers itself with DBHawk once (OAuth dynamic client registration),
2. opens the DBHawk sign-in in the system browser - the regular DBHawk login, so password, LDAP, 2FA and every
   configured SSO provider work - and, after you click **Allow**, receives the result on a one-time listener on
   `127.0.0.1` (OAuth 2.1 authorization code + PKCE),
3. keeps the refresh token in a file only you can read, one per DBHawk URL:
   `%APPDATA%\dbhawk-mcp\oauth-*.json` (Windows), `~/Library/Application Support/dbhawk-mcp/` (macOS),
   `~/.config/dbhawk-mcp/` (Linux). The access token stays in memory and is refreshed automatically.

If you take longer than ~45 seconds, Claude gets "Sign in to DBHawk in the browser window that just opened …";
finish signing in and repeat the request - no second window opens.

What you may do is decided by DBHawk exactly as with a token: MCP access on one of your groups, your MCP tier and
its confirmations, access control and masking. The access ends when you revoke it, lose MCP access, or after at
most 30 days (or the admin maximum token lifetime); SSO users are asked to sign in again after the SSO
re-validation window (`apiTokenSsoMaxDays`). The server then simply opens the browser again.

## Requirements

- DBHawk 7.0.1 with the native MCP connector (OAuth authorization server at `/api/oauth`). An older DBHawk answers
  "This DBHawk server does not support signing in from the extension" - keep using a personal token there.
- The machine running Claude must reach DBHawk at the configured Base URL (as before) - VPN-only DBHawk servers are
  fine, unlike claude.ai custom connectors, which connect from Anthropic's cloud.

## Upgrade

- **Claude Desktop:** install `dbhawk-0.5.0.mcpb` (Settings -> Extensions -> Advanced settings -> Install), then
  clear the **API Token** field to switch to browser sign-in, or keep it to stay on the token.
- **Claude Code:** `claude plugin update dbhawk@dbhawk-marketplace`; the token is now optional in the plugin
  settings.
- **npx / manual config:** `@dbhawk/mcp@0.5.0`; drop `DBHAWK_TOKEN` from the environment to use browser sign-in.

Settings for special cases: `DBHAWK_BROWSER=none` only prints the sign-in URL (headless hosts), any other value is
the command used to open it; `DBHAWK_OAUTH_STORE_DIR` moves the refresh token file.

---

## For maintainers - releasing 0.5.0

All versions read `0.5.0` (CI checks them).

```bash
cd dbhawk/mcp-server && npm ci && npm test && cd ../..         # builds dist/ and runs the tests
cp dbhawk/mcp-server/dist/dbhawk-mcp.mjs mcpb/server/dbhawk-mcp.mjs
npx @anthropic-ai/mcpb validate mcpb/manifest.json
npx @anthropic-ai/mcpb pack mcpb dbhawk-0.5.0.mcpb
gh release create v0.5.0 dbhawk-0.5.0.mcpb --title "DBHawk 0.5.0" --notes "Browser sign-in to DBHawk (no token needed)"
```
