"use strict";
/**
 * Error shape shared by the executor, the driver and the tool surface.
 *
 * Every failure carries a stable `code` so the run record, the agent and the
 * UI can branch on it without parsing prose.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContractError = void 0;
exports.codedError = codedError;
function codedError(code, message, details) {
    const error = new Error(message);
    error.name = "AutomationError";
    error.code = code;
    if (details)
        error.details = details;
    return error;
}
/** A bundled script or manifest that cannot be interpreted. */
class ContractError extends Error {
    code = "AUTOMATION_BAD_SCRIPT";
    constructor(message) {
        super(message);
        this.name = "ContractError";
    }
}
exports.ContractError = ContractError;
