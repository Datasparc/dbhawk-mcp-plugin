/**
 * Creating a job as a conversation, for an MCP client without forms (elicitation) - the same flow as DBHawk's own
 * MCP server (McpJobDialog). The model is the one talking to the user, so the model asks; DBHawk says what to ask
 * and when. A create_job still to be asked about is not an error: it is answered with the next question
 * (questionRequired), the model puts that question to the user and calls create_job again with their answer.
 * Every question is asked only where the model has not been told the answer, and the schedule, the format and the
 * delivery are never taken from the model unseen: a job that arrives with all three is put to the user in ONE
 * question ("Is that right?"), and a field they want changed is asked on its own when the model calls again without
 * it. Nothing is kept here: every answer travels in the tool arguments, and `dialog` carries back what was asked.
 */

export const DIALOG_TOOLS = new Set(["create_job"]);

/** The argument that carries back what DBHawk has asked about so far, unchanged from the previous answer. */
export const TOKEN = "dialog";

export const FORMATS = ["csv", "txt", "html", "pdf", "xlsx", "json", "parquet"];
export const TO_FILE_MANAGER = "DBHawk File Manager";
export const BY_EMAIL = "E-mail";
export const DELIVERIES = [TO_FILE_MANAGER, BY_EMAIL];
/** Not an argument of its own: the one question that puts a schedule and output the model brought to the user. */
const SETUP = "setup";

const blank = (v) => v === undefined || v === null || String(v).trim() === "";
const text = (v) => (blank(v) ? undefined : String(v).trim());

/**
 * @param {object}   deps
 * @param {function} deps.call  (tool, args) => the DBHawk answer of a job tool / list_datasources / explain_cron
 * @param {string}   [deps.defaultDatasource]  preselected datasource (DBHAWK_DEFAULT_DATASOURCE)
 */
export function createDialog({ call, defaultDatasource }) {
  async function datasourceNames() {
    const list = await call("list_datasources", {});
    return Array.isArray(list) ? list.map((d) => d && d.name).filter((name) => !blank(name)) : [];
  }

  async function cronProblem(cron) {
    const explained = (await call("explain_cron", { cronExp: cron })) || {};
    if (explained.valid === false) {
      return `"${cron}" is not a valid cron expression${explained.error ? `: ${explained.error}` : "."}`;
    }
    return null;
  }

  /** How the scheduler reads the cron the model proposed, or the expression itself when it says nothing. */
  async function describeCron(cron) {
    const explained = (await call("explain_cron", { cronExp: cron })) || {};
    return text(explained.description) ?? cron;
  }

  /** Where the file goes, as part of a sentence: "to your DBHawk File Manager" / "by e-mail to ...". */
  function deliveryPhrase(args) {
    const delivery = text(args.delivery);
    if (delivery !== undefined && /^email$/i.test(delivery)) {
      const emailTo = text(args.emailTo);
      return `by e-mail to ${emailTo === undefined ? "your own address" : emailTo}`;
    }
    return "to your DBHawk File Manager";
  }

  /** What the model already put down for the delivery, as the user would hear it. */
  function deliverySoFar(args) {
    const delivery = text(args.delivery);
    if (delivery === undefined) return undefined;
    if (!/mail/i.test(delivery)) return TO_FILE_MANAGER;
    const emailTo = text(args.emailTo);
    return `${BY_EMAIL}${emailTo === undefined ? " to your own address" : " to " + emailTo}`;
  }

  /** The value the model proposed, offered to the user so they can keep it or say something else. */
  const proposed = (value) => (value === undefined ? "" : ` So far it is "${value}" - ask whether that is what they want.`);

  /** The fields DBHawk has already asked about, from the token of the previous answer. */
  function asked(token) {
    const value = text(token);
    if (value === undefined) return [];
    return [...new Set(value.split(",").map((f) => f.trim()).filter(Boolean))];
  }

  /** The reason a cron was refused, as a sentence: Quartz does not end its messages with a stop. */
  const ended = (problem) => (/[.!?]$/.test(problem) ? problem : problem + ".");

  function instruction(field, marker) {
    const ask = "Put this question to the user and wait for their answer - do not answer it yourself and do not guess a value. ";
    const again = `Then call create_job again with the arguments in 'job', the user's answer and ${TOKEN}="${marker}".`;
    switch (field) {
      case "datasource":
        return `${ask}${again} The answer goes into 'datasource' and has to be one of 'options'.`;
      case "cronExp":
        return `${ask}${again} Turn what they say into a Quartz cron expression for 'cronExp' (check it with explain_cron first); DBHawk asks again if it is not valid.`;
      case SETUP:
        return (
          `${ask}If they are happy with it, call create_job again with the arguments in 'job' and ${TOKEN}="${marker}" ` +
          `unchanged. If they want the schedule, the format or the delivery changed, call it the same way but ` +
          `WITHOUT that argument ('cronExp', 'format' or 'delivery'), and DBHawk asks them for it.`
        );
      case "format":
        return (
          `${ask}${again} The answer goes into 'format' and has to be one of 'options'; keep the value already in ` +
          `'job' when the user is happy with it.`
        );
      case "delivery":
        return (
          `${ask}${again} Their answer goes into 'delivery' ("fileManager" or "email") with 'emailTo' when they ` +
          `want it e-mailed - an empty 'emailTo' means their own address.`
        );
      default:
        return `${ask}${again} The answer goes into '${field}'.`;
    }
  }

  function question(field, what, options, args, soFar) {
    const marker = soFar.includes(field) ? soFar.join(",") : [...soFar, field].join(",");
    const asking = {
      questionRequired: true,
      created: false,
      field,
      question: what,
      ...(options && options.length ? { options } : {}),
      [TOKEN]: marker,
      job: { ...args },
      message: instruction(field, marker),
    };
    return asking;
  }

  /** The question to put to the user now, or null when the job has everything it needs. */
  async function next(args, soFar) {
    // with DBHAWK_DEFAULT_DATASOURCE there is nothing to ask: the call resolves it on its own
    if (blank(args.datasource) && blank(defaultDatasource)) {
      const datasources = await datasourceNames();
      if (!datasources.length) throw new Error("You have no datasources available over MCP, so no job can be created.");
      return question("datasource", "Which datasource should the job run on?", datasources, args, soFar);
    }
    if (blank(args.name)) {
      return question("name", "What should the job be called? The name also starts the name of every result file.", null, args, soFar);
    }
    if (blank(args.statement)) {
      return question(
        "statement",
        "Which SQL statement should the job run? It has to be ONE statement; its result is what every run exports.",
        null,
        args,
        soFar
      );
    }
    // The schedule, the format and the delivery are the user's to choose, never the model's to decide. A job whose
    // three the model brings along is put to the user in ONE question; anything left out is asked on its own, and so
    // is a field the user then wants changed (the model calls again without it).
    let cron = text(args.cronExp);
    const problem = cron === undefined ? null : await cronProblem(cron);
    if (problem) {
      delete args.cronExp;
      cron = undefined;
    }
    if (cron === undefined) {
      return question(
        "cronExp",
        `${problem ? ended(problem) + " " : ""}How often should the job run, and at what time? For example "every weekday at 8:00" or "on the 1st of every month at 23:30".`,
        null,
        args,
        soFar
      );
    }
    const untouched = !["cronExp", "format", "delivery", SETUP].some((f) => soFar.includes(f));
    const format = text(args.format);
    const delivery = deliverySoFar(args);
    if (untouched && format !== undefined && delivery !== undefined) {
      return question(
        SETUP,
        `The job would run ${await describeCron(cron)} and export ${format} ${deliveryPhrase(args)}. Is that right?`,
        null,
        args,
        soFar
      );
    }
    if (soFar.includes(SETUP)) {
      // the user has seen the three together; only what they asked to change comes back empty
      if (format === undefined) {
        return question("format", "In which format should the result file be?", FORMATS, args, soFar);
      }
      if (delivery === undefined) {
        return question("delivery", "Where should the result file go - into your DBHawk File Manager, or by e-mail?", DELIVERIES, args, soFar);
      }
      return null;
    }
    if (!soFar.includes("cronExp")) {
      return question(
        "cronExp",
        `How often should the job run, and at what time? For example "every weekday at 8:00" or "on the 1st of every month at 23:30".` +
          proposed(await describeCron(cron)),
        null,
        args,
        soFar
      );
    }
    if (!soFar.includes("format")) {
      return question("format", "In which format should the result file be?" + proposed(format), FORMATS, args, soFar);
    }
    if (!soFar.includes("delivery")) {
      return question(
        "delivery",
        "Where should the result file go - into your DBHawk File Manager, or by e-mail?" + proposed(delivery),
        DELIVERIES,
        args,
        soFar
      );
    }
    return null;
  }

  return {
    /** The next question for the user, or - when the job is complete - what the tool itself answers. */
    async run(tool, args) {
      const values = { ...(args || {}) };
      const soFar = asked(values[TOKEN]);
      delete values[TOKEN];
      return (await next(values, soFar)) || call(tool, values);
    },
  };
}
