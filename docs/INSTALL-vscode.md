# Using the DBHawk MCP server in VS Code (GitHub Copilot)

A step-by-step guide to run the **DBHawk** MCP server inside VS Code's built-in MCP support
(GitHub Copilot Chat, agent mode). Unlike Claude Code, VS Code doesn't install a "plugin" — you
point its MCP config at the server, which is the self-contained Node bundle from this repository.

> This is independent of the Claude Code marketplace plugin and the Claude Desktop `.mcpb` extension.

---

## What you'll need

- **VS Code** with **GitHub Copilot** and **Copilot Chat**, and **agent mode** enabled (MCP tools are
  used in agent mode).
- **Node.js ≥ 18** available on your `PATH`. VS Code does **not** bundle Node (unlike Claude Desktop),
  so the runtime must be installed on your machine. No `npm install` is needed — the server bundle is
  self-contained.
- **Your DBHawk URL** — the base URL of the stand, e.g. `https://demo.dbhawk.example.com`
  (without a trailing `/api`).
- **A personal DBHawk API token** in the form `dbh_<id>.<secret>` (see Step 1).
- The token owner needs the `ACCESS_TO_DATA` permission and membership in the MCP access group.

---

## Step 1. Get an API token in DBHawk

1. Sign in to DBHawk with your account.
2. Go to **User Profile → API Token**.
3. Create (or copy an existing) token. It looks like `dbh_...` — copy the whole value.

> The token is entered through a masked prompt (see Step 3) and stored by VS Code in its secret
> storage — not written into the config file. Don't share it in chats or commit it to a repository.

---

## Step 2. Get the server from GitHub

Clone this repository:

```bash
git clone https://github.com/datasparc/dbhawk-mcp-plugin.git
```

The server you'll run is the committed, self-contained bundle at
`dbhawk/mcp-server/dist/dbhawk-mcp.mjs` — no build or `npm install` step is required.

---

## Step 3. Add the MCP server config

Pick one of two locations:

- **For a workspace** — create `.vscode/mcp.json` in the folder you open in VS Code.
- **Globally (all workspaces)** — open the Command Palette and run **MCP: Open User Configuration**,
  then paste the same content.

If the workspace you open **is the cloned repo**, use `${workspaceFolder}` so there's no absolute path:

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
      "args": ["${workspaceFolder}/dbhawk/mcp-server/dist/dbhawk-mcp.mjs"],
      "env": {
        "DBHAWK_BASE_URL": "https://YOUR-dbhawk",
        "DBHAWK_TOKEN": "${input:dbhawk_token}",
        "DBHAWK_DEFAULT_DATASOURCE": ""
      }
    }
  }
}
```

If the config lives elsewhere (e.g. the user configuration), replace `${workspaceFolder}/...` with the
**absolute path** to the bundle, using forward slashes even on Windows, e.g.
`C:/Users/you/dbhawk-mcp-plugin/dbhawk/mcp-server/dist/dbhawk-mcp.mjs`.

Notes:
- Set `DBHAWK_BASE_URL` to your stand's base URL, **without** a trailing `/api`.
- `${input:dbhawk_token}` + the `inputs` block make VS Code prompt for the token on first start and
  keep it in secret storage — so no token is written into the file.
- Leave `DBHAWK_DEFAULT_DATASOURCE` empty to require a datasource per tool call.

---

## Step 4. Start the server and enable it in chat

1. Save `mcp.json`. A **Start** action appears above the `"dbhawk"` block — click it and enter the
   token when prompted. (You can also run **MCP: List Servers** from the Command Palette to Start /
   Restart / Stop and to view output.)
2. Open **Copilot Chat** and switch to **Agent mode**.
3. Open the tools picker (the 🛠️ icon) and enable the `dbhawk` tools.

---

## Step 5. Verify it works

In Copilot Chat (agent mode), send a request that triggers a tool, for example:

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

then **MCP: List Servers → Restart** the `dbhawk` server (or reload the window).

---

## Troubleshooting

| Symptom | Cause / what to do |
|---|---|
| **`node` not found / server won't start** | Node.js isn't on `PATH`. Install Node ≥ 18 and restart VS Code, or set `command` to an absolute path to `node`. |
| **Server not listed / no tools in chat** | Confirm you're in **agent mode** and enabled `dbhawk` in the tools picker. Check **MCP: List Servers → Show Output** for errors. |
| **Missing configuration** on startup | `DBHAWK_BASE_URL` or `DBHAWK_TOKEN` is empty — check `env` / the token prompt. |
| **token exchange failed: 401/403** | The token is wrong, revoked, or expired; or the user isn't in the MCP access group. For SSO/SAML users, sign in to DBHawk once via your IdP, then the token works again. Reissue it if needed. |
| **DBHawk API 401/403** (after exchange) | Wrong scope, or the user lacks `ACCESS_TO_DATA`. |
| **Only read-only statements…** | A write/DDL statement was attempted — this is expected; MCP is read-only. |
| **404 on the first tool call** | A trailing slash or extra path on `DBHAWK_BASE_URL`. Use the bare origin + context path, e.g. `https://qa.dbhawk.com/dbhawk` (no trailing `/`). |

---

<sub>Exact labels and menus may vary slightly depending on your VS Code and GitHub Copilot version.</sub>
