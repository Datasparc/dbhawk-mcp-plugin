#!/usr/bin/env node
/**
 * DBHawk MCP server.
 *
 * A thin stdio bridge that exposes the DBHawk "/api/v2/mcp" REST surface as MCP tools, so an AI
 * assistant (Claude Desktop, Claude Code, or any MCP client) can work with data the token owner already
 * has access to. What it may do is decided by DBHawk, not here: the MCP tier of the user's groups lists the
 * allowed operations (the default tier is read-only), see get_permissions.
 *
 * Reads and writes are separate tools so the MCP client can treat them differently: run_query is annotated
 * read-only and sends readOnly=true, so DBHawk refuses a write through it even when the tier allows one;
 * execute_statement is annotated destructive, so the client asks the user before running it, and DBHawk
 * additionally holds a write back ({ confirmationRequired: true }) until it is repeated with confirm=true
 * when the tier asks for confirmation. Database credentials never pass through this bridge.
 *
 * Configuration comes from the environment so no secret is ever hard-coded:
 *   DBHAWK_BASE_URL           e.g. https://demo.dbhawk.example.com   (required, no trailing /api)
 *   DBHAWK_TOKEN              optional: MCP-scoped personal token from UserProfile -> API Token
 *   DBHAWK_DEFAULT_DATASOURCE optional; used when a tool call omits "datasource"
 *
 * Without DBHAWK_TOKEN the bridge signs in to DBHawk itself (oauth.js): on the first tool call it opens the browser
 * on the DBHawk sign-in - password, LDAP, 2FA or SSO, as on the DBHawk login page - and keeps the refresh token for
 * the next start. Needs DBHawk 7.0.1 with the MCP connector (OAuth authorization server).
 *
 * DBHAWK_TOKEN is a personal token (dbh_<id>.<secret>), NOT a JWT: the MCP endpoints reject it directly,
 * their filter expects a signed JWT. So the server first exchanges the personal token for a short-lived
 * JWT at /api/v2/auth/token/exchange, caches it, and re-exchanges when it expires. See exchangeToken().
 */

import { randomUUID } from "node:crypto";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createOAuthSession } from "./oauth.js";

const RAW_BASE_URL = (process.env.DBHAWK_BASE_URL || "").trim();
// an optional setting left empty may arrive as the unexpanded "${user_config...}" placeholder: treat it as unset
const unsetIfPlaceholder = (value) => (/^\$\{[^}]*\}$/.test(value) ? "" : value);
const TOKEN = unsetIfPlaceholder((process.env.DBHAWK_TOKEN || "").trim());
const DEFAULT_DATASOURCE = (process.env.DBHAWK_DEFAULT_DATASOURCE || "").trim();

/** Print a configuration problem and stop. stderr, not stdout: stdout is the JSON-RPC channel and must stay clean. */
function configError(message) {
  console.error(`[dbhawk-mcp] ${message}`);
  process.exit(1);
}

if (!RAW_BASE_URL) {
  configError("Missing configuration. Set the DBHAWK_BASE_URL environment variable (and DBHAWK_TOKEN unless you sign in through the browser).");
}

let baseUrl;
try {
  baseUrl = new URL(RAW_BASE_URL);
} catch {
  configError(`Invalid configuration: DBHAWK_BASE_URL "${RAW_BASE_URL}" is not a valid URL (e.g. https://dbhawk.example.com).`);
}
if (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") {
  configError(`Invalid configuration: DBHAWK_BASE_URL must use https:// (or http://), got "${baseUrl.protocol}".`);
}
if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
  configError("Invalid configuration: DBHAWK_BASE_URL must not contain credentials, a query string or a fragment.");
}
if (/\/api\/?$/.test(baseUrl.pathname)) {
  configError("Invalid configuration: DBHAWK_BASE_URL must be the DBHawk base URL without the trailing /api.");
}
// A JWT (three base64url parts, header starting "eyJ") is the most common paste mistake: the server needs the
// personal token it exchanges for a JWT, not a JWT itself.
if (/^eyJ[\w-]*\.[\w-]+\.[\w-]*$/.test(TOKEN)) {
  configError("Invalid configuration: DBHAWK_TOKEN looks like a JWT. Use the MCP-scoped personal token (dbh_...) from DBHawk -> User Profile -> API Token.");
}
if (/\s/.test(TOKEN)) {
  configError("Invalid configuration: DBHAWK_TOKEN must not contain whitespace.");
}
if (baseUrl.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname)) {
  console.error("[dbhawk-mcp] Warning: DBHAWK_BASE_URL uses plain http://, so tokens travel unencrypted. Use https://.");
}

// Normalise: strip a trailing slash. The DispatcherServlet is mapped to /api/* (web.xml), the MCP
// controller lives at /v2/mcp and the token exchange at /v2/auth/token/exchange, so both hang off /api.
const API_ROOT = RAW_BASE_URL.replace(/\/+$/, "") + "/api";
const API_BASE = API_ROOT + "/v2/mcp";
const TOKEN_EXCHANGE_PATH = "/v2/auth/token/exchange";

/** Signed in through the browser (OAuth) when no personal token is configured; null in personal-token mode. */
const oauth = TOKEN
  ? null
  : createOAuthSession({
      apiRoot: API_ROOT,
      headers: () => clientHeaders(),
      log: (message) => console.error(`[dbhawk-mcp] ${message}`),
      clientName: `DBHawk extension (${os.hostname()})`,
    });

/**
 * Cached JWT obtained from the personal token. Null until the first call exchanges it, and reset to null
 * so the next call re-exchanges whenever DBHawk answers 401 (the JWT expired after its configured lifetime).
 */
let jwt = null;

/**
 * When the cached JWT expires (ms since epoch, from its "exp" claim), or 0 when unknown. A JWT this close to
 * expiry is re-exchanged before the call instead of spending a round trip on a 401.
 */
let jwtExpiresAt = 0;
const JWT_EXPIRY_SKEW_MS = 30_000;

/** Id of this MCP session: over stdio one bridge process serves exactly one client connection. */
const SESSION_ID = randomUUID();

/**
 * Who is calling, for DBHawk's API log (McpClient / McpSession): the MCP client's name/version from the initialize
 * handshake (e.g. claude-code/2.1.4) and this session's id. The client name is self-reported - DBHawk attributes the
 * call to the token; this only labels which agent used it. Header values must be visible ASCII, so anything else is
 * dropped. X-MCP-Client is left out until the handshake has told us the client.
 */
function clientHeaders() {
  const headers = { "User-Agent": "dbhawk-mcp", "X-MCP-Session": SESSION_ID };
  const info = server.server.getClientVersion();
  if (info && info.name) {
    const label = (info.version ? `${info.name}/${info.version}` : info.name).replace(/[^\x20-\x7e]/g, "").trim();
    if (label) headers["X-MCP-Client"] = label.slice(0, 200);
  }
  return headers;
}

/** Read the "exp" claim of a JWT without verifying it (DBHawk verifies); 0 when absent or unreadable. */
function jwtExpiry(token) {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof claims.exp === "number" ? claims.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/** True when there is no cached JWT or it is about to expire. */
const jwtNeedsExchange = () => !jwt || (jwtExpiresAt > 0 && Date.now() >= jwtExpiresAt - JWT_EXPIRY_SKEW_MS);

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
      headers: { ...clientHeaders(), "X-API-Token": TOKEN, Accept: "application/json" },
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
  jwtExpiresAt = jwtExpiry(jwt);
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
    const bearer = oauth ? await oauth.accessToken() : jwt;
    const headers = { ...clientHeaders(), Authorization: `Bearer ${bearer}`, Accept: "application/json" };
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

  if (!oauth && jwtNeedsExchange()) {
    await exchangeToken();
  }

  let res = await send();

  // A JWT known to be expiring is replaced above; a 401 can still come from clock skew, a revoked session or a
  // DBHawk restart, so exchange the personal token for a fresh JWT and retry once. A second 401 is a real
  // authorization failure (the fresh JWT was refused too) and falls through - retrying again would not help.
  // Signed in through the browser: the access token is refreshed with the stored refresh token instead (and if
  // that is no longer valid either, the next call starts a new browser sign-in).
  let retried = false;
  if (res.status === 401) {
    if (oauth) {
      oauth.invalidate();
    } else {
      await exchangeToken();
    }
    res = await send();
    retried = true;
  }

  const payload = await res.text();

  if (!res.ok) {
    // 401/403 that survives the retry: revoked token, wrong scope, or no ACCESS_TO_DATA.
    const hint =
      !retried || res.status !== 401
        ? ""
        : oauth
          ? ". Still 401 after refreshing the DBHawk sign-in and retrying once (no further retries)" +
            " - the sign-in was likely revoked, or the user lost MCP access. The next call starts a new browser sign-in."
          : ". Still 401 after exchanging DBHAWK_TOKEN for a fresh JWT and retrying once (no further retries)" +
            " - the token or session was likely revoked, or the user lost MCP access. Reissue the token in DBHawk" +
            " -> User Profile -> API Token.";
    if (hint) {
      console.error(`[dbhawk-mcp] ${method} ${path} refused with 401 after re-exchange and one retry.`);
    }
    throw new Error(
      `DBHawk API ${res.status} ${res.statusText} for ${method} ${path}` +
        (payload ? `: ${payload.slice(0, 500)}` : "") +
        hint
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

const server = new McpServer({ name: "dbhawk", version: "7.1.0" });

/**
 * Tool annotations tell the MCP client how risky a tool is. Clients typically let read-only tools run without
 * asking and prompt the user before a destructive one - which is the human approval for DBHawk writes.
 * Every DBHawk call reaches the user's own DBHawk server only, so none of them is "open world".
 */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const datasourceArg = z.string().optional().describe("Datasource name; defaults to DBHAWK_DEFAULT_DATASOURCE");

// ---- Discovery -----------------------------------------------------------------------------------

server.registerTool(
  "get_permissions",
  {
    title: "Get MCP permissions",
    description:
      "What the current user may do over MCP: their MCP tier(s), the allowed operations (with the SQL keywords " +
      "that classify a statement as each operation), the row cap, and which operations need the user's " +
      "confirmation. Call this before writing SQL that changes data or schema.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  guard(async () => ok(await api("GET", "/permissions")))
);

server.registerTool(
  "list_datasources",
  {
    title: "List datasources",
    description:
      "List the datasources assigned to the current user. Returns name, dbType, readOnly, requiresDbLogin, aiEnabled.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  guard(async () => ok(await api("GET", "/datasources")))
);

server.registerTool(
  "get_datasource",
  {
    title: "Get datasource",
    description:
      "Get capabilities of one datasource (dbType, readOnly, whether it needs a DB login, whether DBHawk AI is enabled).",
    inputSchema: { datasource: z.string().describe("Datasource name, e.g. 'Oracle-OVH'") },
    annotations: READ_ONLY,
  },
  guard(async ({ datasource }) => ok(await api("GET", `/datasources/${seg(resolveDatasource(datasource))}`)))
);

server.registerTool(
  "list_catalogs",
  {
    title: "List catalogs",
    description:
      "List the catalogs (databases) of a datasource, for DB types that have a catalog level above the schema " +
      "(MSSQL, Snowflake). Returns an empty list for databases with no catalog concept (Oracle, MySQL, MongoDB) " +
      "- for those, skip the catalog argument on list_schemas/list_objects/list_columns.",
    inputSchema: { datasource: datasourceArg },
    annotations: READ_ONLY,
  },
  guard(async ({ datasource }) => ok(await api("GET", `/datasources/${seg(resolveDatasource(datasource))}/catalogs`)))
);

server.registerTool(
  "list_schemas",
  {
    title: "List schemas",
    description: "List the schemas of a datasource.",
    inputSchema: {
      datasource: datasourceArg,
      catalog: z.string().optional().describe("Catalog / database name, if the DB uses one"),
    },
    annotations: READ_ONLY,
  },
  guard(async ({ datasource, catalog }) => {
    const q = catalog ? `?catalog=${seg(catalog)}` : "";
    return ok(await api("GET", `/datasources/${seg(resolveDatasource(datasource))}/schemas${q}`));
  })
);

server.registerTool(
  "list_objects",
  {
    title: "List objects",
    description: "List database objects (tables/views/etc) in a schema. Access control of the calling user applies.",
    inputSchema: {
      datasource: datasourceArg,
      schema: z.string().describe("Schema name"),
      type: z.string().optional().describe("JDBC object types, comma separated (e.g. 'TABLE,VIEW'). Defaults to TABLE."),
      catalog: z.string().optional().describe("Catalog / database name, if the DB uses one"),
      query: z.string().optional().describe("Case-insensitive name filter"),
    },
    annotations: READ_ONLY,
  },
  guard(async ({ datasource, schema, type, catalog, query }) => {
    const params = new URLSearchParams();
    if (type) params.set("type", type);
    if (catalog) params.set("catalog", catalog);
    if (query) params.set("query", query);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return ok(await api("GET", `/datasources/${seg(resolveDatasource(datasource))}/schemas/${seg(schema)}/objects${qs}`));
  })
);

server.registerTool(
  "list_columns",
  {
    title: "List columns",
    description: "List the columns of a table/view: name, type, nullable.",
    inputSchema: {
      datasource: datasourceArg,
      schema: z.string().describe("Schema name"),
      object: z.string().describe("Table or view name"),
      catalog: z.string().optional().describe("Catalog / database name, if the DB uses one"),
    },
    annotations: READ_ONLY,
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

server.registerTool(
  "run_query",
  {
    title: "Run read-only query",
    description:
      "Run a READ-ONLY SQL statement (SELECT, WITH, SHOW ...) against a datasource. For execution plans use " +
      "explain_plan instead. " +
      "Anything that changes data or schema is refused here - use execute_statement for that. Rows are capped " +
      "(default 200, the MCP tier may lower the max of 5000); the result reports { rows, rowCount, truncated }. " +
      "Access control and column masking of the user apply.",
    inputSchema: {
      datasource: datasourceArg,
      query: z.string().describe("A single read-only SQL statement"),
      maxRows: z.number().int().positive().optional().describe("Row cap for this call (<= 5000)"),
    },
    annotations: READ_ONLY,
  },
  guard(async ({ datasource, query, maxRows }) => {
    // readOnly makes DBHawk refuse a write even when the user's MCP tier would allow it: this tool is
    // declared read-only, so the client may run it without asking the user.
    const body = { query, readOnly: true };
    if (maxRows !== undefined) body.maxRows = maxRows;
    return ok(await api("POST", `/datasources/${seg(resolveDatasource(datasource))}/query`, { body }));
  })
);

server.registerTool(
  "explain_plan",
  {
    title: "Explain plan",
    description:
      "Show the execution plan of ONE SQL statement. DBHawk builds and reads the plan in a single call on one " +
      "database connection (Oracle EXPLAIN PLAN + DBMS_XPLAN, SQL Server SHOWPLAN, EXPLAIN on PostgreSQL, MySQL, " +
      "Snowflake, Redshift ...), and never executes the statement. Send the plain statement, without EXPLAIN. " +
      "Use this tool for plans: do NOT run EXPLAIN PLAN FOR and DBMS_XPLAN.DISPLAY through run_query - every " +
      "call uses its own connection, so the plan is lost between the two calls. Returns planText (single-column " +
      "plans) and the plan rows. Needs the explain_plan operation in the user's MCP tier, plus the statement's own " +
      "operation (a plan of a DELETE needs delete_rows) - see get_permissions.",
    inputSchema: {
      datasource: datasourceArg,
      query: z.string().describe("The single SQL statement to explain, e.g. SELECT * FROM orders WHERE id = 1"),
    },
    annotations: READ_ONLY,
  },
  guard(async ({ datasource, query }) =>
    ok(await api("POST", `/datasources/${seg(resolveDatasource(datasource))}/explain`, { body: { query } }))
  )
);

server.registerTool(
  "execute_statement",
  {
    title: "Execute data / schema change",
    description:
      "Execute ONE SQL statement that changes data or schema (INSERT, UPDATE, DELETE, MERGE, CREATE, ALTER, " +
      "DROP...). Only works when the user's MCP tier allows that operation - see get_permissions. " +
      "Workflow: 1) show the exact statement to the user; 2) call this tool without confirm - if the tier " +
      "requires confirmation, DBHawk returns { confirmationRequired: true, executed: false } and runs nothing; " +
      "3) only after the user explicitly approves THIS statement, call again with the same statement and " +
      "confirm=true. Never set confirm=true on your own initiative. Returns the affected row count.",
    inputSchema: {
      datasource: datasourceArg,
      statement: z.string().describe("A single SQL statement that changes data or schema"),
      confirm: z
        .boolean()
        .optional()
        .describe("true only after the user explicitly approved this exact statement"),
    },
    annotations: WRITE,
  },
  guard(async ({ datasource, statement, confirm }) => {
    const body = { query: statement };
    if (confirm === true) body.confirm = true;
    return ok(await api("POST", `/datasources/${seg(resolveDatasource(datasource))}/query`, { body }));
  })
);

// ---- Sessions ------------------------------------------------------------------------------------

server.registerTool(
  "list_sessions",
  {
    title: "List database sessions",
    description:
      "List the active sessions of the datasource's database: sessionId, user, status, program, machine, logonTime, " +
      "secondsInCall and the current SQL (first 200 characters; omitted when DBHawk does not share data with AI " +
      "models). The same sessions DBHawk's Session Manager shows. Works for Oracle, SQL Server, PostgreSQL, Redshift " +
      "and MySQL / MariaDB. Needs the active_sessions operation in the user's MCP tier - see get_permissions.",
    inputSchema: { datasource: datasourceArg },
    annotations: { ...READ_ONLY, idempotentHint: false },
  },
  guard(async ({ datasource }) => ok(await api("GET", `/datasources/${seg(resolveDatasource(datasource))}/sessions`)))
);

server.registerTool(
  "kill_session",
  {
    title: "End a database session",
    description:
      "End ONE database session, by a sessionId returned by list_sessions (Oracle: 'sid,serial#', e.g. '123,4567'; " +
      "other databases: a number). Its open transaction is rolled back. DBHawk builds the command itself - do not " +
      "send KILL / ALTER SYSTEM statements through execute_statement for this. Workflow: 1) show the session (user, " +
      "program, SQL) to the user; 2) call without confirm - if the tier requires confirmation DBHawk returns " +
      "{ confirmationRequired: true, executed: false, session } and ends nothing; 3) only after the user explicitly " +
      "approves ending THIS session, call again with confirm=true. Never set confirm=true on your own initiative. " +
      "Needs the kill_session operation in the user's MCP tier.",
    inputSchema: {
      datasource: datasourceArg,
      sessionId: z.string().describe("Session id from list_sessions, e.g. '123,4567' (Oracle) or '55'"),
      confirm: z.boolean().optional().describe("true only after the user explicitly approved ending this session"),
    },
    annotations: WRITE,
  },
  guard(async ({ datasource, sessionId, confirm }) => {
    const body = {};
    if (confirm === true) body.confirm = true;
    return ok(
      await api("POST", `/datasources/${seg(resolveDatasource(datasource))}/sessions/${seg(sessionId)}/kill`, { body })
    );
  })
);

// ---- DBHawk AI --------------------------------------------------------------------------------------

server.registerTool(
  "text_to_sql",
  {
    title: "Text to SQL",
    description:
      "DBHawk AI text-to-SQL: turn a natural-language question into a SQL statement for the datasource. Only works " +
      "when the datasource has aiEnabled=true. It only generates statement types the user's MCP tier allows. " +
      "It does not execute anything: run the result with run_query, or execute_statement for a change.",
    inputSchema: {
      datasource: datasourceArg,
      prompt: z.string().describe("The natural-language question"),
      sessionId: z.string().optional().describe("Optional conversation id to keep context across calls"),
    },
    annotations: { ...READ_ONLY, idempotentHint: false },
  },
  guard(async ({ datasource, prompt, sessionId }) => {
    const body = { prompt };
    if (sessionId !== undefined) body.sessionId = sessionId;
    return ok(await api("POST", `/datasources/${seg(resolveDatasource(datasource))}/ai/ask`, { body }));
  })
);

server.registerTool(
  "optimize_sql",
  {
    title: "Optimize SQL",
    description: "DBHawk AI SQL optimization suggestions for a given statement. Does not execute anything.",
    inputSchema: {
      datasource: datasourceArg,
      sql: z.string().describe("The SQL statement to optimize"),
      schema: z.string().optional().describe("Schema context, if relevant"),
    },
    annotations: { ...READ_ONLY, idempotentHint: false },
  },
  guard(async ({ datasource, sql, schema }) => {
    const body = { sql };
    if (schema !== undefined) body.schema = schema;
    return ok(await api("POST", `/datasources/${seg(resolveDatasource(datasource))}/ai/optimize`, { body }));
  })
);

server.registerTool(
  "format_sql",
  {
    title: "Format SQL",
    description: "Pretty-print / format a SQL statement.",
    inputSchema: {
      query: z.string().describe("The SQL statement to format"),
      dbDialect: z.string().optional().describe("Optional dialect hint (e.g. ORACLE, MYSQL, POSTGRESQL)"),
    },
    annotations: READ_ONLY,
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
console.error(`[dbhawk-mcp] connected. API base: ${API_BASE} (${oauth ? "DBHawk sign-in, " + oauth.storeFile : "personal token"})`);
