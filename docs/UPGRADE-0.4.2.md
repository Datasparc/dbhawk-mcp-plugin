# Upgrading the DBHawk MCP plugin to 0.4.2

Version 0.4.2 of the DBHawk MCP server (Claude Code plugin `dbhawk`, Claude Desktop extension `dbhawk-0.4.2.mcpb`,
npm package `@dbhawk/mcp`) tells DBHawk **which agent made each call**. Tools and configuration are unchanged.

Every request now carries:

| Header | Content |
|---|---|
| `X-MCP-Client` | the MCP client's `name/version` from the MCP handshake, e.g. `claude-code/2.1.4` |
| `X-MCP-Session` | a random id per server process - groups the calls of one session |
| `User-Agent` | `dbhawk-mcp` |

DBHawk writes them to the API log as `McpClient` / `McpSession` (columns `mcp_client` / `mcp_session` of
`dbhawk_api_log`). The client name is self-reported, so it labels the agent; the token remains what identifies
the caller. A DBHawk server without this change ignores the headers, and older plugins are logged by their
`User-Agent` (`node`).

Upgrade the same way as 0.4.1 - see [UPGRADE-0.4.1.md](UPGRADE-0.4.1.md) (Claude Code: `claude plugin update`;
Claude Desktop: install `dbhawk-0.4.2.mcpb`; npx: `@dbhawk/mcp@0.4.2`).

---

## For maintainers - releasing 0.4.2

All versions read `0.4.2` (CI checks them).

```bash
cd dbhawk/mcp-server && npm ci && npm test && cd ../..         # builds dist/ and runs the tests
cp dbhawk/mcp-server/dist/dbhawk-mcp.mjs mcpb/server/dbhawk-mcp.mjs
npx @anthropic-ai/mcpb pack mcpb dbhawk-0.4.2.mcpb
git add -A && git commit -m "Release 0.4.2: report the MCP client and session to DBHawk's API log" && git push

gh release create 0.4.2 dbhawk-0.4.2.mcpb --title "DBHawk 0.4.2" \
  --notes "Every request names the MCP client (X-MCP-Client) and session (X-MCP-Session) for DBHawk's API log. See docs/UPGRADE-0.4.2.md"

cd dbhawk/mcp-server && npm publish --access public                # @dbhawk/mcp
cd ../.. && mcp-publisher publish                                  # MCP registry entry from server.json
```
