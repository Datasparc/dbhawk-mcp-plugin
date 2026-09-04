# Using the DBHawk MCP server with GitHub Copilot in SSMS

A step-by-step guide to run the **DBHawk** MCP server in **GitHub Copilot in SQL Server Management
Studio (SSMS)**. SSMS is an MCP *client*: you register the DBHawk MCP server (the self-contained Node
bundle from this repository) and use it from Copilot **Agent mode**.

> This is independent of the Claude Code plugin, the Claude Desktop `.mcpb` extension, and the VS Code
> / Codex setups.

---

## What you'll need

- **SSMS 22.7 or later** with the **AI Assistance** workload installed (via the Visual Studio Installer).
- A **GitHub account with Copilot access** (or the free Copilot plan in SSMS).
- **GitHub Copilot Agent mode** — MCP works only in Agent mode; **Ask mode doesn't support MCP**.
- **Node.js ≥ 18** on your `PATH` — SSMS does **not** bundle Node. No `npm install` is needed; the
  server bundle is self-contained.
- **Your DBHawk URL** — the base URL of the stand, e.g. `https://demo.dbhawk.example.com`
  (without a trailing `/api`).
- **A personal DBHawk API token** in the form `dbh_<id>.<secret>` (see Step 1). Token owner needs
  `ACCESS_TO_DATA` and membership in the MCP access group.

> If your organization uses a **GitHub Copilot MCP allow list**, an administrator must permit this
> server. Admins can also disable Agent mode/MCP entirely.

---

## Step 1. Get an API token in DBHawk

1. Sign in to DBHawk with your account.
2. Go to **User Profile → API Token**.
3. Create (or copy an existing) token. It looks like `dbh_...` — copy the whole value.

> Don't share the token in chats or commit it to a repository.

---

## Step 2. Get the server from GitHub

Clone this repository:

```bash
git clone https://github.com/datasparc/dbhawk-mcp-plugin.git
```

The server you'll run is the committed, self-contained bundle at
`dbhawk/mcp-server/dist/dbhawk-mcp.mjs` — no build or `npm install` step is required.

---

## Step 3. Add the MCP server

Two options — the Copilot Chat UI or the global `.mcp.json` file. Both make the server available to
your user account.

### Option A — from Copilot Chat (UI)

1. Open the **Copilot Chat** window and switch to **Agent mode**.
2. Select the **Tools** icon to open the Tools panel.
3. Select the green **+** button, then **Add custom MCP server**.
4. Enter a **Server ID** (`dbhawk`), choose **Type = stdio**, and provide the command and arguments:
   - Command: `node`
   - Arguments: the path to `dbhawk-mcp.mjs`, e.g.
     `C:/path/to/dbhawk-mcp-plugin/dbhawk/mcp-server/dist/dbhawk-mcp.mjs`
5. Save. SSMS initializes the server and adds its tools to the Tools list.

The Add-server dialog focuses on the command; set the environment variables (Base URL/token) in
`.mcp.json` as in Option B, since the server won't start without them.

### Option B — the `.mcp.json` file (recommended for env vars)

1. Create or open `%USERPROFILE%\.mcp.json`.
2. Add the server. The `inputs` block prompts for the token on first run and keeps it out of the file:

   ```json
   {
     "inputs": [
       {
         "id": "dbhawk_token",
         "type": "promptString",
         "description": "DBHawk API token (dbh_...)",
         "password": true
       }
     ],
     "servers": {
       "dbhawk": {
         "type": "stdio",
         "command": "node",
         "args": ["C:/path/to/dbhawk-mcp-plugin/dbhawk/mcp-server/dist/dbhawk-mcp.mjs"],
         "env": {
           "DBHAWK_BASE_URL": "https://YOUR-dbhawk",
           "DBHAWK_TOKEN": "${input:dbhawk_token}",
           "DBHAWK_DEFAULT_DATASOURCE": ""
         }
       }
     }
   }
   ```

3. Save. SSMS detects the change, initializes the server, and lists it in the Tools window.

Notes:
- Use forward slashes in `args` even on Windows.
- Set `DBHAWK_BASE_URL` to your stand's base URL, **without** a trailing `/api`.
- If your SSMS build doesn't honor `inputs`, put the token directly in `env`
  (`"DBHAWK_TOKEN": "dbh_..."`) — but then it is stored in plaintext in `.mcp.json`.

---

## Step 4. Enable the tools

**MCP tools are disabled by default after you add a server.** In the Copilot Chat **Tools** panel,
find `dbhawk` and enable its tools (`list_datasources`, `run_query`, etc.) so Copilot can use them.

---

## Step 5. Verify it works

In Copilot Chat (**Agent mode**), send a request that triggers a tool, for example:

> Which datasources do I have in DBHawk?

Copilot calls the `list_datasources` tool and returns your list of datasources — that means the
connection, URL, and token all work. Other things to try:

> Show tables in schema public of the <name> datasource

> How many orders last month by status? (text-to-SQL, then run)

---

## Updating

The server is whatever the cloned repo currently contains. To update:

```bash
git pull
```

then re-initialize the server (save `.mcp.json` again, or remove and re-add it in the Tools panel).

---

## Troubleshooting

| Symptom | Cause / what to do |
|---|---|
| **MCP option missing / can't add a server** | Confirm SSMS 22.7+ with the AI Assistance workload, that you're in **Agent mode**, and that your Copilot admin allows Agent mode/MCP (and the server allow list, if configured). |
| **`node` not found / server won't start** | Node.js isn't on `PATH`. Install Node ≥ 18 and restart SSMS, or use an absolute path to `node`. |
| **Server added but Copilot won't use it** | Tools are disabled by default — enable `dbhawk` tools in the Tools panel. |
| **Missing configuration** on startup | `DBHAWK_BASE_URL` or `DBHAWK_TOKEN` is empty — check `env` / the token prompt. |
| **token exchange failed: 401/403** | The token is wrong, revoked, or expired; or the user isn't in the MCP access group. For SSO/SAML users, sign in to DBHawk once via your IdP, then the token works again. Reissue it if needed. |
| **DBHawk API 401/403** (after exchange) | Wrong scope, or the user lacks `ACCESS_TO_DATA`. |
| **Only read-only statements…** | A write/DDL statement was attempted — this is expected; MCP is read-only. |
| **404 on the first tool call** | A trailing slash or extra path on `DBHAWK_BASE_URL`. Use the bare origin + context path, e.g. `https://qa.dbhawk.com/dbhawk` (no trailing `/`). |

---

<sub>Exact labels and menus may vary by SSMS version. Official docs:
<a href="https://learn.microsoft.com/en-us/ssms/github-copilot/mcp-servers" target="_blank" rel="noopener noreferrer">MCP Servers — GitHub Copilot in SSMS</a>
and <a href="https://learn.microsoft.com/en-us/ssms/github-copilot/agent-mode" target="_blank" rel="noopener noreferrer">Agent mode</a>.</sub>
