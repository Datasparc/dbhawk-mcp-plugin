/**
 * Without DBHAWK_TOKEN the bridge signs in to DBHawk through the browser (OAuth 2.1 + PKCE, oauth.js). A fake DBHawk
 * plays the authorization server; the test plays the browser: it reads the authorize URL the bridge logs (no real
 * browser: DBHAWK_BROWSER=none) and follows it, which redirects to the bridge's loopback listener like DBHawk does
 * after the user clicked Allow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BUNDLE, textOf } from "./helpers.js";

/** A fake DBHawk with the OAuth endpoints of the MCP connector and one MCP endpoint (GET /datasources). */
async function startFakeAuthServer(opts = {}) {
  const state = { registrations: 0, authorizations: 0, refreshes: 0, codes: new Map(), access: null, refresh: null, n: 0, calls: [] };

  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, "http://fake");
    state.calls.push({ method: req.method, path: url.pathname, headers: req.headers });
    const json = (status, body) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    const issue = () => {
      state.n++;
      state.access = `at-${state.n}`;
      state.refresh = `dbhr_g.rt-${state.n}`;
      return { access_token: state.access, token_type: "Bearer", expires_in: 3600, refresh_token: state.refresh, scope: "mcp" };
    };

    if (url.pathname === "/api/oauth/register") {
      if (opts.noOAuth) return json(404, { error: "not found" });
      state.registrations++;
      const body = JSON.parse(raw);
      state.registeredRedirect = body.redirect_uris[0];
      return json(201, { client_id: "client-1", token_endpoint_auth_method: "none" });
    }
    if (url.pathname === "/api/oauth/authorize") {
      state.authorizations++;
      const p = url.searchParams;
      assert.equal(p.get("client_id"), "client-1");
      assert.equal(p.get("code_challenge_method"), "S256");
      assert.match(p.get("redirect_uri"), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      const back = new URL(p.get("redirect_uri"));
      back.searchParams.set("state", p.get("state"));
      if (opts.deny) {
        back.searchParams.set("error", "access_denied");
        back.searchParams.set("error_description", "The user denied the request");
      } else {
        const code = `code-${state.authorizations}`;
        state.codes.set(code, { challenge: p.get("code_challenge"), redirect: p.get("redirect_uri") });
        back.searchParams.set("code", code);
      }
      res.statusCode = 303;
      res.setHeader("Location", back.toString());
      return res.end();
    }
    if (url.pathname === "/api/oauth/token") {
      const form = new URLSearchParams(raw);
      if (form.get("grant_type") === "authorization_code") {
        const entry = state.codes.get(form.get("code"));
        state.codes.delete(form.get("code"));
        const challenge = createHash("sha256").update(form.get("code_verifier") || "").digest("base64url");
        if (!entry || entry.challenge !== challenge || entry.redirect !== form.get("redirect_uri")) {
          return json(400, { error: "invalid_grant", error_description: "bad code" });
        }
        return json(200, issue());
      }
      if (form.get("grant_type") === "refresh_token") {
        state.refreshes++;
        if (opts.rejectRefresh || form.get("refresh_token") !== state.refresh) {
          return json(400, { error: "invalid_grant", error_description: "The refresh token is invalid, revoked or expired" });
        }
        return json(200, issue());
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/api/v2/mcp/datasources") {
      if (opts.expireAccess && state.calls.filter((c) => c.path === "/api/v2/mcp/datasources").length === 2) {
        state.access = null; // DBHawk revoked / expired the access token: the next call gets 401
      }
      if (!state.access || req.headers.authorization !== `Bearer ${state.access}`) {
        return json(401, { message: "JWT token is expired or invalid" });
      }
      return json(200, [{ name: "pg-demo" }]);
    }
    if (url.pathname === "/api/v2/auth/token/exchange") {
      return json(500, { message: "the personal token exchange must not be used in browser sign-in mode" });
    }
    return json(404, {});
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, state, close: () => new Promise((r) => server.close(r)) };
}

/** Starts the bridge without a personal token and returns the client plus a "browser" that follows the sign-in URL. */
async function startBridge(baseUrl, storeDir, env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BUNDLE],
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      DBHAWK_BASE_URL: baseUrl,
      DBHAWK_OAUTH_STORE_DIR: storeDir,
      DBHAWK_BROWSER: "none",
      DBHAWK_OAUTH_WAIT_MS: "10000",
      ...env,
    },
    stderr: "pipe",
  });
  let stderr = "";
  const waiters = [];
  transport.stderr.on("data", (d) => {
    stderr += d;
    for (const w of waiters.splice(0)) w();
  });
  const client = new Client({ name: "dbhawk-oauth-tests", version: "1.0.0" });
  await client.connect(transport);

  /** Waits for the n-th authorize URL the bridge logs, then "approves" it in the browser. */
  async function approve(n = 1) {
    for (;;) {
      const urls = [...stderr.matchAll(/sign in at (\S+)/g)].map((m) => m[1]);
      if (urls.length >= n) {
        const res = await fetch(urls[n - 1]); // follows the 303 to the loopback listener
        return res.text();
      }
      await new Promise((resolve) => waiters.push(resolve));
    }
  }
  return { client, approve, stderr: () => stderr };
}

const tempStore = () => fs.mkdtempSync(path.join(os.tmpdir(), "dbhawk-oauth-test-"));
const listDatasources = (client) => client.callTool({ name: "list_datasources", arguments: {} });

test("no token: the first call signs in through the browser, then calls DBHawk with the access token", async () => {
  const fake = await startFakeAuthServer();
  const store = tempStore();
  const bridge = await startBridge(fake.baseUrl, store);
  try {
    const [result, page] = await Promise.all([listDatasources(bridge.client), bridge.approve()]);

    assert.equal(result.isError, undefined, textOf(result));
    assert.match(textOf(result), /pg-demo/);
    assert.match(page, /DBHawk is connected/);
    assert.equal(fake.state.registrations, 1);
    assert.equal(fake.state.registeredRedirect, "http://127.0.0.1/callback", "loopback registered without a port");
    const mcp = fake.state.calls.filter((c) => c.path === "/api/v2/mcp/datasources");
    assert.equal(mcp.at(-1).headers.authorization, "Bearer at-1");

    const files = fs.readdirSync(store);
    assert.equal(files.length, 1);
    const saved = JSON.parse(fs.readFileSync(path.join(store, files[0]), "utf8"));
    assert.equal(saved.clientId, "client-1");
    assert.equal(saved.refreshToken, "dbhr_g.rt-1");
    assert.equal(saved.accessToken, undefined, "the access token is never written to disk");

    // cached: no new sign-in for the next call
    await listDatasources(bridge.client);
    assert.equal(fake.state.authorizations, 1);
  } finally {
    await bridge.client.close();
    await fake.close();
  }
});

test("a restarted bridge uses the stored refresh token: no browser", async () => {
  const fake = await startFakeAuthServer();
  const store = tempStore();
  const first = await startBridge(fake.baseUrl, store);
  await Promise.all([listDatasources(first.client), first.approve()]);
  await first.client.close();

  const second = await startBridge(fake.baseUrl, store);
  try {
    const result = await listDatasources(second.client);
    assert.match(textOf(result), /pg-demo/);
    assert.equal(fake.state.authorizations, 1, "no second browser sign-in");
    assert.equal(fake.state.registrations, 1, "the client registration is reused");
    assert.equal(fake.state.refreshes, 1);
    const saved = JSON.parse(fs.readFileSync(path.join(store, fs.readdirSync(store)[0]), "utf8"));
    assert.equal(saved.refreshToken, "dbhr_g.rt-2", "the rotated refresh token is stored");
  } finally {
    await second.client.close();
    await fake.close();
  }
});

test("a 401 refreshes the access token and retries once", async () => {
  const fake = await startFakeAuthServer({ expireAccess: true });
  const bridge = await startBridge(fake.baseUrl, tempStore());
  try {
    await Promise.all([listDatasources(bridge.client), bridge.approve()]);
    const result = await listDatasources(bridge.client);

    assert.match(textOf(result), /pg-demo/);
    assert.equal(fake.state.refreshes, 1);
    assert.equal(fake.state.authorizations, 1);
  } finally {
    await bridge.client.close();
    await fake.close();
  }
});

test("a refresh token DBHawk no longer accepts leads to a new browser sign-in", async () => {
  const fake = await startFakeAuthServer({ rejectRefresh: true });
  const store = tempStore();
  const first = await startBridge(fake.baseUrl, store);
  await Promise.all([listDatasources(first.client), first.approve()]);
  await first.client.close();

  const second = await startBridge(fake.baseUrl, store);
  try {
    const [result] = await Promise.all([listDatasources(second.client), second.approve()]);
    assert.match(textOf(result), /pg-demo/);
    assert.equal(fake.state.authorizations, 2);
  } finally {
    await second.client.close();
    await fake.close();
  }
});

test("a sign-in not finished in time: the call says so, the next call completes it without a second window", async () => {
  const fake = await startFakeAuthServer();
  const bridge = await startBridge(fake.baseUrl, tempStore(), { DBHAWK_OAUTH_WAIT_MS: "300" });
  try {
    const first = await listDatasources(bridge.client);
    assert.equal(first.isError, true);
    assert.match(textOf(first), /Sign in to DBHawk in the browser/);
    assert.match(textOf(first), /\/api\/oauth\/authorize\?/);

    await bridge.approve(); // the user finishes signing in afterwards
    const second = await listDatasources(bridge.client);
    assert.match(textOf(second), /pg-demo/);
    assert.equal(fake.state.authorizations, 1);
    assert.equal([...bridge.stderr().matchAll(/sign in at /g)].length, 1, "one browser sign-in only");
  } finally {
    await bridge.client.close();
    await fake.close();
  }
});

test("a denied sign-in is reported to the model", async () => {
  const fake = await startFakeAuthServer({ deny: true });
  const bridge = await startBridge(fake.baseUrl, tempStore());
  try {
    const [result, page] = await Promise.all([listDatasources(bridge.client), bridge.approve()]);
    assert.equal(result.isError, true);
    assert.match(textOf(result), /not completed: The user denied the request/);
    assert.match(page, /DBHawk was not connected/);
  } finally {
    await bridge.client.close();
    await fake.close();
  }
});

test("a DBHawk without the OAuth server: the model is told to configure a personal token", async () => {
  const fake = await startFakeAuthServer({ noOAuth: true });
  const bridge = await startBridge(fake.baseUrl, tempStore());
  try {
    const result = await listDatasources(bridge.client);
    assert.equal(result.isError, true);
    assert.match(textOf(result), /personal MCP token/);
  } finally {
    await bridge.client.close();
    await fake.close();
  }
});

test("an unexpanded optional-setting placeholder counts as no token", async () => {
  const fake = await startFakeAuthServer();
  const bridge = await startBridge(fake.baseUrl, tempStore(), { DBHAWK_TOKEN: "${user_config.dbhawk_token}" });
  try {
    const [result] = await Promise.all([listDatasources(bridge.client), bridge.approve()]);
    assert.match(textOf(result), /pg-demo/);
    assert.equal(fake.state.calls.filter((c) => c.path === "/api/v2/auth/token/exchange").length, 0);
  } finally {
    await bridge.client.close();
    await fake.close();
  }
});
