import { logError } from "./error-log.js";

export interface FormatErrorOptions {
  /**
   * Append the error to the local troubleshooting log. Defaults to true so the
   * ~430 existing handler call sites keep recording intuit_tid for support
   * triage. Pass false when formatting an error that has already been logged
   * (an inner catch whose error an outer catch will format again) or when the
   * message is wanted without the disk write.
   */
  log?: boolean;
}

/**
 * Formats an error into a standardized error message.
 *
 * Note the side effect: by default this also appends the error to the local
 * troubleshooting log (see error-log.ts). Opt out with `{ log: false }`.
 *
 * @param error Any error object to format
 * @param options Formatting options
 * @returns A formatted error message as a string
 */
export function formatError(error: unknown, options?: FormatErrorOptions): string {
  if (options?.log !== false) logError(error);
  if (error instanceof Error) {
    return `Error: ${error.message}`;
  } else if (typeof error === 'string') {
    return `Error: ${error}`;
  } else {
    return `Unknown error: ${JSON.stringify(error)}`;
  }
}
