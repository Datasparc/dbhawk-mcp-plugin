/**
 * Calls that get no HTTP response at all (connection reset, DBHawk restarting, nothing listening): the error names
 * the real cause instead of the bare "fetch failed", reads are retried, and a statement that may have run is not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startFakeDbhawk, startClient, textOf } from "./helpers.js";

const FAST_RETRIES = { DBHAWK_RETRY_DELAYS_MS: "10,10,10" };

async function withBridge(handler, body) {
  const fake = await startFakeDbhawk({ handler });
  const client = await startClient(fake.baseUrl, FAST_RETRIES);
  try {
    await body(fake, client);
  } finally {
    await client.close();
    await fake.close();
  }
}

/** Drops the first `n` requests to paths ending with `suffix`, answers the rest with `json`. */
function dropFirst(n, suffix, json) {
  let seen = 0;
  return (call) => (call.path.endsWith(suffix) && ++seen <= n ? { drop: true } : { json });
}

const queryCalls = (fake) => fake.mcpCalls().filter((c) => c.path.endsWith("/query"));

test("run_query recovers when the connection is lost before the answer", async () => {
  await withBridge(dropFirst(2, "/query", { rows: [{ N: 1 }], rowCount: 1, truncated: false }), async (fake, client) => {
    const result = await client.callTool({ name: "run_query", arguments: { query: "SELECT 1 AS N FROM SYSIBM.SYSDUMMY1" } });

    assert.equal(result.isError, undefined, textOf(result));
    assert.deepEqual(JSON.parse(textOf(result)).rows, [{ N: 1 }]);
    assert.equal(queryCalls(fake).length, 3, "two lost attempts, then the answer");
  });
});

test("a read that never gets an answer fails with the cause and the number of attempts", async () => {
  await withBridge(() => ({ drop: true }), async (fake, client) => {
    const result = await client.callTool({ name: "list_datasources", arguments: {} });

    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.match(text, /Network error calling GET .*\/datasources: fetch failed \(.+\)/, text);
    assert.match(text, /\(4 attempts\)/, text);
    assert.equal(fake.mcpCalls().length, 4);
  });
});

test("execute_statement is not retried once the request may have reached DBHawk", async () => {
  await withBridge(() => ({ drop: true }), async (fake, client) => {
    const result = await client.callTool({
      name: "execute_statement",
      arguments: { statement: "INSERT INTO t VALUES (1)", confirm: true },
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /may or may not have executed it/);
    assert.equal(queryCalls(fake).length, 1, "a write that may have run must not be sent twice");
  });
});

test("nothing listening: the error says connection refused", async () => {
  // a port that was just free: nothing accepts connections on it
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const client = await startClient(`http://127.0.0.1:${port}`, FAST_RETRIES);
  try {
    const result = await client.callTool({
      name: "execute_statement",
      arguments: { statement: "INSERT INTO t VALUES (1)", confirm: true },
    });

    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.match(text, /ECONNREFUSED/, text);
    // never connected, so even a write was retried - and the message does not claim it may have run
    assert.match(text, /\(4 attempts\)/, text);
    assert.doesNotMatch(text, /may or may not have executed/);
  } finally {
    await client.close();
  }
});
