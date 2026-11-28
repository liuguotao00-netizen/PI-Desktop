/**
 * Error shape shared by the executor, the driver and the tool surface.
 *
 * Every failure carries a stable `code` so the run record, the agent and the
 * UI can branch on it without parsing prose.
 */

export type CodedError = Error & {
  code: string;
  details?: Record<string, unknown>;
};

export function codedError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): CodedError {
  const error = new Error(message) as CodedError;
  error.name = "AutomationError";
  error.code = code;
  if (details) error.details = details;
  return error;
}

/** A bundled script or manifest that cannot be interpreted. */
export class ContractError extends Error {
  readonly code = "AUTOMATION_BAD_SCRIPT";

  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}
