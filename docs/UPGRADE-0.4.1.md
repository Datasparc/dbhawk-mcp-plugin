# Upgrading the DBHawk MCP plugin to 0.4.1

Version 0.4.1 (0.4.0 + the `explain_plan`, `list_sessions` and `kill_session` tools) of the DBHawk MCP server (Claude Code plugin `dbhawk`, Claude Desktop extension
`dbhawk-0.4.1.mcpb`, npm package `@dbhawk/mcp`) adds support for **MCP access tiers**: depending on the tier
your DBHawk administrator assigns to your user group, the assistant can now also change data or schema, with
your approval.

## What changes for you

| | 0.3.0 | 0.4.1 |
|---|---|---|
| Reads | `run_query` | `run_query` - unchanged, and now always read-only: a write sent through it is refused |
| Data / schema changes | not possible | new **`execute_statement`** tool - only if your MCP tier allows it |
| Your permissions | – | new **`get_permissions`** tool: your tier(s), allowed operations, row cap, what needs confirmation |
| Approval of changes | – | `execute_statement` is marked *destructive*: your MCP client asks you before every call. If your tier asks for confirmation, DBHawk also holds the change until you approve it. |
| Database credentials | `run_query` accepted `dbUserName` / `dbPassword` | removed - DBHawk never accepted them over MCP anyway |
| Text-to-SQL | always SELECT | generates the statement types your tier allows |
| Execution plans | not possible for Oracle / SQL Server (the plan was lost between two calls) | new **`explain_plan`** tool: the plan is built and read in one call, the statement is never executed (0.4.1) |
| Database sessions | not possible (session views are closed to MCP) | new **`list_sessions`** and **`kill_session`** tools - by default only on the *Destructive / admin* tier; `kill_session` asks you first (0.4.1) |

Nothing to reconfigure: the same **DBHawk Base URL**, **MCP token** and **Default Datasource** keep working.
Tool names you already use are unchanged.

> **Do not "always allow" `execute_statement`.** The per-call prompt of your MCP client is how you approve a
> change. Read-only tools (`run_query`, `list_*`, `text_to_sql` …) can safely be always-allowed.

## Before you start (DBHawk administrators)

- **Server:** the plugin works against any DBHawk with the MCP API, but `execute_statement` and
  `get_permissions` only make sense on a DBHawk build with **MCP tiers** (database migration 81, Admin → MCP
  Management → **MCP Tiers**), and `explain_plan` / `list_sessions` / `kill_session` need a build with the MCP
  explain and sessions endpoints (database migration 82). On an older server these tools return 404 and every
  change is refused, as before.
- **Tiers:** after the DBHawk upgrade every group uses the default tier **Read**, so nothing changes until you
  assign a higher tier (User Group dialog → *MCP Tier*). See *docs/mcp-tiers.md* in the DBHawk repository.
- **Upgrade the clients.** A 0.3.0 client keeps working for reads, but its `run_query` does not mark calls as
  read-only: for a user on a write tier, a write sent through it follows the tier instead of being refused.

---

## Claude Code (marketplace plugin)

**Step 1 - update the plugin**, either from your shell:

```bash
claude plugin update dbhawk@dbhawk-marketplace
```

or inside a Claude Code session: `/plugin` → **Installed** → `dbhawk` → **Update now**.

If 0.4.1 is not offered yet, refresh the marketplace first: `/plugin` → **Marketplaces** →
`dbhawk-marketplace` → update (CLI: `claude plugin marketplace update dbhawk-marketplace`).

**Step 2 - apply it to the running session** (or simply start a new Claude Code session):

```
/reload-plugins
```

**Step 3 - nothing to re-enter.** Your Base URL, token and default datasource are kept; the token stays in the
secure credential store.

Optional: enable automatic updates for this marketplace - `/plugin` → **Marketplaces** →
`dbhawk-marketplace` → **Enable auto-update**. It is off by default for non-Anthropic marketplaces.

**Loaded with `claude --plugin-dir …`?** Update the folder (`git pull` in the plugin repository), then run
`/reload-plugins`.

## Claude Desktop (extension, `.mcpb`)

Claude Desktop does not update file-installed extensions by itself.

1. Download **`dbhawk-0.4.1.mcpb`** from the
   [Releases page](https://github.com/Datasparc/dbhawk-mcp-plugin/releases).
2. Claude Desktop → **Settings → Extensions → Advanced settings → Install** and choose the file (or drag it
   onto the Extensions window). It replaces 0.3.0.
3. Open the extension's settings and check that **DBHawk Base URL**, **API Token** and **Default Datasource**
   are still filled in (they are usually kept).
4. Quit Claude Desktop completely (including the tray icon) and start it again.

## Claude Desktop (manual `claude_desktop_config.json`)

Your config points at a local copy of the bundle (`…/dbhawk/mcp-server/dist/dbhawk-mcp.mjs`).

1. Update that copy: `git pull` in the cloned `dbhawk-mcp-plugin` repository (no `npm install` or build
   needed - the bundle is committed).
2. Quit Claude Desktop completely and start it again.

Prefer not to keep a clone? Switch the entry to the npm package (see next section).

## Any MCP client via npm (`@dbhawk/mcp`)

If your client runs the server with `npx`:

```json
{
  "mcpServers": {
    "dbhawk": {
      "command": "npx",
      "args": ["-y", "@dbhawk/mcp@0.4.1"],
      "env": {
        "DBHAWK_BASE_URL": "https://dbhawk.example.com",
        "DBHAWK_TOKEN": "dbh_your_token"
      }
    }
  }
}
```

- With an unpinned `@dbhawk/mcp`, `npx` may keep using a cached 0.3.0. Pin the version as above, or clear the
  cache once (`npx clear-npx-cache`, or delete the `_npx` folder in the npm cache), then restart the client.
- Claude Code CLI users who added it with `claude mcp add`: re-add it pinned -
  `claude mcp remove dbhawk` then
  `claude mcp add dbhawk -e DBHAWK_BASE_URL=… -e DBHAWK_TOKEN=… -- npx -y @dbhawk/mcp@0.4.1`.

## VS Code, Codex, SQL Server Management Studio (cloned repository)

These setups run `node …/dbhawk/mcp-server/dist/dbhawk-mcp.mjs` from a clone of the repository.

1. `git pull` in the cloned repository.
2. Restart the server:
   - **VS Code:** Command Palette → **MCP: List Servers** → `dbhawk` → **Restart** (or reload the window).
   - **Codex:** restart Codex Desktop / start a new Codex CLI session.
   - **SSMS (Copilot):** restart SSMS, or toggle the `dbhawk` server off and on in the Copilot tools list.
3. Enable the two new tools (`get_permissions`, `execute_statement`) if your client lists tools individually.

---

## Check the upgrade

1. The tool list contains **`execute_statement`**, **`get_permissions`**, **`explain_plan`**, **`list_sessions`** and
   **`kill_session`** (15 tools) (Claude Code: `/mcp` → `dbhawk`;
   VS Code: *MCP: List Servers*; Claude Desktop: the tools menu of the extension).
2. Ask the assistant: *"What are my DBHawk MCP permissions?"* - it calls `get_permissions` and reports your
   tier, e.g. `Read`, and the allowed operations.
3. On a tier that allows changes, ask for a small change on a test table. Expected: your MCP client asks you to
   approve `execute_statement`; if the tier asks for confirmation, the assistant shows the statement first and
   runs it only after you say yes.
4. On a tier with `explain_plan` (*Read-only DBA* and above), ask *"Show the execution plan of SELECT … "* - the
   assistant calls `explain_plan` once and shows the plan.
5. On the default tier **Read**, ask for the same change. Expected: DBHawk refuses with "…needs MCP operation(s)
   update_rows, which your MCP tier 'Read' does not allow".

## Troubleshooting

| Symptom | What to do |
|---|---|
| `explain_plan` → `does not allow` | Your tier lacks `explain_plan` (it starts at *Read-only DBA*), or the statement's own operation |
| `list_sessions` → `does not allow` | `active_sessions` is only in the *Destructive / admin* tier by default; an administrator can add it to another tier |
| `list_sessions` → `…needs access to the session views…` | The datasource's database account cannot read `v$session` / `sys.dm_exec_sessions` / `pg_stat_activity`; grant it, or use the DBHawk Session Manager |
| `kill_session` → `Session … not found` | The session ended already, or it is not visible to you (DBHawk's session user filter) |
| `explain_plan` → `…written into explain tables…` | DB2 / SAP HANA: plans are not available over MCP; use the DBHawk SQL editor |
| New tools missing after the update | The old process is still running: `/reload-plugins` (Claude Code), fully restart Claude Desktop / the client, or check `npx` is not using a cached 0.3.0 |
| `get_permissions` → `DBHawk API 404` | The DBHawk server predates MCP tiers. Reads keep working; ask the administrator to upgrade DBHawk |
| `… does not allow` on a change | Your tier does not include that operation. Ask the administrator for a higher MCP tier |
| `… cannot run as a read-only query. Use the execute_statement tool instead.` | The assistant sent a change through `run_query`; it should retry with `execute_statement` |
| `confirmationRequired: true` | Not an error: approve the shown statement and the assistant repeats it with `confirm` |
| `Datasource '…' is read-only` | The datasource is read-only in DBHawk; no tier can change that |
| `token exchange failed: 401` | Token revoked or expired - create a new one in DBHawk → User Profile → MCP Access |

---

## For maintainers - releasing 0.4.1

All versions must read `0.4.1` (CI checks them): `dbhawk/mcp-server/package.json`,
`dbhawk/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `mcpb/manifest.json`, `server.json`
(twice) and `McpServer({ version })` in `index.js`.

```bash
cd dbhawk/mcp-server && npm ci && npm test && cd ../..         # builds dist/ and runs the tests
cp dbhawk/mcp-server/dist/dbhawk-mcp.mjs mcpb/server/dbhawk-mcp.mjs
npx @anthropic-ai/mcpb pack mcpb dbhawk-0.4.1.mcpb
git add -A && git commit -m "Release 0.4.1: MCP tiers (execute_statement, get_permissions, explain_plan, sessions)" && git push

gh release create 0.4.1 dbhawk-0.4.1.mcpb --title "DBHawk 0.4.1" \
  --notes "MCP tiers: execute_statement, get_permissions, explain_plan, list_sessions, kill_session; run_query is read-only. See docs/UPGRADE-0.4.1.md"

cd dbhawk/mcp-server && npm publish --access public                # @dbhawk/mcp
cd ../.. && mcp-publisher publish                                  # MCP registry entry from server.json
```

Pushing to `main` updates the Claude Code marketplace; users get 0.4.1 with `claude plugin update` (or
automatically, if they enabled auto-update).
