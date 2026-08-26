# DBHawk MCP — Claude Code plugin + demo connector

Gives an AI assistant read-only access to DBHawk: list the datasources a user is assigned,
browse schema/tables/columns, run **read-only** queries (with the user's access control and column
masking applied), and use **HawkAI** text-to-SQL / optimize / format.

It's a thin bridge over the existing DBHawk REST surface at `/api/v2/mcp/**`. No write path exists;
DBHawk rejects any statement that modifies data or schema, whatever role the token owner has.

**Auth is two steps.** `DBHAWK_TOKEN` is a personal token (`dbh_<id>.<secret>`), **not** a JWT — the
MCP endpoints won't accept it directly. On its first call the server exchanges it for a short-lived JWT
at `POST /api/v2/auth/token/exchange` (sending the personal token in the `X-API-Token` header), caches
that JWT, and sends it as the `Bearer` for every `/api/v2/mcp/**` call. When the JWT expires the next
call gets a `401`, and the server re-exchanges and retries once — transparent to you.

```
dbhawk-mcp-plugin/                 <- this folder = a Claude Code "marketplace" (push it to git)
├── .claude-plugin/marketplace.json
└── dbhawk/                        <- the actual plugin (installed by users)
    ├── .claude-plugin/plugin.json
    ├── .mcp.json                  <- declares the "dbhawk" stdio MCP server
    └── mcp-server/
        ├── index.js               <- source
        ├── package.json           <- build tooling (maintainers only)
        └── dist/dbhawk-mcp.mjs    <- COMMITTED self-contained bundle (what users run; no npm install)
```

The bundle in `dist/` inlines every dependency, so **a bare `git clone` runs with zero install** —
that's what makes `/plugin install` work.

---

## For users — install

### Claude Code (from the marketplace)

Once this repo is on GitHub (see *Publish* below), point Claude Code at it and install:

```bash
/plugin marketplace add datasparc/dbhawk-mcp-plugin
/plugin install dbhawk@dbhawk-marketplace
```

`dbhawk` is the plugin name, `dbhawk-marketplace` is the marketplace name (from `marketplace.json`).
Then set the connection (see *Configure*) and check the tools are live with `/mcp`.

Prefer to try it without a git host? Load the local folder for one session:

```bash
claude --plugin-dir ./dbhawk-mcp-plugin/dbhawk
```

### Claude Desktop (local connector)

Desktop doesn't understand plugins or `${CLAUDE_PLUGIN_ROOT}` — point it at the bundle with an
**absolute path**. Edit `claude_desktop_config.json`
(Windows: `%APPDATA%\Claude\claude_desktop_config.json`,
macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "dbhawk": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\...\\dbhawk-mcp-plugin\\dbhawk\\mcp-server\\dist\\dbhawk-mcp.mjs"],
      "env": {
        "DBHAWK_BASE_URL": "https://demo.dbhawk.example.com",
        "DBHAWK_TOKEN": "PASTE_MCP_TOKEN_HERE",
        "DBHAWK_DEFAULT_DATASOURCE": ""
      }
    }
  }
}
```

Restart Claude Desktop fully (including the tray icon).

---

## Configure

The server needs three values (the token owner needs `ACCESS_TO_DATA`):

| Setting | Required | Meaning |
|---|---|---|
| Base URL (`DBHAWK_BASE_URL`) | yes | Base URL of DBHawk, e.g. `https://demo.dbhawk.example.com` (no trailing `/api`) |
| API Token (`DBHAWK_TOKEN`) | yes | MCP-scoped personal token (`dbh_…`): DBHawk → User Profile → API Token. Exchanged for a JWT at runtime — paste the personal token as-is, not a JWT |
| Default Datasource (`DBHAWK_DEFAULT_DATASOURCE`) | no | Datasource used when a tool call omits `datasource` |

### Claude Code — guided setup dialog (recommended)

The plugin declares these as `userConfig` fields in `dbhawk/.claude-plugin/plugin.json`, so Claude
Code prompts for them when you enable the plugin — the token field is `sensitive`, so it's masked
on entry and stored in secure storage (OS keychain / `~/.claude/.credentials.json`), **never** in
`settings.json` or git. `dbhawk/.mcp.json` wires them in via `${user_config.dbhawk_token}` etc.

To re-enter or change them later, re-enable the plugin, or set them non-interactively:

```bash
claude plugin install dbhawk@dbhawk-marketplace \
  --config dbhawk_base_url=https://demo.dbhawk.example.com \
  --config dbhawk_token=dbh_... \
  --config dbhawk_default_datasource=
```

### Claude Desktop — environment variables

Desktop doesn't understand plugins or `userConfig` — pass the three values as `env` in the
`claude_desktop_config.json` block shown above.

---

## Tools

| Tool | DBHawk endpoint |
|---|---|
| `list_datasources` | `GET /datasources` |
| `get_datasource` | `GET /datasources/{ds}` |
| `list_schemas` | `GET /datasources/{ds}/schemas` |
| `list_objects` | `GET /datasources/{ds}/schemas/{schema}/objects` |
| `list_columns` | `GET /datasources/{ds}/schemas/{schema}/objects/{object}/columns` |
| `run_query` | `POST /datasources/{ds}/query` (read-only, row-capped 200/5000) |
| `text_to_sql` | `POST /datasources/{ds}/ai/ask` |
| `optimize_sql` | `POST /datasources/{ds}/ai/optimize` |
| `format_sql` | `POST /format-query` |

Demo prompts: *"Which datasources do I have?"* → *"Show tables in schema public of Postgres-Demo"* →
*"What columns does customers have?"* → *"How many orders last month by status?"* (text-to-SQL → run).

---

## For maintainers — publish & rebuild

### Publish the marketplace

```bash
cd dbhawk-mcp-plugin
git init && git add . && git commit -m "DBHawk MCP plugin"
git remote add origin git@github.com:datasparc/dbhawk-mcp-plugin.git
git push -u origin main
```

Users then run the two `/plugin` commands above. To list it in Anthropic's curated
`claude-plugins-official` directory, submit it via the plugin directory submission form (separate
review); your own marketplace works immediately without that.

### Rebuild the bundle (after editing `index.js`)

```bash
cd dbhawk/mcp-server
npm install        # once, pulls the SDK + esbuild (build-time only)
npm run build      # regenerates dist/dbhawk-mcp.mjs
git add dist/dbhawk-mcp.mjs && git commit -m "rebuild bundle"
```

`dist/dbhawk-mcp.mjs` is committed on purpose — it is the artifact users run. `node_modules/` is not.

---

## Troubleshooting

- **`token exchange failed: 401/403`** — the personal `DBHAWK_TOKEN` is wrong, revoked or expired, the
  user isn't in the MCP access group, or (SSO/SAML users) the sign-in re-validation window lapsed — log
  in to DBHawk once via your identity provider, the same token then works again. Reissue if needed.
- **`DBHawk API 401/403`** (after exchange) — wrong scope or the user lacks `ACCESS_TO_DATA`.
- **`Only read-only statements…`** — a write/DDL statement was attempted; expected, MCP is read-only.
- **`Missing configuration`** on startup — `DBHAWK_BASE_URL` / `DBHAWK_TOKEN` not set.
- **Server not listed in `/mcp`** — confirm Node ≥ 18 and that `dist/dbhawk-mcp.mjs` exists in the
  installed plugin. In Claude Desktop, use the full path to `node` (Desktop has a minimal PATH).
