# Using the DBHawk MCP server in Codex Desktop

A step-by-step guide to run the **DBHawk** MCP server in **Codex Desktop** (OpenAI Codex). Codex has
no "plugin" concept — you register the DBHawk MCP server, which is the self-contained Node bundle from
this repository. Codex Desktop, the IDE extension, and the CLI all share the same config file, so this
setup is portable across them.

> This is independent of the Claude Code marketplace plugin and the Claude Desktop `.mcpb` extension.

---

## What you'll need

- **Codex Desktop** (OpenAI Codex).
- **Node.js ≥ 18** on your `PATH` — Codex does **not** bundle Node. No `npm install` is needed; the
  server bundle is self-contained.
- **Your DBHawk URL** — the base URL of the stand, e.g. `https://demo.dbhawk.example.com`
  (without a trailing `/api`).
- **A personal DBHawk API token** in the form `dbh_<id>.<secret>` (see Step 1).
- The token owner needs the `ACCESS_TO_DATA` permission and membership in the MCP access group.

---

## Step 1. Get an API token in DBHawk

1. Sign in to DBHawk with your account.
2. Go to **User Profile → API Token**.
3. Create (or copy an existing) token. It looks like `dbh_...` — copy the whole value.

> Don't share the token in chats or commit it to a repository. See Step 3 for keeping it out of the
> config file.

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

Codex Desktop reads the **global** `~/.codex/config.toml` (a project-level `.codex/config.toml` may be
ignored by Desktop), and all Codex surfaces share that file. You can add the server via the GUI, the
config file, or the CLI.

### Option A — config file (recommended, handles the token safely)

Edit `~/.codex/config.toml`. Codex can pull the token from your environment via `env_vars`, so it is
**not** stored in the file:

```toml
[mcp_servers.dbhawk]
command = "node"
args = ["C:/path/to/dbhawk-mcp-plugin/dbhawk/mcp-server/dist/dbhawk-mcp.mjs"]
env_vars = ["DBHAWK_TOKEN"]              # pulled from your environment, not written to the file

[mcp_servers.dbhawk.env]
DBHAWK_BASE_URL = "https://YOUR-dbhawk"
DBHAWK_DEFAULT_DATASOURCE = ""
```

Then export the token once in your system environment (Windows):

```bash
setx DBHAWK_TOKEN "dbh_YOUR_TOKEN"
```

(macOS/Linux: add `export DBHAWK_TOKEN="dbh_YOUR_TOKEN"` to your shell profile.)

Use forward slashes in `args` even on Windows.

> If you don't mind a plaintext token, you can instead put it directly in the `env` section
> (`DBHAWK_TOKEN = "dbh_..."`). Values under `[mcp_servers.dbhawk.env]` are stored **in clear text** in
> `config.toml`, which is why the `env_vars` approach above is preferred.

### Option B — Codex Desktop GUI

1. Open **Settings → MCP servers**.
2. Select **Add server**.
3. Enter the name `dbhawk`, choose **STDIO**, and provide the command
   (`node` + the path to `dbhawk-mcp.mjs`).

The Add-server dialog is mainly for the name and command; set the environment variables
(`DBHAWK_BASE_URL`, token, datasource) in `~/.codex/config.toml` as in Option A, since the server
won't start without them.

### Option C — CLI (writes into the same config.toml)

```bash
codex mcp add dbhawk --env DBHAWK_BASE_URL=https://YOUR-dbhawk --env DBHAWK_TOKEN=dbh_YOUR_TOKEN --env DBHAWK_DEFAULT_DATASOURCE= -- node C:/path/to/dbhawk-mcp-plugin/dbhawk/mcp-server/dist/dbhawk-mcp.mjs
```

(Note: `--env` writes plaintext values into `config.toml`; prefer Option A for the token.)

---

## Step 4. Verify it works

1. Restart Codex Desktop.
2. Open **Settings → MCP servers** — `dbhawk` should be listed and connected.
3. In a chat, send a request that triggers a tool, for example:

   > Which datasources do I have in DBHawk?

Codex calls the `list_datasources` tool and returns your list of datasources — that means the
connection, URL, and token all work. Other things to try:

> Show tables in schema public of the <name> datasource

> How many orders last month by status? (text-to-SQL, then run)

---

## Updating

The server is whatever the cloned repo currently contains. To update:

```bash
git pull
```

then restart Codex Desktop (or restart the `dbhawk` server from **Settings → MCP servers**).

---

## Troubleshooting

| Symptom | Cause / what to do |
|---|---|
| **`node` not found / server won't start** | Node.js isn't on `PATH`. Install Node ≥ 18 and restart Codex, or use an absolute path to `node` in `command`. |
| **`dbhawk` not listed / no tools** | Check `~/.codex/config.toml` syntax; Codex Desktop reads the **global** file, not a project `.codex/config.toml`. Restart Codex after editing. |
| **Missing configuration** on startup | `DBHAWK_BASE_URL` or `DBHAWK_TOKEN` is empty. With `env_vars = ["DBHAWK_TOKEN"]`, make sure the variable is actually exported in the environment Codex runs in (restart after `setx`). |
| **token exchange failed: 401/403** | The token is wrong, revoked, or expired; or the user isn't in the MCP access group. For SSO/SAML users, sign in to DBHawk once via your IdP, then the token works again. Reissue it if needed. |
| **DBHawk API 401/403** (after exchange) | Wrong scope, or the user lacks `ACCESS_TO_DATA`. |
| **Only read-only statements…** | A write/DDL statement was attempted — this is expected; MCP is read-only. |
| **404 on the first tool call** | A trailing slash or extra path on `DBHAWK_BASE_URL`. Use the bare origin + context path, e.g. `https://qa.dbhawk.com/dbhawk` (no trailing `/`). |

---

<sub>Exact labels and menus may vary slightly depending on your Codex version. See the official docs:
<a href="https://learn.chatgpt.com/docs/extend/mcp" target="_blank" rel="noopener noreferrer">Codex — Add MCP servers</a>.</sub>
