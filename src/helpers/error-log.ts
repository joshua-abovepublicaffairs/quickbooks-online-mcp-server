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

function rawMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return JSON.stringify(error);
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

/**
 * Appends one JSON line to the local troubleshooting log for every caught
 * error, so a failure can be handed to Intuit support or replayed later.
 * Best-effort: a logging failure here must never surface to the caller or
 * mask the original error.
 */
export function logError(error: unknown): void {
  try {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...buildLogEntry(error) });
    fs.mkdirSync(path.dirname(ERROR_LOG_PATH), { recursive: true });
    fs.appendFileSync(ERROR_LOG_PATH, line + "\n", { mode: 0o600 });
    // appendFileSync's mode only applies when the file is newly created and is
    // masked by the process umask even then, so restate it explicitly.
    try {
      fs.chmodSync(ERROR_LOG_PATH, 0o600);
    } catch {
      /* best effort */
    }
  } catch {
    /* the troubleshooting log is best-effort and must never break the caller */
  }
}
