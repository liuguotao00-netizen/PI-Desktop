"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RiskControlError = exports.ContractError = exports.PrivateBrowserError = void 0;
class PrivateBrowserError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = "PrivateBrowserError";
    }
}
exports.PrivateBrowserError = PrivateBrowserError;
class ContractError extends Error {
}
exports.ContractError = ContractError;
class RiskControlError extends Error {
}
exports.RiskControlError = RiskControlError;
