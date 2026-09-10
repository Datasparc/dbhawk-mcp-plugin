#!/usr/bin/env node
/**
 * DBHawk MCP server.
 *
 * A thin stdio bridge that exposes the DBHawk "/api/v2/mcp" REST surface as MCP tools, so an AI
 * assistant (Claude Desktop, Claude Code, or any MCP client) can explore data the token owner already
 * has access to. Everything here is read-only by design: the server never sends a write statement, and
 * the DBHawk side rejects one anyway (see ApiV2McpController#query).
 *
 * Configuration comes from the environment so no secret is ever hard-coded:
 *   DBHAWK_BASE_URL           e.g. https://demo.dbhawk.example.com   (required, no trailing /api)
 *   DBHAWK_TOKEN              MCP-scoped personal token from UserProfile -> API Token  (required)
 *   DBHAWK_DEFAULT_DATASOURCE optional; used when a tool call omits "datasource"
 *
 * DBHAWK_TOKEN is a personal token (dbh_<id>.<secret>), NOT a JWT: the MCP endpoints reject it directly,
 * their filter expects a signed JWT. So the server first exchanges the personal token for a short-lived
 * JWT at /api/v2/auth/token/exchange, caches it, and re-exchanges when it expires. See exchangeToken().
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const RAW_BASE_URL = process.env.DBHAWK_BASE_URL;
const TOKEN = process.env.DBHAWK_TOKEN;
const DEFAULT_DATASOURCE = process.env.DBHAWK_DEFAULT_DATASOURCE || "";

if (!RAW_BASE_URL || !TOKEN) {
  // stderr, not stdout: stdout is the JSON-RPC channel and must stay clean.
  console.error(
    "[dbhawk-mcp] Missing configuration. Set DBHAWK_BASE_URL and DBHAWK_TOKEN environment variables."
  );
  process.exit(1);
}

// Normalise: strip a trailing slash. The DispatcherServlet is mapped to /api/* (web.xml), the MCP
// controller lives at /v2/mcp and the token exchange at /v2/auth/token/exchange, so both hang off /api.
const API_ROOT = RAW_BASE_URL.replace(/\/+$/, "") + "/api";
const API_BASE = API_ROOT + "/v2/mcp";
const TOKEN_EXCHANGE_PATH = "/v2/auth/token/exchange";

/**
 * Cached JWT obtained from the personal token. Null until the first call exchanges it, and reset to null
 * so the next call re-exchanges whenever DBHawk answers 401 (the JWT expired after its configured lifetime).
 */
let jwt = null;

/**
 * Exchange the personal API token (DBHAWK_TOKEN, dbh_<id>.<secret>) for a signed JWT. The personal token
 * travels in the X-API-Token header - never as a bearer, the MCP filter would fail to parse it as a JWT.
 * The JWT is cached in the module-level `jwt`.
 */
async function exchangeToken() {
  const url = API_ROOT + TOKEN_EXCHANGE_PATH;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "X-API-Token": TOKEN, Accept: "application/json" },
    });
  } catch (e) {
    throw new Error(`Network error calling POST ${url}: ${e.message}`);
  }

  const payload = await res.text();

  if (!res.ok) {
    // 401 here means the personal token itself is bad/revoked/expired, or the SSO re-validation window lapsed.
    throw new Error(
      `DBHawk token exchange failed: ${res.status} ${res.statusText}` +
        (payload ? `: ${payload.slice(0, 500)}` : "") +
        ". Check DBHAWK_TOKEN is a valid MCP-scoped personal token (DBHawk -> User Profile -> API Token)."
    );
  }

  let body;
  try {
    body = JSON.parse(payload);
  } catch {
    throw new Error(`DBHawk token exchange returned a non-JSON response: ${payload.slice(0, 200)}`);
  }
  if (!body || !body.jwt) {
    throw new Error("DBHawk token exchange response did not contain a jwt field");
  }

  jwt = body.jwt;
  return jwt;
}

/**
 * Single entry point for every REST call. Exchanges the personal token for a JWT on first use, adds it as
 * the bearer, encodes the body, and turns a non-2xx response into a readable error. A 401 triggers exactly
 * one re-exchange and retry, so an expired JWT recovers transparently instead of failing the tool call.
 *
 * @param {string} method  HTTP method
 * @param {string} path    path under /api/v2/mcp, already URL-encoded, starting with "/"
 * @param {object} [opts]
 * @param {object} [opts.body]  JSON request body
 * @param {boolean} [opts.text] when true, return the response body as text (for /format-query)
 */
async function api(method, path, opts = {}) {
  const url = API_BASE + path;

  const send = async () => {
    const headers = { Authorization: `Bearer ${jwt}`, Accept: "application/json" };
    const init = { method, headers };

    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    if (opts.text) {
      headers.Accept = "text/plain";
    }

    try {
      return await fetch(url, init);
    } catch (e) {
      throw new Error(`Network error calling ${method} ${url}: ${e.message}`);
    }
  };

  if (!jwt) {
    await exchangeToken();
  }

  let res = await send();

  // The cached JWT expires after DBHawk's configured token lifetime; on the first 401 exchange the personal
  // token for a fresh JWT and retry once. A second 401 is a real authorization failure and falls through.
  if (res.status === 401) {
    await exchangeToken();
    res = await send();
  }

  const payload = await res.text();

  if (!res.ok) {
    // 401/403 that survives the retry: revoked token, wrong scope, or no ACCESS_TO_DATA.
    throw new Error(
      `DBHawk API ${res.status} ${res.statusText} for ${method} ${path}` +
        (payload ? `: ${payload.slice(0, 500)}` : "")
    );
  }

  if (opts.text) return payload;
  if (!payload) return null;
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

/** Encode one path segment (datasource / schema / object names may contain spaces or punctuation). */
const seg = (s) => encodeURIComponent(String(s));

/** Resolve a datasource argument, falling back to DBHAWK_DEFAULT_DATASOURCE. */
function resolveDatasource(datasource) {
  const ds = datasource || DEFAULT_DATASOURCE;
  if (!ds) {
    throw new Error(
      "No datasource given and DBHAWK_DEFAULT_DATASOURCE is not set. Call list_datasources first."
    );
  }
  return ds;
}

/** Wrap any value as a single text content block, pretty-printing objects as JSON. */
function ok(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}

/** Run a tool handler, converting thrown errors into an MCP error result the model can read. */
function guard(handler) {
  return async (args) => {
    try {
      return await handler(args);
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  };
}

const server = new McpServer({ name: "dbhawk", version: "0.3.0" });

// ---- Discovery -----------------------------------------------------------------------------------

server.tool(
  "list_datasources",
  "List the datasources assigned to the current user. Returns name, dbType, readOnly, requiresDbLogin, aiEnabled.",
  {},
  guard(async () => ok(await api("GET", "/datasources")))
);

server.tool(
  "get_datasource",
  "Get capabilities of one datasource (dbType, readOnly, whether it needs a DB login, whether HawkAI is enabled).",
  { datasource: z.string().describe("Datasource name, e.g. 'Oracle-OVH'") },
  guard(async ({ datasource }) => ok(await api("GET", `/datasources/${seg(resolveDatasource(datasource))}`)))
);

server.tool(
  "list_catalogs",
  "List the catalogs (databases) of a datasource, for DB types that have a catalog level above the schema " +
    "(MSSQL, Snowflake). Returns an empty list for databases with no catalog concept (Oracle, MySQL, MongoDB) " +
    "- for those, skip the catalog argument on list_schemas/list_objects/list_columns.",
  {
    datasource: z.string().optional().describe("Datasource name; defaults to DBHAWK_DEFAULT_DATASOURCE"),
  },
  guard(async ({ datasource }) =>
    ok(await api("GET", `/datasources/${seg(resolveDatasource(datasource))}/catalogs`))
  )
);

server.tool(
  "list_schemas",
  "List the schemas of a datasource.",
  {
    datasource: z.string().optional().describe("Datasource name; defaults to DBHAWK_DEFAULT_DATASOURCE"),
    catalog: z.string().optional().describe("Catalog / database name, if the DB uses one"),
  },
  guard(async ({ datasource, catalog }) => {
    const q = catalog ? `?catalog=${seg(catalog)}` : "";
    return ok(await api("GET", `/datasources/${seg(resolveDatasource(datasource))}/schemas${q}`));
  })
);

server.tool(
  "list_objects",
  "List database objects (tables/views/etc) in a schema. Access control of the calling user applies.",
  {
    datasource: z.string().optional().describe("Datasource name; defaults to DBHAWK_DEFAULT_DATASOURCE"),
    schema: z.string().describe("Schema name"),
    type: z
      .string()
      .optional()
      .describe("JDBC object types, comma separated (e.g. 'TABLE,VIEW'). Defaults to TABLE."),
    catalog: z.string().optional().describe("Catalog / database name, if the DB uses one"),
    query: z.string().optional().describe("Case-insensitive name filter"),
  },
  guard(async ({ datasource, schema, type, catalog, query }) => {
    const params = new URLSearchParams();
    if (type) params.set("type", type);
    if (catalog) params.set("catalog", catalog);
    if (query) params.set("query", query);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return ok(
      await api("GET", `/datasources/${seg(resolveDatasource(datasource))}/schemas/${seg(schema)}/objects${qs}`)
    );
  })
);

server.tool(
  "list_columns",
  "List the columns of a table/view: name, type, nullable.",
  {
    datasource: z.string().optional().describe("Datasource name; defaults to DBHAWK_DEFAULT_DATASOURCE"),
    schema: z.string().describe("Schema name"),
    object: z.string().describe("Table or view name"),
    catalog: z.string().optional().describe("Catalog / database name, if the DB uses one"),
  },
  guard(async ({ datasource, schema, object, catalog }) => {
    const q = catalog ? `?catalog=${seg(catalog)}` : "";
    return ok(
      await api(
        "GET",
        `/datasources/${seg(resolveDatasource(datasource))}/schemas/${seg(schema)}/objects/${seg(object)}/columns${q}`
      )
    );
  })
);

// ---- Querying ------------------------------------------------------------------------------------

server.tool(
  "run_query",
  "Run a READ-ONLY SQL query against a datasource. Writes are rejected. Rows are capped (default 200, " +
    "max 5000); the result reports { rows, rowCount, truncated }. Column masking of the user applies.",
  {
    datasource: z.string().optional().describe("Datasource name; defaults to DBHAWK_DEFAULT_DATASOURCE"),
    query: z.string().describe("A single read-only SQL statement"),
    maxRows: z.number().int().positive().optional().describe("Row cap for this call (<= 5000)"),
    dbUserName: z.string().optional().describe("DB user, only if the datasource requiresDbLogin"),
    dbPassword: z.string().optional().describe("DB password, only if the datasource requiresDbLogin"),
  },
  guard(async ({ datasource, query, maxRows, dbUserName, dbPassword }) => {
    const body = { query };
    if (maxRows !== undefined) body.maxRows = maxRows;
    if (dbUserName !== undefined) body.dbUserName = dbUserName;
    if (dbPassword !== undefined) body.dbPassword = dbPassword;
    return ok(await api("POST", `/datasources/${seg(resolveDatasource(datasource))}/query`, { body }));
  })
);

// ---- HawkAI --------------------------------------------------------------------------------------

server.tool(
  "text_to_sql",
  "HawkAI text-to-SQL: turn a natural-language question into a SQL statement for the datasource. " +
    "Only works when the datasource has aiEnabled=true.",
  {
    datasource: z.string().optional().describe("Datasource name; defaults to DBHAWK_DEFAULT_DATASOURCE"),
    prompt: z.string().describe("The natural-language question"),
    sessionId: z.string().optional().describe("Optional conversation id to keep context across calls"),
  },
  guard(async ({ datasource, prompt, sessionId }) => {
    const body = { prompt };
    if (sessionId !== undefined) body.sessionId = sessionId;
    return ok(await api("POST", `/datasources/${seg(resolveDatasource(datasource))}/ai/ask`, { body }));
  })
);

server.tool(
  "optimize_sql",
  "HawkAI SQL optimization suggestions for a given statement.",
  {
    datasource: z.string().optional().describe("Datasource name; defaults to DBHAWK_DEFAULT_DATASOURCE"),
    sql: z.string().describe("The SQL statement to optimize"),
    schema: z.string().optional().describe("Schema context, if relevant"),
  },
  guard(async ({ datasource, sql, schema }) => {
    const body = { sql };
    if (schema !== undefined) body.schema = schema;
    return ok(await api("POST", `/datasources/${seg(resolveDatasource(datasource))}/ai/optimize`, { body }));
  })
);

server.tool(
  "format_sql",
  "Pretty-print / format a SQL statement.",
  {
    query: z.string().describe("The SQL statement to format"),
    dbDialect: z.string().optional().describe("Optional dialect hint (e.g. ORACLE, MYSQL, POSTGRESQL)"),
  },
  guard(async ({ query, dbDialect }) => {
    const body = { query };
    if (dbDialect !== undefined) body.dbDialect = dbDialect;
    return ok(await api("POST", "/format-query", { body, text: true }));
  })
);

// ---- Boot ----------------------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[dbhawk-mcp] connected. API base: ${API_BASE}`);
