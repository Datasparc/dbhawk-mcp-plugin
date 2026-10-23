/**
 * Test harness: a fake DBHawk HTTP server plus the real MCP server bundle (dist/dbhawk-mcp.mjs) driven over stdio
 * by the official MCP client - the tests exercise exactly what users run.
 */
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const BUNDLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "dbhawk-mcp.mjs");
export const PERSONAL_TOKEN = "dbh_abc123.s3cr3t";
export const EXCHANGE_PATH = "/api/v2/auth/token/exchange";
export const MCP = "/api/v2/mcp";

/**
 * Starts a fake DBHawk. Every request is recorded in `calls`. The token exchange answers { jwt: "jwt-<n>" }
 * (n counts exchanges) unless `exchange` overrides it; every other request goes to `handler(call)`, which returns
 * { status?, json?, text? } - the default is 200 { ok: true } - or { drop: true } to close the connection without
 * answering (what a client sees when DBHawk restarts or a proxy resets the connection).
 *
 * @param {object}   [opts]
 * @param {function} [opts.handler]   (call) => response for /api/v2/mcp requests
 * @param {function} [opts.exchange]  (call, n) => response for the token exchange
 */
export async function startFakeDbhawk(opts = {}) {
  const calls = [];
  let exchanges = 0;

  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, "http://fake");
    const call = {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      rawUrl: req.url,
      headers: req.headers,
      body: raw ? JSON.parse(raw) : undefined,
    };
    calls.push(call);

    let response;
    if (call.path === EXCHANGE_PATH) {
      exchanges++;
      response = opts.exchange ? opts.exchange(call, exchanges) : { json: { jwt: `jwt-${exchanges}` } };
    } else {
      response = (opts.handler && opts.handler(call)) || { json: { ok: true } };
    }

    if (response.drop) {
      req.socket.destroy();
      return;
    }

    res.statusCode = response.status || 200;
    if (response.text !== undefined) {
      res.setHeader("Content-Type", "text/plain");
      res.end(response.text);
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(response.json === undefined ? {} : response.json));
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    baseUrl,
    calls,
    /** Calls to the MCP REST surface only (the token exchange filtered out). */
    mcpCalls: () => calls.filter((c) => c.path !== EXCHANGE_PATH),
    exchangeCalls: () => calls.filter((c) => c.path === EXCHANGE_PATH),
    last: () => calls.filter((c) => c.path !== EXCHANGE_PATH).at(-1),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Starts the MCP server bundle against `baseUrl` and connects an MCP client to it.
 *
 * @param {string} baseUrl  fake DBHawk base URL (no trailing /api)
 * @param {object} [env]    extra / overriding environment, e.g. { DBHAWK_DEFAULT_DATASOURCE: "" }
 */
export async function startClient(baseUrl, env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BUNDLE],
    env: {
      DBHAWK_BASE_URL: baseUrl,
      DBHAWK_TOKEN: PERSONAL_TOKEN,
      DBHAWK_DEFAULT_DATASOURCE: "pg-demo",
      ...env,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "dbhawk-mcp-tests", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/** Text of a tool result (the bridge always answers with a single text block). */
export function textOf(result) {
  return result.content.map((c) => c.text).join("\n");
}

/** Parsed JSON of a successful tool result. */
export function jsonOf(result) {
  return JSON.parse(textOf(result));
}
