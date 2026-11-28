"use strict";

class PrivateBrowserError extends Error {
  code: string;
  details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "PrivateBrowserError";
  }
}

class ContractError extends Error {}
class RiskControlError extends Error {}

export { PrivateBrowserError, ContractError, RiskControlError };
