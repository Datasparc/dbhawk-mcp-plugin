# @dbhawk/mcp

MCP server for [DBHawk](https://www.datasparc.com). It gives an AI assistant (Claude, VS Code, Cursor, or any MCP client) **read-only** access to the databases you already use in DBHawk: list your datasources, browse schemas, tables and columns, run read-only queries, and use HawkAI text-to-SQL.

All of DBHawk's access control and column masking apply. DBHawk rejects any statement that modifies data or schema, whatever your role.

## Requirements

- Node.js 18 or later
- A DBHawk server with the MCP API enabled
- An MCP API token: DBHawk → User Profile → API Token (your user needs `ACCESS_TO_DATA`)

## Configuration

| Variable | Required | Description |
|---|---|---|
| `DBHAWK_BASE_URL` | yes | Your DBHawk URL, e.g. `https://dbhawk.example.com` (no trailing `/api`) |
| `DBHAWK_TOKEN` | yes | Your personal MCP token (`dbh_…`) |
| `DBHAWK_DEFAULT_DATASOURCE` | no | Datasource to use when a request doesn't name one |

## Setup

### Claude Code

```bash
claude mcp add dbhawk \
  -e DBHAWK_BASE_URL=https://dbhawk.example.com \
  -e DBHAWK_TOKEN=dbh_your_token \
  -- npx -y @dbhawk/mcp
```

### Claude Desktop and other MCP clients

Add this to your client's MCP configuration (for Claude Desktop, `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "dbhawk": {
      "command": "npx",
      "args": ["-y", "@dbhawk/mcp"],
      "env": {
        "DBHAWK_BASE_URL": "https://dbhawk.example.com",
        "DBHAWK_TOKEN": "dbh_your_token"
      }
    }
  }
}
```

Claude Desktop users can also install the one-click extension from the [releases page](https://github.com/Datasparc/dbhawk-mcp-plugin/releases).

## Tools

| Tool | What it does |
|---|---|
| `list_datasources` | Datasources assigned to you |
| `get_datasource` | Capabilities of one datasource |
| `list_catalogs` | Catalogs/databases (MSSQL, Snowflake) |
| `list_schemas` | Schemas of a datasource |
| `list_objects` | Tables, views and other objects in a schema |
| `list_columns` | Columns of a table or view |
| `run_query` | Run a read-only query (row-capped) |
| `text_to_sql` | HawkAI: turn a question into SQL |
| `optimize_sql` | HawkAI: suggestions to speed up a query |
| `format_sql` | Pretty-print a SQL statement |

## More

Full documentation and troubleshooting: [github.com/Datasparc/dbhawk-mcp-plugin](https://github.com/Datasparc/dbhawk-mcp-plugin)
