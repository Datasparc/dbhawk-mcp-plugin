/**
 * Network failures of the bridge's calls to DBHawk. Node's fetch reports every failure without an HTTP response as
 * the bare "fetch failed"; the reason - connection reset or refused, DNS, TLS, timeout - is in its cause, so it is
 * spelled out here, and calls that cannot change anything are retried after a short wait.
 */

/**
 * Waits before each retry of a request that got no HTTP response at all (connection reset or refused, DNS failure,
 * DBHawk restarting): an immediate retry often lands on the same outage, a few seconds later it usually works.
 * DBHAWK_RETRY_DELAYS_MS overrides the list (comma separated; empty = never retry).
 */
export const RETRY_DELAYS_MS = (process.env.DBHAWK_RETRY_DELAYS_MS ?? "1000,3000,8000")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s !== "")
  .map(Number)
  .filter((n) => Number.isFinite(n) && n >= 0);

/**
 * Network failures that happen before a connection to DBHawk exists, so the request never reached it: safe to retry
 * even for a statement that changes data. A reset or timeout on an open connection is not in the list - the
 * statement may already have run.
 */
const NOT_SENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** The low-level error behind fetch's generic "fetch failed": the code and message of its cause. */
export function networkCause(e) {
  let cause = e && e.cause;
  // a host with several addresses fails with an AggregateError of one error per address
  if (cause && !cause.code && Array.isArray(cause.errors) && cause.errors.length) cause = cause.errors[0];
  return { code: (cause && cause.code) || "", message: (cause && cause.message) || "" };
}

export function describeNetworkError(e) {
  const { code, message } = networkCause(e);
  const detail = [code, message && message !== code ? message : ""].filter(Boolean).join(": ");
  return detail ? `${e.message} (${detail})` : e.message;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * fetch, retried when no HTTP response came back. A request that cannot change anything (`idempotent`) is retried
 * on any network failure; any other only when it provably never reached DBHawk (NOT_SENT_CODES). An HTTP response,
 * whatever its status, is returned as is - error statuses are handled by the caller.
 */
export async function fetchWithRetry(method, url, init, idempotent) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      const notSent = NOT_SENT_CODES.has(networkCause(e).code);
      const detail = describeNetworkError(e);
      if (attempt >= RETRY_DELAYS_MS.length || !(idempotent || notSent)) {
        const attempts = attempt > 0 ? ` (${attempt + 1} attempts)` : "";
        const maybeRan =
          idempotent || notSent
            ? ""
            : ". The connection was lost after the request was sent, so DBHawk may or may not have executed it;" +
              " it was not retried automatically. Check the data (or DBHawk's SQL log) before running it again.";
        throw new Error(`Network error calling ${method} ${url}: ${detail}${attempts}${maybeRan}`);
      }
      const delay = RETRY_DELAYS_MS[attempt];
      console.error(
        `[dbhawk-mcp] ${method} ${url}: ${detail} - no response, retrying in ${delay} ms` +
          ` (attempt ${attempt + 2} of ${RETRY_DELAYS_MS.length + 1})`
      );
      await sleep(delay);
    }
  }
}
