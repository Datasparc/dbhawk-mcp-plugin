/**
 * The interactive job tools: the job screen (MCP App) as a resource the job tools point at, forms (elicitation)
 * for a client that fills them in, and the chat dialog for a client with neither - what is asked, and what DBHawk
 * then gets.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startFakeDbhawk, startClient, jsonOf, MCP } from "./helpers.js";
import { cronOf, WEEKDAYS, CUSTOM, EVERY_HOUR, EVERY_DAY, BY_EMAIL, TO_FILE_MANAGER } from "../jobs-wizard.js";

const UI = "ui://dbhawk/jobs";

/** DBHawk as the job tools see it; confirmation required until a call carries confirm. */
function dbhawk(call) {
  if (call.path === `${MCP}/datasources`) return { json: [{ name: "pg-demo" }, { name: "ora" }] };
  if (call.path === `${MCP}/jobs/cron/explain`) {
    return { json: call.body.cronExp === "bad" ? { valid: false, error: "Illegal characters" } : { valid: true, description: "at 06:30 on weekdays" } };
  }
  if (call.method === "GET" && call.path === `${MCP}/jobs/7`) {
    return {
      json: {
        id: 7, name: "nightly", kind: "export", datasource: "pg-demo", statement: "select 1", schema: "public",
        schedule: { cronExp: "0 0 2 * * ?" }, output: { format: "csv", compression: "none", showHeaders: true },
        notify: { onSuccess: false, onFailure: false },
      },
    };
  }
  if (call.method === "POST" || call.method === "PUT") {
    if (call.body && call.body.confirm === true) return { json: { done: true } };
    const pending = { confirmationRequired: true, executed: false, tool: "x", statementType: "SELECT", job: { name: call.body?.name || "nightly", statement: "select 1" } };
    if (call.path === `${MCP}/jobs/8/run`) pending.emailRecipients = ["anna@example.com"];
    return { json: pending };
  }
  return { json: { ok: true } };
}

let fake;
let formsClient;
let plainClient;
let uiClient;
/** A plain chat with no DBHAWK_DEFAULT_DATASOURCE: it is asked which datasource too. */
let chatClient;
let answers;
const asked = [];

before(async () => {
  fake = await startFakeDbhawk({ handler: dbhawk });
  formsClient = await startClient(fake.baseUrl, {}, {
    capabilities: { elicitation: {} },
    onElicit: (params) => {
      asked.push(params);
      const answer = answers.shift();
      return answer ? { action: "accept", content: answer } : { action: "decline" };
    },
  });
  plainClient = await startClient(fake.baseUrl);
  chatClient = await startClient(fake.baseUrl, { DBHAWK_DEFAULT_DATASOURCE: "" });
  uiClient = await startClient(fake.baseUrl, {}, {
    capabilities: { elicitation: {}, extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } },
    onElicit: () => assert.fail("a client with the job screen gets no forms"),
  });
});

after(async () => {
  await formsClient?.close();
  await plainClient?.close();
  await chatClient?.close();
  await uiClient?.close();
  await fake?.close();
});

beforeEach(() => {
  answers = [];
  asked.length = 0;
  fake.calls.length = 0;
});

const posts = (path) => fake.mcpCalls().filter((c) => c.path === path && c.method !== "GET");

// ── the job screen ─────────────────────────────────────────────────────

test("the job screen is a resource and the job tools open it", async () => {
  const { resources } = await plainClient.listResources();
  const screen = resources.find((r) => r.uri === UI);
  assert.equal(screen.mimeType, "text/html;profile=mcp-app");

  const { contents } = await plainClient.readResource({ uri: UI });
  assert.ok(contents[0].text.startsWith("<!DOCTYPE html>"));
  assert.ok(contents[0].text.includes("ui/initialize"));
  assert.deepEqual(contents[0]._meta.ui.csp, { connectDomains: [], resourceDomains: [] });

  const { tools } = await plainClient.listTools();
  for (const name of ["list_jobs", "get_job", "list_job_executions", "create_job", "update_job", "delete_job",
    "pause_job", "resume_job", "run_job", "interrupt_job"]) {
    const tool = tools.find((t) => t.name === name);
    assert.equal(tool._meta?.ui?.resourceUri, UI, name);
    assert.equal(tool._meta?.["ui/resourceUri"], UI, name);
  }
  assert.equal(tools.find((t) => t.name === "explain_cron")._meta, undefined);
});

// ── tools/list per client ──────────────────────────────────────────────

test("a client that is asked for the missing fields gets a create_job without required arguments", async () => {
  const createJob = async (client) => (await client.listTools()).tools.find((t) => t.name === "create_job");
  const required = async (client) => (await createJob(client)).inputSchema.required || [];
  assert.deepEqual(await required(formsClient), []);
  // a plain chat is asked by the model itself, one question at a time
  assert.deepEqual(await required(plainClient), []);
  assert.match((await createJob(plainClient)).description, /ONE question at a time/);
  assert.ok((await createJob(plainClient)).inputSchema.properties.dialog, "the dialog marker travels with the answers");
  assert.deepEqual((await required(uiClient)).sort(), ["cronExp", "name", "statement"], "the screen asks, not the model");
});

// ── the chat dialog ────────────────────────────────────────────────────

test("create_job with no arguments is filled in with the user, one question at a time", async () => {
  const fields = [];
  let args = {};
  for (const answer of [{ name: "orders" }, { statement: "select * from orders" }, { cronExp: "0 30 6 ? * MON-FRI" }, { format: "xlsx" }]) {
    const question = jsonOf(await plainClient.callTool({ name: "create_job", arguments: args }));
    assert.equal(question.questionRequired, true, JSON.stringify(question));
    assert.equal(question.created, false);
    fields.push(question.field);
    args = { ...question.job, dialog: question.dialog, ...answer };
  }
  assert.deepEqual(fields, ["name", "statement", "cronExp", "output"], "DBHAWK_DEFAULT_DATASOURCE needs no question");
  assert.equal(fake.calls.filter((c) => c.method === "POST" && c.path === `${MCP}/jobs`).length, 0, "nothing is created while a question is open");

  const result = jsonOf(await plainClient.callTool({ name: "create_job", arguments: args }));

  assert.equal(result.confirmationRequired, true, "the tier still has the last word");
  const creates = fake.calls.filter((c) => c.method === "POST" && c.path === `${MCP}/jobs`);
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0].body, {
    datasource: "pg-demo",
    name: "orders",
    statement: "select * from orders",
    cronExp: "0 30 6 ? * MON-FRI",
    format: "xlsx",
  });
});

test("the first question of a chat without a default datasource offers the user's own", async () => {
  const question = jsonOf(await chatClient.callTool({ name: "create_job", arguments: {} }));

  assert.equal(question.field, "datasource");
  assert.deepEqual(question.options, ["pg-demo", "ora"]);
  assert.equal(question.dialog, "datasource");
  assert.match(question.message, /do not answer it yourself/);
});

test("a cron the scheduler cannot read is asked again with what is wrong", async () => {
  const question = jsonOf(await plainClient.callTool({
    name: "create_job",
    arguments: { name: "orders", statement: "select 1", cronExp: "bad" },
  }));

  assert.equal(question.field, "cronExp");
  assert.match(question.question, /is not a valid cron expression/);
  assert.match(question.question, /Illegal characters\. How often/, "the reason ends as a sentence");
  assert.equal(question.job.cronExp, undefined, "the cron that does not work is not offered back");
  assert.equal(fake.calls.filter((c) => c.method === "POST" && c.path === `${MCP}/jobs`).length, 0);
});

// ── forms ──────────────────────────────────────────────────────────────

test("create_job with no arguments asks what and when, then confirms in a form", async () => {
  answers = [
    { datasource: "ora", name: "orders", statement: "select * from orders" },
    { schedule: WEEKDAYS, time: "06:30", format: "xlsx", delivery: TO_FILE_MANAGER, showHeaders: false },
    { confirm: true },
  ];

  const result = jsonOf(await formsClient.callTool({ name: "create_job", arguments: {} }));

  assert.equal(result.done, true);
  assert.equal(result.confirmation, "approved by the user in the DBHawk confirmation form");
  assert.equal(asked.length, 3);
  assert.deepEqual(asked[0].requestedSchema.properties.datasource.enum, ["pg-demo", "ora"]);
  assert.equal(asked[0].requestedSchema.properties.datasource.default, "pg-demo", "DBHAWK_DEFAULT_DATASOURCE preselected");
  assert.match(asked[2].message, /^Create this job\? Your MCP tier asks you to confirm \(SELECT\)\./);

  const creates = posts(`${MCP}/jobs`);
  assert.equal(creates.length, 2);
  assert.deepEqual(creates[0].body, {
    datasource: "ora", name: "orders", statement: "select * from orders", cronExp: "0 30 6 ? * MON-FRI",
    format: "xlsx", compression: "none", delivery: "fileManager", showHeaders: false,
  });
  assert.equal(creates[1].body.confirm, true);
});

test("e-mail delivery is chosen with the schedule, and a job e-mailing others names them in the confirmation", async () => {
  answers = [
    { schedule: EVERY_DAY, time: "07:00", format: "csv", delivery: BY_EMAIL, emailTo: " anna@example.com " },
    { confirm: true },
  ];

  await formsClient.callTool({ name: "create_job", arguments: { datasource: "pg-demo", name: "n", statement: "select 1" } });

  assert.deepEqual(asked[0].requestedSchema.properties.delivery.enum, [TO_FILE_MANAGER, BY_EMAIL]);
  const body = posts(`${MCP}/jobs`)[0].body;
  assert.equal(body.delivery, "email");
  assert.equal(body.emailTo, "anna@example.com");
});

test("the confirmation of a job e-mailing others names the recipients", async () => {
  answers = [{ confirm: true }];
  const original = fake.calls.length;

  await formsClient.callTool({ name: "run_job", arguments: { jobId: 8 } });

  assert.ok(fake.calls.length > original);
  assert.match(asked[0].message, /^Run this job now\? Its results are e-mailed to anna@example\.com, so DBHawk asks you to confirm \(SELECT\)\./);
});

test("delivery and recipients go to DBHawk as given", async () => {
  await plainClient.callTool({ name: "create_job", arguments: { datasource: "pg-demo", name: "n", statement: "select 1",
    cronExp: "0 0 8 * * ?", delivery: "email", emailTo: "a@example.com, b@example.com", confirm: true } });
  const body = posts(`${MCP}/jobs`)[0].body;
  assert.equal(body.delivery, "email");
  assert.equal(body.emailTo, "a@example.com, b@example.com");

  await plainClient.callTool({ name: "update_job", arguments: { jobId: 7, delivery: "fileManager", confirm: true } });
  assert.deepEqual(fake.mcpCalls().filter((c) => c.method === "PUT")[0].body, { delivery: "fileManager", confirm: true });
});

test("a declined confirmation changes nothing", async () => {
  answers = [{ confirm: false }];

  const result = jsonOf(await formsClient.callTool({ name: "delete_job", arguments: { jobId: 7 } }));

  assert.equal(result.cancelled, true);
  const deletes = posts(`${MCP}/jobs/7/delete`);
  assert.equal(deletes.length, 1);
  assert.deepEqual(deletes[0].body, {});
});

test("update_job with only jobId opens the job in a form and sends the changes only", async () => {
  answers = [{ name: "nightly", statement: "select 1", cronExp: "0 0 3 * * ?", format: "pdf", delivery: TO_FILE_MANAGER }, { confirm: true }];

  await formsClient.callTool({ name: "update_job", arguments: { jobId: 7 } });

  assert.equal(asked[0].requestedSchema.properties.statement.default, "select 1");
  const puts = fake.mcpCalls().filter((c) => c.method === "PUT");
  assert.deepEqual(puts[0].body, { cronExp: "0 0 3 * * ?", format: "pdf" });
  assert.deepEqual(puts[1].body, { cronExp: "0 0 3 * * ?", format: "pdf", confirm: true });
});

test("an invalid cron is asked again with the reason", async () => {
  answers = [
    { schedule: CUSTOM, cronExp: "bad", format: "csv", delivery: TO_FILE_MANAGER },
    { schedule: EVERY_HOUR, time: "00:15", format: "csv", delivery: TO_FILE_MANAGER },
    { confirm: true },
  ];

  await formsClient.callTool({ name: "create_job", arguments: { datasource: "pg-demo", name: "n", statement: "select 1" } });

  assert.match(asked[1].message, /"bad" is not a valid cron expression: Illegal characters/);
  assert.equal(posts(`${MCP}/jobs`)[0].body.cronExp, "0 15 * * * ?");
});

test("without forms the model gets the confirmation request, as before", async () => {
  const result = jsonOf(await plainClient.callTool({ name: "run_job", arguments: { jobId: 7 } }));
  assert.equal(result.confirmationRequired, true);

  const ui = jsonOf(await uiClient.callTool({ name: "run_job", arguments: { jobId: 7 } }));
  assert.equal(ui.confirmationRequired, true);
});

test("cron of the schedule choices", () => {
  assert.equal(cronOf(WEEKDAYS, "7:05"), "0 5 7 ? * MON-FRI");
  assert.equal(cronOf(EVERY_HOUR, "00:30"), "0 30 * * * ?");
  assert.throws(() => cronOf(WEEKDAYS, "24:00"), /HH:mm/);
  assert.throws(() => cronOf(CUSTOM, "", ""), /cron expression/);
});
