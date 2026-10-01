/**
 * Personal token -> JWT exchange: header, caching and the single re-exchange on 401. Every test starts its own
 * server process, since the cached JWT is per process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeDbhawk, startClient, textOf, PERSONAL_TOKEN, EXCHANGE_PATH } from "./helpers.js";

async function withBridge(fakeOpts, body) {
  const fake = await startFakeDbhawk(fakeOpts);
  const client = await startClient(fake.baseUrl);
  try {
    await body(fake, client);
  } finally {
    await client.close();
    await fake.close();
  }
}

const listDatasources = (client) => client.callTool({ name: "list_datasources", arguments: {} });

test("the personal token is exchanged via X-API-Token, never sent as a bearer", async () => {
  await withBridge({}, async (fake, client) => {
    await listDatasources(client);

    const [exchange] = fake.exchangeCalls();
    assert.equal(exchange.method, "POST");
    assert.equal(exchange.path, EXCHANGE_PATH);
    assert.equal(exchange.headers["x-api-token"], PERSONAL_TOKEN);
    assert.equal(exchange.headers.authorization, undefined);

    for (const call of fake.mcpCalls()) {
      assert.equal(call.headers.authorization, "Bearer jwt-1");
      assert.equal(call.headers["x-api-token"], undefined, "the personal token must not reach MCP endpoints");
    }
  });
});

test("no exchange happens before the first tool call", async () => {
  await withBridge({}, async (fake, client) => {
    await client.listTools();
    assert.equal(fake.exchangeCalls().length, 0);
  });
});

test("the JWT is cached across calls", async () => {
  await withBridge({}, async (fake, client) => {
    await listDatasources(client);
    await listDatasources(client);
    await client.callTool({ name: "get_permissions", arguments: {} });

    assert.equal(fake.exchangeCalls().length, 1);
    assert.equal(fake.mcpCalls().length, 3);
  });
});

test("a 401 (expired JWT) triggers one re-exchange and a retry", async () => {
  const handler = (call) =>
    call.headers.authorization === "Bearer jwt-1" ? { status: 401, json: { message: "expired" } } : { json: ["pg-demo"] };

  await withBridge({ handler }, async (fake, client) => {
    const result = await listDatasources(client);

    assert.ok(!result.isError, textOf(result));
    assert.equal(fake.exchangeCalls().length, 2);
    assert.deepEqual(fake.mcpCalls().map((c) => c.headers.authorization), ["Bearer jwt-1", "Bearer jwt-2"]);
  });
});

test("a second 401 is reported, without an endless retry loop", async () => {
  const handler = () => ({ status: 401, json: { message: "access revoked" } });

  await withBridge({ handler }, async (fake, client) => {
    const result = await listDatasources(client);

    assert.equal(result.isError, true);
    assert.match(textOf(result), /DBHawk API 401/);
    assert.match(textOf(result), /access revoked/);
    assert.equal(fake.exchangeCalls().length, 2);
    assert.equal(fake.mcpCalls().length, 2);
  });
});

test("a rejected personal token gives an actionable error", async () => {
  const exchange = () => ({ status: 401, json: { message: "token revoked" } });

  await withBridge({ exchange }, async (fake, client) => {
    const result = await listDatasources(client);

    assert.equal(result.isError, true);
    assert.match(textOf(result), /token exchange failed: 401/);
    assert.match(textOf(result), /User Profile/);
    assert.equal(fake.mcpCalls().length, 0);
  });
});

test("an exchange answer without a jwt is an error", async () => {
  await withBridge({ exchange: () => ({ json: { token: "x" } }) }, async (fake, client) => {
    const result = await listDatasources(client);
    assert.equal(result.isError, true);
    assert.match(textOf(result), /did not contain a jwt/);
  });
});
