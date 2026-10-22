/**
 * DBHawk sign-in for the bridge, used when no DBHAWK_TOKEN is configured: the OAuth 2.1 authorization server built
 * into DBHawk (7.0.1+, see docs/mcp-native-connector.md in the DBHawk repository), as a native app does it
 * (RFC 8252): dynamic client registration, the system browser for the DBHawk sign-in (password, LDAP, 2FA or SSO -
 * whatever the DBHawk login page offers) and a one-time listener on 127.0.0.1 for the redirect, PKCE S256.
 *
 * The refresh token is kept in a file only the user can read (one per DBHawk URL), so the browser opens once; DBHawk
 * rotates it on every refresh. The access token stays in memory. If the user does not finish signing in while a
 * tool call waits, the call fails with a message saying so and the sign-in keeps waiting in the background: the
 * next call picks the result up instead of opening another browser window.
 */

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

/** How long a tool call waits for the browser sign-in before it answers "finish signing in, then retry". */
const DEFAULT_CALL_WAIT_MS = 45_000;
/** How long the redirect listener stays open for one sign-in. */
const DEFAULT_SIGN_IN_TTL_MS = 10 * 60_000;
/** An access token this close to expiry is refreshed before use. */
const EXPIRY_SKEW_MS = 30_000;

const REDIRECT_PATH = "/callback";

/** A refusal the user has to act on (sign in, get MCP access); its message is shown to the model as is. */
export class SignInError extends Error {}

/** Where the refresh token lives: the per-user config directory of the platform. */
export function defaultStoreDir() {
  if (process.env.DBHAWK_OAUTH_STORE_DIR) return process.env.DBHAWK_OAUTH_STORE_DIR;
  if (process.platform === "win32" && process.env.APPDATA) return path.join(process.env.APPDATA, "dbhawk-mcp");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "dbhawk-mcp");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "dbhawk-mcp");
}

const base64url = (buffer) => buffer.toString("base64url");

/** PKCE S256 pair (RFC 7636). */
export function pkcePair() {
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** Opens a URL in the system browser without a shell parsing it (an authorize URL is full of '&'). */
export function openBrowser(url) {
  const custom = (process.env.DBHAWK_BROWSER || "").trim();
  if (custom === "none") return false;
  let command;
  let args;
  if (custom) {
    command = custom;
    args = [url];
  } else if (process.platform === "win32") {
    command = "rundll32";
    args = ["url.dll,FileProtocolHandler", url];
  } else if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", shell: false });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.apiRoot     DBHawk base URL + "/api"
 * @param {function} [opts.headers] extra request headers (client identification)
 * @param {function} [opts.log]     diagnostics to stderr
 * @param {string} [opts.clientName]
 */
export function createOAuthSession(opts) {
  const apiRoot = opts.apiRoot;
  const oauthRoot = apiRoot + "/oauth";
  const resource = apiRoot + "/v2/mcp/rpc";
  const log = opts.log || (() => {});
  const extraHeaders = opts.headers || (() => ({}));
  const callWaitMs = Number(process.env.DBHAWK_OAUTH_WAIT_MS) || DEFAULT_CALL_WAIT_MS;
  const signInTtlMs = Number(process.env.DBHAWK_OAUTH_SIGNIN_TTL_MS) || DEFAULT_SIGN_IN_TTL_MS;

  const storeDir = defaultStoreDir();
  const storeFile = path.join(storeDir, `oauth-${createHash("sha256").update(apiRoot).digest("hex").slice(0, 16)}.json`);

  let accessToken = null;
  let accessExpiresAt = 0;
  /** In-flight refresh / sign-in, shared by concurrent tool calls. */
  let pending = null;
  /** The browser sign-in in progress: { promise, url }. */
  let signIn = null;

  function readStore() {
    try {
      const data = JSON.parse(fs.readFileSync(storeFile, "utf8"));
      return data && data.apiRoot === apiRoot ? data : {};
    } catch {
      return {};
    }
  }

  function writeStore(data) {
    fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    const tmp = storeFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ ...data, apiRoot }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, storeFile);
    try {
      fs.chmodSync(storeFile, 0o600);
    } catch {
      // best effort on Windows, where the file inherits the per-user AppData ACL
    }
  }

  async function post(url, form) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { ...extraHeaders(), Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
      });
    } catch (e) {
      throw new Error(`Network error calling POST ${url}: ${e.message}`);
    }
    const text = await res.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { error: "invalid_response", error_description: text.slice(0, 300) };
    }
    return { status: res.status, ok: res.ok, body };
  }

  function accept(body) {
    if (!body.access_token) throw new Error("DBHawk token response did not contain an access_token");
    accessToken = body.access_token;
    accessExpiresAt = Date.now() + (Number(body.expires_in) > 0 ? Number(body.expires_in) * 1000 : 60 * 60_000);
    const store = readStore();
    if (body.refresh_token) store.refreshToken = body.refresh_token;
    writeStore(store);
    return accessToken;
  }

  /** Dynamic client registration, once per DBHawk URL; the loopback port may differ per sign-in (RFC 8252 7.3). */
  async function clientId() {
    const store = readStore();
    if (store.clientId) return store.clientId;

    const url = oauthRoot + "/register";
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { ...extraHeaders(), Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: opts.clientName || "DBHawk extension",
          redirect_uris: [`http://127.0.0.1${REDIRECT_PATH}`],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      });
    } catch (e) {
      throw new Error(`Network error calling POST ${url}: ${e.message}`);
    }
    const text = await res.text();
    if (res.status === 404 || res.status === 405) {
      throw new SignInError("This DBHawk server does not support signing in from the extension (it needs DBHawk 7.0.1 " +
        "with the MCP connector). Configure a personal MCP token (DBHawk -> User Profile -> API Token) instead.");
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = {};
    }
    if (!res.ok || !body.client_id) {
      throw new Error(`DBHawk client registration failed: ${res.status}${text ? ": " + text.slice(0, 300) : ""}`);
    }
    writeStore({ ...store, clientId: body.client_id, refreshToken: undefined });
    return body.client_id;
  }

  async function refresh(refreshToken, id) {
    const res = await post(oauthRoot + "/token", { grant_type: "refresh_token", refresh_token: refreshToken, client_id: id });
    if (res.ok) return accept(res.body);
    if (res.body.error === "invalid_grant" || res.body.error === "invalid_client" || res.status === 401) {
      // revoked, expired, rotated away, or an SSO user who has to sign in again: back to the browser
      log(`stored DBHawk sign-in is no longer valid (${res.body.error_description || res.body.error}), signing in again`);
      const store = readStore();
      delete store.refreshToken;
      writeStore(store);
      return null;
    }
    if (res.body.error === "access_denied") {
      throw new SignInError(`DBHawk refused access: ${res.body.error_description || "access denied"}`);
    }
    throw new Error(`DBHawk token refresh failed: ${res.status} ${res.body.error_description || res.body.error || ""}`);
  }

  /** Starts the browser sign-in: listener on 127.0.0.1, the authorize URL in the browser, the code exchange. */
  async function startSignIn(id) {
    const { verifier, challenge } = pkcePair();
    const state = base64url(randomBytes(24));

    let resolveCode;
    let rejectCode;
    const codePromise = new Promise((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });

    const listener = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== REDIRECT_PATH) {
        res.statusCode = 404;
        res.end();
        return;
      }
      if (url.searchParams.get("state") !== state) {
        res.statusCode = 400;
        res.end("This sign-in request is not the one the DBHawk extension is waiting for.");
        return;
      }
      const error = url.searchParams.get("error");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(page(error ? "DBHawk was not connected" : "DBHawk is connected",
        error ? (url.searchParams.get("error_description") || error) : "You can close this tab and return to Claude."));
      if (error) {
        rejectCode(new SignInError(`DBHawk sign-in was not completed: ${url.searchParams.get("error_description") || error}`));
      } else {
        resolveCode(url.searchParams.get("code"));
      }
    });
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    const redirectUri = `http://127.0.0.1:${listener.address().port}${REDIRECT_PATH}`;

    const authorizeUrl = `${oauthRoot}/authorize?` + new URLSearchParams({
      response_type: "code",
      client_id: id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      scope: "mcp",
      resource,
    }).toString();

    const timer = setTimeout(() => rejectCode(new SignInError("The DBHawk sign-in timed out. Try again.")), signInTtlMs);
    timer.unref();

    const promise = codePromise
      .then(async (code) => {
        const res = await post(oauthRoot + "/token", {
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: id,
          code_verifier: verifier,
        });
        if (!res.ok) {
          throw new SignInError(`DBHawk sign-in failed: ${res.body.error_description || res.body.error || res.status}`);
        }
        log("signed in to DBHawk");
        return accept(res.body);
      })
      .finally(() => {
        clearTimeout(timer);
        listener.close();
      });
    // nobody may be awaiting it when it fails (the call that started it gave up waiting): do not crash the process
    promise.catch(() => {});

    const opened = openBrowser(authorizeUrl);
    log(`${opened ? "opened the browser for" : "sign in at"} ${authorizeUrl}`);
    return { promise, url: authorizeUrl, opened };
  }

  async function obtain() {
    const id = await clientId();
    const store = readStore();
    if (store.refreshToken) {
      const token = await refresh(store.refreshToken, id);
      if (token) return token;
    }

    if (!signIn) {
      signIn = await startSignIn(id);
      signIn.promise.then(() => (signIn = null), () => (signIn = null));
    }
    const current = signIn;
    let timer;
    const waited = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), callWaitMs);
    });
    const token = await Promise.race([current.promise, waited]);
    clearTimeout(timer);
    if (token) return token;
    throw new SignInError(
      "Sign in to DBHawk in the browser window that " + (current.opened ? "just opened" : "you open at the URL below") +
      ", approve the access, then repeat this request. If no window appeared, open: " + current.url);
  }

  return {
    /** A valid access token: the cached one, a refreshed one, or one from the browser sign-in. */
    async accessToken() {
      if (accessToken && Date.now() < accessExpiresAt - EXPIRY_SKEW_MS) return accessToken;
      if (!pending) {
        pending = obtain().finally(() => (pending = null));
      }
      return pending;
    },
    /** Forget the access token after a 401, so the next call refreshes it. */
    invalidate() {
      accessToken = null;
      accessExpiresAt = 0;
    },
    storeFile,
  };
}

function page(title, message) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head>` +
    `<body style="font-family:sans-serif;margin:64px auto;max-width:480px"><h2>${esc(title)}</h2><p>${esc(message)}</p></body></html>`;
}
