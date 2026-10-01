/**
 * How DBHawk refusals and bad configuration reach the model / the user.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { startFakeDbhawk, startClient, textOf, BUNDLE } from "./helpers.js";

let fake;
let client;
let noDefault;

const TIER_DENIAL = "This UPDATE statement needs MCP operation(s) update_rows, which your MCP tier 'Read' does not allow.";

before(async () => {
  fake = await startFakeDbhawk({
    handler: (call) => {
      if (call.path.endsWith("/datasources/locked/query")) {
        return { status: 403, json: { status: "FORBIDDEN", message: TIER_DENIAL } };
      }
      if (call.path.endsWith("/datasources/broken/schemas")) {
        return { status: 500, text: "Internal Server Error" };
      }
      return { json: { ok: true } };
    },
  });
  client = await startClient(fake.baseUrl);
  noDefault = await startClient(fake.baseUrl, { DBHAWK_DEFAULT_DATASOURCE: "" });
});

after(async () => {
  await client?.close();
  await noDefault?.close();
  await fake?.close();
});

test("a 403 tier denial becomes an MCP error carrying DBHawk's message", async () => {
  const result = await client.callTool({
    name: "execute_statement",
    arguments: { datasource: "locked", statement: "UPDATE t SET a = 1" },
  });

  assert.equal(result.isError, true);
  assert.match(textOf(result), /DBHawk API 403/);
  assert.ok(textOf(result).includes(TIER_DENIAL), textOf(result));
});

test("a server error is reported, not thrown at the client", async () => {
  const result = await client.callTool({ name: "list_schemas", arguments: { datasource: "broken" } });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /DBHawk API 500/);
});

test("the bridge keeps serving after a failed call", async () => {
  await client.callTool({ name: "list_schemas", arguments: { datasource: "broken" } });
  const result = await client.callTool({ name: "list_datasources", arguments: {} });
  assert.ok(!result.isError);
});

test("no datasource and no default: the model is told to list datasources first", async () => {
  const before = fake.mcpCalls().length;
  const result = await noDefault.callTool({ name: "run_query", arguments: { query: "SELECT 1" } });

  assert.equal(result.isError, true);
  assert.match(textOf(result), /Call list_datasources first/);
  assert.equal(fake.mcpCalls().length, before, "nothing is sent to DBHawk");
});

test("an invalid argument is rejected by the tool schema", async () => {
  const result = await client
    .callTool({ name: "run_query", arguments: { query: "SELECT 1", maxRows: -5 } })
    .catch((e) => ({ isError: true, content: [{ type: "text", text: String(e.message) }] }));
  assert.equal(result.isError, true);
});

test("missing configuration: exits with an error on stderr, stdout stays clean", async () => {
  const child = spawn(process.execPath, [BUNDLE], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise((resolve) => child.on("close", resolve));

  assert.equal(code, 1);
  assert.match(stderr, /Missing configuration/);
  assert.equal(stdout, "", "stdout is the JSON-RPC channel and must stay empty");
});
