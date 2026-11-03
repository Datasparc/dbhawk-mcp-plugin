/**
 * Creating a job as a conversation, for an MCP client that has neither forms (elicitation) nor the job screen - the
 * same flow as DBHawk's own MCP server (McpJobDialog). The model is the one talking to the user, so the model asks;
 * DBHawk says what to ask and when. A create_job that is missing something is not an error: it is answered with the
 * next question (questionRequired), the model puts that question to the user and calls create_job again with their
 * answer. Nothing is kept here: every answer travels in the tool arguments, and the `dialog` argument carries back
 * what has been asked already, so a job the model specifies in full is still created in one call.
 */

export const DIALOG_TOOLS = new Set(["create_job"]);

/** The argument that carries back what DBHawk has asked about so far, unchanged from the previous answer. */
export const TOKEN = "dialog";

export const FORMATS = ["csv", "txt", "html", "pdf", "xlsx", "json", "parquet"];
/** Not an argument of its own: the question that fills format, delivery and emailTo. */
const OUTPUT = "output";

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
      case OUTPUT:
        return (
          `${ask}${again} Their answer goes into 'format' (one of 'options'), and into 'delivery' ("fileManager" or ` +
          `"email") with 'emailTo' when they want it e-mailed - an empty 'emailTo' means their own address. If the ` +
          `defaults suit them, call again with format="csv" and delivery="fileManager".`
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
    const cron = text(args.cronExp);
    const problem = cron === undefined ? null : await cronProblem(cron);
    if (cron === undefined || problem) {
      delete args.cronExp;
      return question(
        "cronExp",
        `${problem ? ended(problem) + " " : ""}How often should the job run, and at what time? For example "every weekday at 8:00" or "on the 1st of every month at 23:30".`,
        null,
        args,
        soFar
      );
    }
    if (soFar.length && !soFar.includes(OUTPUT) && blank(args.format) && blank(args.delivery)) {
      return question(
        OUTPUT,
        "In which format should the result file be, and where should it go? DBHawk writes csv into your File Manager unless you say otherwise.",
        FORMATS,
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
