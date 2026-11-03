/**
 * Tool catalogue and tool -> DBHawk REST mapping, including the read/write safety contract.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startFakeDbhawk, startClient, jsonOf, textOf, MCP } from "./helpers.js";

let fake;
let client;
let nextResponse;

before(async () => {
  fake = await startFakeDbhawk({ handler: () => nextResponse });
  client = await startClient(fake.baseUrl);
});

after(async () => {
  await client?.close();
  await fake?.close();
});

beforeEach(() => {
  nextResponse = undefined;
});

const call = (name, args = {}) => client.callTool({ name, arguments: args });

// ── catalogue ──────────────────────────────────────────────────────────

const READ_TOOLS = [
  "get_permissions", "list_datasources", "get_datasource", "list_catalogs", "list_schemas", "list_objects",
  "list_columns", "run_query", "explain_plan", "list_sessions", "text_to_sql", "optimize_sql", "format_sql",
  "list_jobs", "get_job", "list_job_executions", "explain_cron",
];

const WRITE_TOOLS = [
  "execute_statement", "kill_session", "create_job", "update_job", "delete_job", "resume_job", "run_job", "interrupt_job",
];

/** Changes something, but only stops runs and is undone by resume_job. */
const REVERSIBLE_TOOLS = ["pause_job"];

test("exposes exactly the 26 DBHawk tools", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...READ_TOOLS, ...WRITE_TOOLS, ...REVERSIBLE_TOOLS].sort());
});

test("write tools are destructive and pause_job is neither read-only nor destructive", async () => {
  const { tools } = await client.listTools();
  for (const tool of tools.filter((t) => WRITE_TOOLS.includes(t.name))) {
    assert.equal(tool.annotations?.readOnlyHint, false, `${tool.name} readOnlyHint`);
    assert.equal(tool.annotations?.destructiveHint, true, `${tool.name} destructiveHint`);
  }
  const pause = tools.find((t) => t.name === "pause_job");
  assert.equal(pause.annotations.readOnlyHint, false);
  assert.equal(pause.annotations.destructiveHint, false);
});

test("every tool except the write tools is annotated read-only and non-destructive", async () => {
  const { tools } = await client.listTools();
  for (const tool of tools.filter((t) => !WRITE_TOOLS.includes(t.name) && !REVERSIBLE_TOOLS.includes(t.name))) {
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} readOnlyHint`);
    assert.equal(tool.annotations?.destructiveHint, false, `${tool.name} destructiveHint`);
    assert.equal(tool.annotations?.openWorldHint, false, `${tool.name} openWorldHint`);
  }
});

test("execute_statement is annotated destructive, so MCP clients ask the user first", async () => {
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "execute_statement");
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.destructiveHint, true);
  assert.equal(tool.annotations.idempotentHint, false);
});

test("no tool accepts database credentials", async () => {
  const { tools } = await client.listTools();
  for (const tool of tools) {
    const props = Object.keys(tool.inputSchema.properties || {});
    assert.ok(!props.includes("dbUserName") && !props.includes("dbPassword"), `${tool.name}: ${props}`);
  }
});

// ── read / write contract ──────────────────────────────────────────────

test("run_query posts the query with readOnly=true", async () => {
  await call("run_query", { query: "SELECT 1", maxRows: 50 });
  const req = fake.last();
  assert.equal(req.method, "POST");
  assert.equal(req.path, `${MCP}/datasources/pg-demo/query`);
  assert.deepEqual(req.body, { query: "SELECT 1", readOnly: true, maxRows: 50 });
});

test("run_query drops unknown credential arguments", async () => {
  await call("run_query", { query: "SELECT 1", dbUserName: "sa", dbPassword: "secret" });
  assert.deepEqual(fake.last().body, { query: "SELECT 1", readOnly: true });
});

test("execute_statement without confirm sends no confirm and no readOnly flag", async () => {
  await call("execute_statement", { statement: "UPDATE t SET a = 1" });
  assert.deepEqual(fake.last().body, { query: "UPDATE t SET a = 1" });
});

test("execute_statement with confirm=false does not confirm", async () => {
  await call("execute_statement", { statement: "DELETE FROM t", confirm: false });
  assert.deepEqual(fake.last().body, { query: "DELETE FROM t" });
});

test("execute_statement with confirm=true confirms", async () => {
  await call("execute_statement", { statement: "DELETE FROM t", confirm: true });
  assert.deepEqual(fake.last().body, { query: "DELETE FROM t", confirm: true });
});

test("a confirmationRequired answer is handed to the model unchanged", async () => {
  nextResponse = { json: { confirmationRequired: true, executed: false, operations: ["update_rows"] } };
  const result = await call("execute_statement", { statement: "UPDATE t SET a = 1" });
  assert.ok(!result.isError);
  assert.deepEqual(jsonOf(result), { confirmationRequired: true, executed: false, operations: ["update_rows"] });
});

// ── tool -> endpoint mapping ───────────────────────────────────────────

test("get_permissions", async () => {
  nextResponse = { json: { tiers: ["Read"], maxRows: 5000 } };
  const result = await call("get_permissions");
  assert.deepEqual(jsonOf(result), { tiers: ["Read"], maxRows: 5000 });
  assert.equal(fake.last().method, "GET");
  assert.equal(fake.last().path, `${MCP}/permissions`);
});

test("list_datasources", async () => {
  await call("list_datasources");
  assert.equal(fake.last().method, "GET");
  assert.equal(fake.last().path, `${MCP}/datasources`);
});

test("get_datasource", async () => {
  await call("get_datasource", { datasource: "Oracle-OVH" });
  assert.equal(fake.last().path, `${MCP}/datasources/Oracle-OVH`);
});

test("list_catalogs", async () => {
  await call("list_catalogs", { datasource: "mssql" });
  assert.equal(fake.last().path, `${MCP}/datasources/mssql/catalogs`);
});

test("list_schemas with and without catalog", async () => {
  await call("list_schemas", {});
  assert.equal(fake.last().path, `${MCP}/datasources/pg-demo/schemas`);
  assert.deepEqual(fake.last().query, {});

  await call("list_schemas", { catalog: "Sales DB" });
  assert.deepEqual(fake.last().query, { catalog: "Sales DB" });
});

test("list_objects passes type, catalog and name filter", async () => {
  await call("list_objects", { schema: "public", type: "TABLE,VIEW", catalog: "c1", query: "cust" });
  const req = fake.last();
  assert.equal(req.path, `${MCP}/datasources/pg-demo/schemas/public/objects`);
  assert.deepEqual(req.query, { type: "TABLE,VIEW", catalog: "c1", query: "cust" });
});

test("list_columns", async () => {
  await call("list_columns", { schema: "public", object: "customers" });
  assert.equal(fake.last().path, `${MCP}/datasources/pg-demo/schemas/public/objects/customers/columns`);
});

test("explain_plan posts the statement to the explain endpoint, with no readOnly or confirm flag", async () => {
  nextResponse = { json: { rowCount: 2, planText: "Plan hash value: 1" } };
  const result = await call("explain_plan", { datasource: "Oracle-OVH", query: "SELECT * FROM HR.TESTIMPORT" });
  assert.equal(jsonOf(result).planText, "Plan hash value: 1");
  assert.equal(fake.last().method, "POST");
  assert.equal(fake.last().path, `${MCP}/datasources/Oracle-OVH/explain`);
  assert.deepEqual(fake.last().body, { query: "SELECT * FROM HR.TESTIMPORT" });
});

test("run_query points the model at explain_plan for plans", async () => {
  const { tools } = await client.listTools();
  assert.match(tools.find((t) => t.name === "run_query").description, /explain_plan/);
  assert.match(tools.find((t) => t.name === "explain_plan").description, /never executes/);
});

test("kill_session is annotated destructive, so MCP clients ask the user first", async () => {
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "kill_session");
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.destructiveHint, true);
});

test("list_sessions", async () => {
  nextResponse = { json: { rowCount: 1, sessions: [{ sessionId: "17,301", user: "HR" }] } };
  const result = await call("list_sessions", { datasource: "oracle21" });
  assert.equal(jsonOf(result).sessions[0].sessionId, "17,301");
  assert.equal(fake.last().method, "GET");
  assert.equal(fake.last().path, `${MCP}/datasources/oracle21/sessions`);
});

test("kill_session encodes the Oracle id and confirms only when asked", async () => {
  await call("kill_session", { datasource: "oracle21", sessionId: "17,301" });
  assert.equal(fake.last().method, "POST");
  assert.equal(fake.last().rawUrl, `${MCP}/datasources/oracle21/sessions/17%2C301/kill`);
  assert.deepEqual(fake.last().body, {});

  await call("kill_session", { datasource: "oracle21", sessionId: "17,301", confirm: false });
  assert.deepEqual(fake.last().body, {});

  await call("kill_session", { datasource: "oracle21", sessionId: "17,301", confirm: true });
  assert.deepEqual(fake.last().body, { confirm: true });
});

test("text_to_sql posts the prompt and optional session", async () => {
  await call("text_to_sql", { prompt: "top customers" });
  assert.equal(fake.last().path, `${MCP}/datasources/pg-demo/ai/ask`);
  assert.deepEqual(fake.last().body, { prompt: "top customers" });

  await call("text_to_sql", { prompt: "and by region", sessionId: "s-1" });
  assert.deepEqual(fake.last().body, { prompt: "and by region", sessionId: "s-1" });
});

test("optimize_sql posts sql and optional schema", async () => {
  await call("optimize_sql", { sql: "SELECT * FROM t", schema: "public" });
  assert.equal(fake.last().path, `${MCP}/datasources/pg-demo/ai/optimize`);
  assert.deepEqual(fake.last().body, { sql: "SELECT * FROM t", schema: "public" });
});

test("format_sql returns the plain-text body", async () => {
  nextResponse = { text: "SELECT\n  1" };
  const result = await call("format_sql", { query: "select 1", dbDialect: "POSTGRESQL" });
  assert.equal(textOf(result), "SELECT\n  1");
  assert.equal(fake.last().path, `${MCP}/format-query`);
  assert.equal(fake.last().headers.accept, "text/plain");
  assert.deepEqual(fake.last().body, { query: "select 1", dbDialect: "POSTGRESQL" });
});

// ── path handling ──────────────────────────────────────────────────────

test("path segments are URL-encoded", async () => {
  await call("list_columns", { datasource: "my ds/1", schema: "dbo#x", object: "order details?" });
  assert.equal(
    fake.last().rawUrl,
    `${MCP}/datasources/my%20ds%2F1/schemas/dbo%23x/objects/order%20details%3F/columns`
  );
});

test("an explicit datasource wins over DBHAWK_DEFAULT_DATASOURCE", async () => {
  await call("run_query", { datasource: "other", query: "SELECT 1" });
  assert.equal(fake.last().path, `${MCP}/datasources/other/query`);
});

// ── scheduled jobs ─────────────────────────────────────────────────────

test("list_jobs passes datasource, name and paging, and never defaults the datasource", async () => {
  await call("list_jobs");
  assert.equal(fake.last().method, "GET");
  assert.equal(fake.last().rawUrl, `${MCP}/jobs`);

  await call("list_jobs", { datasource: "ora", name: "daily", offset: 50, limit: 25 });
  assert.equal(fake.last().path, `${MCP}/jobs`);
  assert.deepEqual(fake.last().query, { datasource: "ora", name: "daily", offset: "50", limit: "25" });
});

test("get_job and list_job_executions", async () => {
  await call("get_job", { jobId: 42 });
  assert.equal(fake.last().path, `${MCP}/jobs/42`);

  await call("list_job_executions", { jobId: 42, limit: 5 });
  assert.equal(fake.last().rawUrl, `${MCP}/jobs/42/executions?limit=5`);
});

test("explain_cron posts the expression", async () => {
  await call("explain_cron", { cronExp: "0 0 8 * * ?" });
  assert.equal(fake.last().method, "POST");
  assert.equal(fake.last().path, `${MCP}/jobs/cron/explain`);
  assert.deepEqual(fake.last().body, { cronExp: "0 0 8 * * ?" });
});

test("create_job posts the job with the default datasource and confirms only when asked", async () => {
  const job = { name: "Daily", statement: "SELECT 1", cronExp: "0 0 8 * * ?" };
  await call("create_job", job);
  assert.equal(fake.last().method, "POST");
  assert.equal(fake.last().path, `${MCP}/jobs`);
  assert.deepEqual(fake.last().body, { ...job, datasource: "pg-demo" });

  await call("create_job", { ...job, datasource: "ora", format: "xlsx", confirm: true });
  assert.deepEqual(fake.last().body, { ...job, datasource: "ora", format: "xlsx", confirm: true });
});

test("create_job offers no delivery target", async () => {
  const { tools } = await client.listTools();
  const props = Object.keys(tools.find((t) => t.name === "create_job").inputSchema.properties);
  for (const forbidden of ["deliveryTarget", "sendEmail", "email", "sftpId", "s3", "sharePoint", "notifyEmail",
    "compressionPassword", "publicKey"]) {
    assert.ok(!props.includes(forbidden), forbidden);
  }
});

test("update_job puts only the given fields", async () => {
  await call("update_job", { jobId: 7, cronExp: "0 30 6 * * ?", confirm: false });
  assert.equal(fake.last().method, "PUT");
  assert.equal(fake.last().path, `${MCP}/jobs/7`);
  assert.deepEqual(fake.last().body, { cronExp: "0 30 6 * * ?" });
});

test("job actions post to their endpoint and confirm only when asked", async () => {
  for (const [tool, action] of [["delete_job", "delete"], ["resume_job", "resume"], ["run_job", "run"],
    ["interrupt_job", "interrupt"]]) {
    await call(tool, { jobId: 9 });
    assert.equal(fake.last().method, "POST", tool);
    assert.equal(fake.last().path, `${MCP}/jobs/9/${action}`, tool);
    assert.deepEqual(fake.last().body, {}, tool);

    await call(tool, { jobId: 9, confirm: true });
    assert.deepEqual(fake.last().body, { confirm: true }, tool);
  }
  await call("pause_job", { jobId: 9 });
  assert.equal(fake.last().path, `${MCP}/jobs/9/pause`);
});
