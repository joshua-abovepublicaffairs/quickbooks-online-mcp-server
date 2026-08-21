import fs from "fs";
import os from "os";
import path from "path";

// Mirrors the QUICKBOOKS_TOKEN_STORE_PATH pattern in quickbooks-client.ts: an
// absolute env var override takes precedence; otherwise the log defaults to
// sitting beside wherever the token store resolves (same writable volume),
// falling back to a fixed path under the user's config dir when no token
// store override is configured either.
const errorLogPathOverride = process.env.QUICKBOOKS_ERROR_LOG_PATH?.trim();
if (errorLogPathOverride && !path.isAbsolute(errorLogPathOverride)) {
  throw Error(
    `QUICKBOOKS_ERROR_LOG_PATH must be an absolute path, got "${errorLogPathOverride}"`
  );
}

const tokenStorePathOverride = process.env.QUICKBOOKS_TOKEN_STORE_PATH?.trim();

export const ERROR_LOG_PATH =
  errorLogPathOverride ||
  (tokenStorePathOverride && path.isAbsolute(tokenStorePathOverride)
    ? path.join(path.dirname(tokenStorePathOverride), "error.log")
    : path.join(os.homedir(), ".config", "quickbooks-mcp", "error.log"));

export interface ErrorLogEntry {
  message: string;
  operation?: string;
  status?: number;
  intuitTid?: string;
}

// Pull the safe half out of a QuickBooks Fault body. `code` and `Message` are
// from Intuit's fixed error catalogue; `Detail` is NOT — it echoes the submitted
// payload (customer names, amounts, account names, addresses), so it is never
// read here.
function faultSummary(error: object): string | undefined {
  const fault = (error as { Fault?: unknown }).Fault;
  if (!fault || typeof fault !== "object") return undefined;
  const faults = (fault as { Error?: unknown }).Error;
  if (!Array.isArray(faults)) return undefined;

  const parts: string[] = [];
  for (const entry of faults) {
    if (!entry || typeof entry !== "object") continue;
    const { code, Message } = entry as { code?: unknown; Message?: unknown };
    const bits: string[] = [];
    if (typeof code === "string") bits.push(`code ${code}`);
    if (typeof Message === "string") bits.push(Message);
    if (bits.length > 0) parts.push(bits.join(": "));
  }
  return parts.length > 0 ? `QuickBooks Fault (${parts.join("; ")})` : undefined;
}

function rawMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  // Objects reaching here are overwhelmingly node-quickbooks Fault bodies: on a
  // Fault the client invokes callback(body, ...) with the RAW response object,
  // so stringifying it wholesale would dump customer data into the log. Keep the
  // allow-listed Fault fields and withhold everything else — the operation,
  // status, and intuitTid captured below are what support triage actually needs.
  if (error !== null && typeof error === "object") {
    return faultSummary(error) ?? "Non-Error object (contents withheld)";
  }
  // Primitives can't carry a response body.
  return String(error);
}

// Best-effort extraction of the request path from an axios request URL,
// dropping the query string (which can carry filter values) and tolerating
// values that aren't a well-formed absolute URL.
function requestPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split("?")[0];
  }
}

function extractOperation(config: unknown): string | undefined {
  if (!config || typeof config !== "object") return undefined;
  const { method, url } = config as { method?: unknown; url?: unknown };
  if (typeof method !== "string" || typeof url !== "string") return undefined;
  return `${method.toUpperCase()} ${requestPath(url)}`;
}

function extractStatus(response: unknown): number | undefined {
  if (!response || typeof response !== "object") return undefined;
  const { status } = response as { status?: unknown };
  return typeof status === "number" ? status : undefined;
}

function extractIntuitTid(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const { headers } = response as { headers?: unknown };
  if (!headers || typeof headers !== "object") return undefined;
  const tid = (headers as Record<string, unknown>)["intuit_tid"];
  return typeof tid === "string" ? tid : undefined;
}

/**
 * Builds the JSON-serializable entry for one caught error, pulling in the
 * axios request/response shape opportunistically when present (a QuickBooks
 * API failure) without ever including request/response bodies — those can
 * carry customer data or tokens, and this is a troubleshooting log, not a
 * data dump.
 */
export function buildLogEntry(error: unknown): ErrorLogEntry {
  const err = error && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
  const entry: ErrorLogEntry = { message: rawMessage(error) };

  const operation = extractOperation(err?.config);
  if (operation) entry.operation = operation;

  const status = extractStatus(err?.response);
  if (status !== undefined) entry.status = status;

  const intuitTid = extractIntuitTid(err?.response);
  if (intuitTid) entry.intuitTid = intuitTid;

  return entry;
}

// Cap the log so a persistent failure (revoked token, wrong realm, Intuit
// outage) can't fill the volume: every tool call errors, and each one appends.
// At the cap the current file becomes a single .1 backup and a fresh log
// starts, bounding total usage at two files.
const MAX_LOG_BYTES = 5 * 1024 * 1024;

// The directory create, the size probe, and the chmod each only need to succeed
// once per process. Repeating them made every logged error four blocking
// syscalls, which serializes the server during an error storm — a dead refresh
// token fails all ~430 handler call sites. Only the append stays per-call.
let logDirReady = false;
let logFileBytes: number | undefined;
let logModeSet = false;

function ensureLogDir(): void {
  if (logDirReady) return;
  fs.mkdirSync(path.dirname(ERROR_LOG_PATH), { recursive: true });
  logDirReady = true;
}

function currentLogBytes(): number {
  if (logFileBytes === undefined) {
    try {
      logFileBytes = fs.statSync(ERROR_LOG_PATH).size;
    } catch {
      logFileBytes = 0; // no log yet
    }
  }
  return logFileBytes;
}

function rotateLog(): void {
  try {
    fs.renameSync(ERROR_LOG_PATH, `${ERROR_LOG_PATH}.1`);
  } catch {
    return; // couldn't rotate — keep appending rather than drop the entry
  }
  logFileBytes = 0;
  logModeSet = false; // the fresh file needs its mode restated
}

/**
 * Appends one JSON line to the local troubleshooting log for every caught
 * error, so a failure can be handed to Intuit support or replayed later.
 * Best-effort: a logging failure here must never surface to the caller or
 * mask the original error.
 */
export function logError(error: unknown): void {
  try {
    const line =
      JSON.stringify({ timestamp: new Date().toISOString(), ...buildLogEntry(error) }) + "\n";
    const bytes = Buffer.byteLength(line);

    ensureLogDir();
    if (currentLogBytes() + bytes > MAX_LOG_BYTES) rotateLog();

    fs.appendFileSync(ERROR_LOG_PATH, line, { mode: 0o600 });
    logFileBytes = currentLogBytes() + bytes;

    if (!logModeSet) {
      // appendFileSync's mode only applies when the file is newly created and is
      // masked by the process umask even then, so restate it explicitly.
      try {
        fs.chmodSync(ERROR_LOG_PATH, 0o600);
      } catch {
        /* best effort */
      }
      logModeSet = true;
    }
  } catch {
    /* the troubleshooting log is best-effort and must never break the caller */
  }
}
