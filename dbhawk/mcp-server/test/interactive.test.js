/**
 * The interactive job tools: forms (elicitation) for a client that fills them in and the chat dialog for a client
 * without them - what is asked, and what DBHawk then gets. The HTML job screen (MCP App) is commented out, so an
 * MCP Apps client is asked in a form like any other.
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
    // the job screen is off, so an MCP Apps client is asked in a form like any other forms client
    onElicit: (params) => {
      asked.push(params);
      const answer = answers.shift();
      return answer ? { action: "accept", content: answer } : { action: "decline" };
    },
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

test("the job screen is off: no resource, and no tool opens one", async () => {
  // with the resource commented out the server declares no resources capability at all
  let resources = [];
  try {
    resources = (await plainClient.listResources()).resources;
  } catch (e) {
    assert.match(String(e), /Method not found|-32601/);
  }
  assert.deepEqual(resources, []);
  await assert.rejects(() => plainClient.readResource({ uri: UI }));

  const { tools } = await plainClient.listTools();
  for (const name of ["list_jobs", "get_job", "list_job_executions", "create_job", "update_job", "delete_job",
    "pause_job", "resume_job", "run_job", "interrupt_job", "explain_cron"]) {
    assert.equal(tools.find((t) => t.name === name)._meta, undefined, name);
  }
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
  assert.deepEqual(await required(uiClient), [], "the screen is off: an MCP Apps client is asked in a form");
});

// ── the chat dialog ────────────────────────────────────────────────────

test("create_job with no arguments is filled in with the user, one question at a time", async () => {
  const fields = [];
  let args = {};
  for (const answer of [{ name: "orders" }, { statement: "select * from orders" }, { cronExp: "0 30 6 ? * MON-FRI" },
    { format: "xlsx" }, { delivery: "fileManager" }]) {
    const question = jsonOf(await plainClient.callTool({ name: "create_job", arguments: args }));
    assert.equal(question.questionRequired, true, JSON.stringify(question));
    assert.equal(question.created, false);
    fields.push(question.field);
    args = { ...question.job, dialog: question.dialog, ...answer };
  }
  assert.deepEqual(fields, ["name", "statement", "cronExp", "format", "delivery"],
    "DBHAWK_DEFAULT_DATASOURCE needs no question; the schedule and the output are always asked");
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
    delivery: "fileManager",
  });
});

test("a schedule the model brings along is put to the user as a suggestion", async () => {
  const question = jsonOf(await plainClient.callTool({
    name: "create_job",
    arguments: { name: "orders", statement: "select 1", cronExp: "0 30 6 ? * MON-FRI" },
  }));

  assert.equal(question.field, "cronExp");
  assert.match(question.question, /at 06:30 on weekdays/);
  assert.equal(question.job.cronExp, "0 30 6 ? * MON-FRI", "the suggestion travels on, so the user can keep it");
  assert.equal(fake.calls.filter((c) => c.method === "POST" && c.path === `${MCP}/jobs`).length, 0);
});

test("the first question of a chat without a default datasource offers the user's own", async () => {
  const question = jsonOf(await chatClient.callTool({ name: "create_job", arguments: {} }));

  assert.equal(question.field, "datasource");
  assert.deepEqual(question.options, ["pg-demo", "ora"]);
  assert.equal(question.dialog, "datasource");
  assert.match(question.message, /do not answer it yourself/);
});

test("a schedule and output the model brings in full are put in one question", async () => {
  const args = { name: "orders", statement: "select 1", cronExp: "0 30 6 ? * MON-FRI", format: "xlsx",
    delivery: "email", emailTo: "anna@example.com" };

  const question = jsonOf(await plainClient.callTool({ name: "create_job", arguments: args }));

  assert.equal(question.field, "setup");
  assert.match(question.question, /at 06:30 on weekdays/);
  assert.match(question.question, /export xlsx by e-mail to anna@example\.com/);
  assert.match(question.question, /Is that right\?$/);
  assert.equal(fake.calls.filter((c) => c.method === "POST" && c.path === `${MCP}/jobs`).length, 0);

  // the user is happy: the same arguments with the marker create the job, with nothing asked again
  const result = jsonOf(await plainClient.callTool({ name: "create_job", arguments: { ...args, dialog: question.dialog } }));
  assert.equal(result.confirmationRequired, true, "the tier still has the last word");
  assert.equal(posts(`${MCP}/jobs`)[0].body.format, "xlsx");
});

test("after the one question only the field the user wants changed is asked", async () => {
  const question = jsonOf(await plainClient.callTool({
    name: "create_job",
    // the model calls again without 'format', because that is what the user wants changed
    arguments: { name: "orders", statement: "select 1", cronExp: "0 30 6 ? * MON-FRI", delivery: "email", dialog: "setup" },
  }));

  assert.equal(question.field, "format");
  assert.deepEqual(question.options, ["csv", "txt", "html", "pdf", "xlsx", "json", "parquet"]);
});

test("a cron the scheduler cannot read is asked again with what is wrong", async () => {
  const question = jsonOf(await plainClient.callTool({
    name: "create_job",
    arguments: { name: "orders", statement: "select 1", cronExp: "bad", dialog: "name,statement,cronExp" },
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

test("a schedule and output from the model are one confirmation form, not the whole form", async () => {
  answers = [{ right: true }, { confirm: true }];

  await formsClient.callTool({
    name: "create_job",
    arguments: { datasource: "pg-demo", name: "n", statement: "select 1", cronExp: "0 0 8 * * ?", format: "xlsx",
      delivery: "email", emailTo: "anna@example.com" },
  });

  assert.equal(asked.length, 2, "one question, then the tier's confirmation");
  assert.match(asked[0].message, /at 06:30 on weekdays/);
  assert.match(asked[0].message, /Result: xlsx/);
  assert.match(asked[0].message, /Delivery: e-mail to anna@example\.com/);
  assert.equal(posts(`${MCP}/jobs`)[0].body.cronExp, "0 0 8 * * ?");
});

test("clearing the box opens the whole schedule form on what the model proposed", async () => {
  answers = [
    { right: false },
    { schedule: EVERY_HOUR, time: "00:15", format: "csv", delivery: TO_FILE_MANAGER },
    { confirm: true },
  ];

  await formsClient.callTool({
    name: "create_job",
    arguments: { datasource: "pg-demo", name: "n", statement: "select 1", cronExp: "0 0 8 * * ?", format: "xlsx", delivery: "email" },
  });

  assert.equal(asked[1].requestedSchema.properties.schedule.default, CUSTOM, "the form opens on what the model proposed");
  assert.equal(asked[1].requestedSchema.properties.cronExp.default, "0 0 8 * * ?");
  const body = posts(`${MCP}/jobs`)[0].body;
  assert.equal(body.cronExp, "0 15 * * * ?");
  assert.equal(body.delivery, "fileManager");
});

test("the confirmation of a job e-mailing others names the recipients", async () => {
  answers = [{ confirm: true }];
  const original = fake.calls.length;

  await formsClient.callTool({ name: "run_job", arguments: { jobId: 8 } });

  assert.ok(fake.calls.length > original);
  assert.match(asked[0].message, /^Run this job now\? Its results are e-mailed to anna@example\.com, so DBHawk asks you to confirm \(SELECT\)\./);
});

test("delivery and recipients go to DBHawk as given", async () => {
  // the marker says the user has been asked about the schedule and the output already
  await plainClient.callTool({ name: "create_job", arguments: { datasource: "pg-demo", name: "n", statement: "select 1",
    cronExp: "0 0 8 * * ?", delivery: "email", emailTo: "a@example.com, b@example.com", confirm: true,
    dialog: "cronExp,format,delivery" } });
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

test("without forms the model gets the confirmation request; an MCP Apps client is asked in a form", async () => {
  const result = jsonOf(await plainClient.callTool({ name: "run_job", arguments: { jobId: 7 } }));
  assert.equal(result.confirmationRequired, true);

  answers = [{ confirm: true }];
  const ui = jsonOf(await uiClient.callTool({ name: "run_job", arguments: { jobId: 7 } }));
  assert.equal(ui.done, true, "the screen is off, so the user approves in a form");
});

test("cron of the schedule choices", () => {
  assert.equal(cronOf(WEEKDAYS, "7:05"), "0 5 7 ? * MON-FRI");
  assert.equal(cronOf(EVERY_HOUR, "00:30"), "0 30 * * * ?");
  assert.throws(() => cronOf(WEEKDAYS, "24:00"), /HH:mm/);
  assert.throws(() => cronOf(CUSTOM, "", ""), /cron expression/);
});
