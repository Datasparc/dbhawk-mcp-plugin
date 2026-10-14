/**
 * Agent identity for DBHawk's API log: every request names the MCP client (from the initialize handshake) and the
 * session, so DBHawk can tell which agent made a call. The token stays the proof of who called.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeDbhawk, startClient } from "./helpers.js";

test("every request carries the MCP client, a stable session id and the bridge user agent", async () => {
  const fake = await startFakeDbhawk();
  const client = await startClient(fake.baseUrl);
  try {
    await client.callTool({ name: "list_datasources", arguments: {} });
    await client.callTool({ name: "list_schemas", arguments: {} });

    const sessions = new Set();
    for (const call of fake.calls) {
      assert.equal(call.headers["x-mcp-client"], "dbhawk-mcp-tests/1.0.0", `${call.method} ${call.path}`);
      assert.equal(call.headers["user-agent"], "dbhawk-mcp");
      assert.match(call.headers["x-mcp-session"], /^[0-9a-f-]{36}$/);
      sessions.add(call.headers["x-mcp-session"]);
    }
    assert.equal(sessions.size, 1, "one bridge process = one session id");
  } finally {
    await client.close();
    await fake.close();
  }
});

test("each bridge process gets its own session id", async () => {
  const fake = await startFakeDbhawk();
  try {
    for (let i = 0; i < 2; i++) {
      const client = await startClient(fake.baseUrl);
      try {
        await client.callTool({ name: "list_datasources", arguments: {} });
      } finally {
        await client.close();
      }
    }
    const ids = new Set(fake.mcpCalls().map((c) => c.headers["x-mcp-session"]));
    assert.equal(ids.size, 2);
  } finally {
    await fake.close();
  }
});
