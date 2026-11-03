/**
 * The job tools step by step, as in the DBHawk Job Scheduler, for an MCP client that fills in forms (elicitation).
 * The same flow as DBHawk's own MCP server (McpJobWizard): create_job asks the user for whatever the model left out
 * (datasource, name, SQL, then schedule and output), update_job with only a job id opens the job in a form, and a
 * change the MCP tier asks to confirm is confirmed by the user in a form instead of being bounced back to the model.
 * The answers become ordinary tool arguments, so DBHawk still checks everything (tier, access control, read-only).
 * An explicit confirm=false skips the confirmation form (the job screen asks on its own).
 */

export const WIZARD_TOOLS = new Set(["create_job", "update_job", "delete_job", "resume_job", "run_job", "interrupt_job"]);

export const EVERY_HOUR = "Every hour";
export const EVERY_DAY = "Every day";
export const WEEKDAYS = "Every weekday (Mon-Fri)";
export const MONDAYS = "Every Monday";
export const MONTHLY = "On the 1st of every month";
export const CUSTOM = "Custom cron expression";
export const SCHEDULES = [EVERY_DAY, WEEKDAYS, MONDAYS, MONTHLY, EVERY_HOUR, CUSTOM];

const FORMATS = ["csv", "txt", "html", "pdf", "xlsx", "json", "parquet"];
const COMPRESSIONS = ["none", "zip", "gz"];
export const TO_FILE_MANAGER = "DBHawk File Manager";
export const BY_EMAIL = "E-mail";
const DELIVERIES = [TO_FILE_MANAGER, BY_EMAIL];

/** The model asked for e-mail delivery: delivery=email, or recipients without a delivery. */
const isEmail = (args) => (blank(args.delivery) ? !blank(args.emailTo) : /mail/i.test(String(args.delivery)));
const ATTEMPTS = 3;

const CONFIRM = {
  create_job: ["Create this job?", "Yes, create the job", "created"],
  update_job: ["Save these changes to the job?", "Yes, save the changes", "changed"],
  delete_job: ["Delete this job? It is unscheduled and removed for good.", "Yes, delete the job", "deleted"],
  resume_job: ["Resume this job? Its SQL runs again on schedule.", "Yes, resume the job", "resumed"],
  run_job: ["Run this job now?", "Yes, run it now", "run"],
  interrupt_job: ["Interrupt the running job?", "Yes, interrupt it", "interrupted"],
};

const blank = (v) => v === undefined || v === null || String(v).trim() === "";
const text = (v) => (blank(v) ? undefined : String(v).trim());
const valueOr = (v, fallback) => text(v) ?? fallback;
const bool = (v) => (v === undefined || v === null ? undefined : typeof v === "boolean" ? v : String(v).trim() === "true");

/** The Quartz cron of a schedule choice; for Custom the expression entered. Throws on a bad value. */
export function cronOf(schedule, time, custom) {
  if (schedule === CUSTOM) {
    if (blank(custom)) throw new Error(`enter a cron expression for "${CUSTOM}".`);
    return custom.trim();
  }
  const m = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(time || "");
  if (!m || +m[1] > 23 || +m[2] > 59) throw new Error("the time must be HH:mm, e.g. 08:00.");
  const hour = +m[1];
  const minute = +m[2];
  switch (schedule) {
    case EVERY_HOUR:
      return `0 ${minute} * * * ?`;
    case WEEKDAYS:
      return `0 ${minute} ${hour} ? * MON-FRI`;
    case MONDAYS:
      return `0 ${minute} ${hour} ? * MON`;
    case MONTHLY:
      return `0 ${minute} ${hour} 1 * ?`;
    default:
      return `0 ${minute} ${hour} * * ?`;
  }
}

// ---- form schema ---------------------------------------------------------------------------------

function form(fields) {
  const properties = {};
  const required = [];
  for (const field of fields) {
    if (!field) continue;
    const [name, schema, isRequired] = field;
    properties[name] = schema;
    if (isRequired) required.push(name);
  }
  return { type: "object", properties, required };
}

function prop(type, title, description) {
  const p = { type, title };
  if (description) p.description = description;
  return p;
}

function textField(title, description, value) {
  const p = prop("string", title, description);
  if (text(value) !== undefined) p.default = text(value);
  return p;
}

function choice(title, description, values, value) {
  const p = prop("string", title, description);
  p.enum = values;
  if (values.includes(value)) p.default = value;
  return p;
}

function flag(title, description, value) {
  const p = prop("boolean", title, description);
  p.default = !!value;
  return p;
}

/**
 * @param {object}   deps
 * @param {function} deps.call  (tool, args) => the DBHawk answer of a job tool / list_datasources / explain_cron / get_job
 * @param {function} deps.ask   (message, requestedSchema) => the user's answers, or null when declined / cancelled
 * @param {string}   [deps.defaultDatasource]  preselected datasource (DBHAWK_DEFAULT_DATASOURCE)
 */
export function createWizard({ call, ask, defaultDatasource }) {
  async function cronProblem(cron) {
    const explained = (await call("explain_cron", { cronExp: cron })) || {};
    if (explained.valid === false) {
      return `"${cron}" is not a valid cron expression${explained.error ? `: ${explained.error}` : "."}`;
    }
    return null;
  }

  async function askNewJob(args) {
    if (blank(args.datasource) || blank(args.name) || blank(args.statement)) {
      const list = await call("list_datasources", {});
      const datasources = (Array.isArray(list) ? list : []).map((d) => text(d && d.name)).filter(Boolean);
      if (!datasources.length) throw new Error("You have no datasources available over MCP, so no job can be created.");
      const preferred = text(args.datasource) ?? defaultDatasource;
      const answer = await ask(
        "New scheduled job (step 1 of 2): what should run?",
        form([
          ["datasource", choice("Datasource", "The database the job runs on", datasources,
            datasources.includes(preferred) ? preferred : datasources[0]), true],
          ["name", textField("Job name", "Also the start of the result file name", args.name), true],
          ["statement", textField("SQL statement", "ONE statement; its result is exported on every run", args.statement), true],
          ["schema", textField("Schema", "Where the statement runs (database for SQL Server); empty for the connection's default", args.schema), false],
        ])
      );
      if (!answer) return false;
      for (const key of ["datasource", "name", "statement", "schema"]) {
        const value = text(answer[key]);
        if (value !== undefined) args[key] = value;
        else if (key === "schema") delete args[key];
      }
      const missing = ["datasource", "name", "statement"].find((k) => blank(args[k]));
      if (missing) throw new Error(`The form came back without ${missing}.`);
    }
    if (blank(args.cronExp)) return askScheduleAndOutput(args);
    return true;
  }

  async function askScheduleAndOutput(args) {
    let problem = null;
    let schedule = EVERY_DAY;
    let time = "08:00";
    let cron = text(args.cronExp);
    let answer = null;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      answer = await ask(
        (problem ? `${problem}\n\n` : "") +
          `New scheduled job "${args.name}" (step 2 of 2): when should it run, and where should the result file go?`,
        form([
          ["schedule", choice("Schedule", "How often the job runs", SCHEDULES, schedule), true],
          ["time", textField("Time (HH:mm)", "Time of day of the run, server time; the minute for Every hour", time), false],
          ["cronExp", textField("Cron expression", "Only for Custom: Quartz cron, e.g. 0 30 6 ? * MON-FRI", cron), false],
          ["format", choice("Result format", undefined, FORMATS, valueOr(args.format, "csv")), true],
          ["delivery", choice("Deliver the file to", undefined, DELIVERIES, isEmail(args) ? BY_EMAIL : TO_FILE_MANAGER), true],
          ["emailTo", textField("E-mail to", "For E-mail: addresses, comma separated; empty = your own address", args.emailTo), false],
          ["compression", choice("Compression", undefined, COMPRESSIONS, valueOr(args.compression, "none")), false],
          ["showHeaders", flag("Header row", "Column names in csv / txt / xlsx", args.showHeaders !== false), false],
          ["notifyOnFailure", flag("E-mail me when a run fails", undefined, args.notifyOnFailure === true), false],
        ])
      );
      if (!answer) return false;
      schedule = valueOr(answer.schedule, EVERY_DAY);
      time = valueOr(answer.time, "08:00");
      cron = text(answer.cronExp);
      try {
        cron = cronOf(schedule, time, cron);
        problem = await cronProblem(cron);
      } catch (e) {
        problem = e.message;
      }
      if (!problem) break;
      problem = `Please correct the schedule: ${problem}`;
    }
    if (problem) throw new Error(problem);
    args.cronExp = cron;
    args.format = valueOr(answer.format, "csv");
    args.compression = valueOr(answer.compression, "none");
    if (answer.delivery === BY_EMAIL) {
      args.delivery = "email";
      if (text(answer.emailTo) !== undefined) args.emailTo = text(answer.emailTo);
      else delete args.emailTo;
    } else {
      args.delivery = "fileManager";
      delete args.emailTo;
    }
    if (answer.showHeaders !== undefined) args.showHeaders = bool(answer.showHeaders);
    if (answer.notifyOnFailure !== undefined) args.notifyOnFailure = bool(answer.notifyOnFailure);
    return true;
  }

  const onlyJobId = (args) => args.jobId !== undefined && Object.entries(args).every(([k, v]) => k === "jobId" || v === undefined);

  /** jobId plus the fields the user changed; null when they cancelled. */
  async function askChanges(args) {
    const job = (await call("get_job", { jobId: args.jobId })) || {};
    const schedule = job.schedule || {};
    const output = job.output || {};
    const notify = job.notify || {};
    const delivery = job.delivery || {};
    const changeableDelivery = !delivery.type || delivery.type === "fileManager" || delivery.type === "email";
    const saved = {
      name: job.name,
      statement: job.statement,
      schema: job.schema,
      cronExp: schedule.cronExp,
      format: output.format,
      compression: valueOr(output.compression, "none"),
      showHeaders: output.showHeaders !== false,
      notifyOnSuccess: notify.onSuccess === true,
      notifyOnFailure: notify.onFailure === true,
    };
    if (changeableDelivery) {
      saved.delivery = delivery.type === "email" ? BY_EMAIL : TO_FILE_MANAGER;
      saved.emailTo = delivery.type === "email" ? valueOr(delivery.target, "") : "";
    }
    const values = { ...saved };
    let problem = null;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const answer = await ask(
        (problem ? `${problem}\n\n` : "") + `Change job ${args.jobId} "${job.name}" on ${job.datasource}.`,
        form([
          ["name", textField("Job name", undefined, values.name), true],
          ["statement", textField("SQL statement", "ONE statement; its result is exported on every run", values.statement), true],
          ["schema", textField("Schema", "Where the statement runs; empty keeps it", values.schema), false],
          ["cronExp", textField("Cron expression", "Quartz cron, e.g. 0 0 8 ? * MON-FRI", values.cronExp), true],
          ["format", choice("Result format", undefined, FORMATS, valueOr(values.format, "csv")), true],
          changeableDelivery ? ["delivery", choice("Deliver the file to", undefined, DELIVERIES, values.delivery), true] : null,
          changeableDelivery
            ? ["emailTo", textField("E-mail to", "For E-mail: addresses, comma separated; empty = your own address", values.emailTo), false]
            : null,
          ["compression", choice("Compression", undefined, COMPRESSIONS, valueOr(values.compression, "none")), false],
          ["showHeaders", flag("Header row", undefined, values.showHeaders === true), false],
          ["notifyOnSuccess", flag("E-mail me when a run succeeds", undefined, values.notifyOnSuccess === true), false],
          ["notifyOnFailure", flag("E-mail me when a run fails", undefined, values.notifyOnFailure === true), false],
        ])
      );
      if (!answer) return null;
      for (const key of Object.keys(saved)) {
        if (key in answer) values[key] = typeof answer[key] === "string" ? answer[key].trim() : answer[key];
      }
      problem = values.cronExp === saved.cronExp ? null : await cronProblem(text(values.cronExp) ?? "");
      if (!problem) break;
      problem = `Please correct the schedule: ${problem}`;
    }
    if (problem) throw new Error(problem);

    const changes = { jobId: args.jobId };
    for (const key of Object.keys(saved)) {
      if (key === "delivery" || key === "emailTo") continue;
      const now = values[key];
      if (now === "") continue; // an emptied field keeps its value
      if (String(saved[key]) !== String(now)) changes[key] = now;
    }
    if (changeableDelivery) {
      const email = values.delivery === BY_EMAIL;
      if (values.delivery !== saved.delivery) changes.delivery = email ? "email" : "fileManager";
      // for e-mail, an emptied list means the user's own address
      if (email && String(values.emailTo ?? "") !== String(saved.emailTo)) changes.emailTo = values.emailTo ?? "";
    }
    return changes;
  }

  async function describe(job) {
    const lines = [];
    const line = (label, value) => value !== undefined && value !== null && lines.push(`${label}: ${value}`);
    line("Job", job.id === undefined ? job.name : `${job.id} "${job.name}"`);
    line("Datasource", job.datasource === undefined ? undefined : job.datasource + (job.schema ? ` / ${job.schema}` : ""));
    const cron = job.schedule && job.schedule.cronExp;
    if (cron) {
      let description;
      try {
        description = text(((await call("explain_cron", { cronExp: cron })) || {}).description);
      } catch {
        // the cron alone says it
      }
      line("Schedule", cron + (description ? ` (${description})` : ""));
    }
    const delivery = job.delivery || {};
    const to =
      delivery.type === "email"
        ? ` by e-mail to ${delivery.target}`
        : !delivery.type || delivery.type === "fileManager"
          ? " to your DBHawk File Manager"
          : ` by ${delivery.type}`;
    line("Output", job.output && job.output.format ? job.output.format + to : undefined);
    let out = lines.join("\n") + (lines.length ? "\n" : "");
    if (job.statement) out += `SQL:\n${job.statement}\n`;
    return out;
  }

  async function askConfirmation(tool, pending) {
    const [question, yes] = CONFIRM[tool];
    const type = pending.statementType ? ` (${pending.statementType})` : "";
    const others = Array.isArray(pending.emailRecipients) ? pending.emailRecipients : [];
    const why = others.length
      ? ` Its results are e-mailed to ${others.join(", ")}, so DBHawk asks you to confirm${type}.`
      : ` Your MCP tier asks you to confirm${type}.`;
    const message = `${question}${why}\n` + (await describe(pending.job || {}));
    const answer = await ask(message, form([["confirm", flag(yes, undefined, true), true]]));
    return !!answer && bool(answer.confirm) !== false;
  }

  function cancelled(tool) {
    return {
      cancelled: true,
      executed: false,
      tool,
      message: `The user cancelled the DBHawk form, so the job was not ${CONFIRM[tool][2]}. Do not call ${tool} again unless the user asks for it.`,
    };
  }

  return {
    async run(tool, input) {
      let args = { ...(input || {}) };
      for (const key of Object.keys(args)) if (args[key] === undefined) delete args[key];

      if (tool === "create_job" && ["datasource", "name", "statement", "cronExp"].some((k) => blank(args[k]))) {
        if (blank(args.datasource) && defaultDatasource && !blank(args.name) && !blank(args.statement)) {
          args.datasource = defaultDatasource;
        }
        if (["datasource", "name", "statement", "cronExp"].some((k) => blank(args[k])) && !(await askNewJob(args))) {
          return cancelled(tool);
        }
      } else if (tool === "update_job" && onlyJobId(args)) {
        const changes = await askChanges(args);
        if (!changes) return cancelled(tool);
        if (Object.keys(changes).length === 1) {
          return { updated: false, jobId: args.jobId, message: "The user changed nothing in the form; the job is as it was." };
        }
        args = changes;
      }

      let result = await call(tool, args);
      if (args.confirm === undefined && result && result.confirmationRequired === true) {
        if (!(await askConfirmation(tool, result))) return cancelled(tool);
        args.confirm = true;
        result = await call(tool, args);
        if (result && typeof result === "object") {
          result = { ...result, confirmation: "approved by the user in the DBHawk confirmation form" };
        }
      }
      return result;
    },
  };
}
