"use strict";

/**
 * 统一的错误形状。
 *
 * 这个插件最重要的设计约束是：缺依赖时必须给出**明确错误**，而不是静默失败或
 * 假装成功。每一次失败都带上 code、message 和（能给出时的）hint，agent 才能自己
 * 判断是该装依赖、还是该换会话类型。
 */

class CuError extends Error {
  constructor(code, message, hint, details = {}) {
    super(message);
    this.name = "CuError";
    this.code = code;
    this.hint = hint || null;
    this.details = details;
  }

  toResult() {
    const out = { ok: false, error: { code: this.code, message: this.message } };
    if (this.hint) out.error.hint = this.hint;
    Object.assign(out.error, this.details);
    return out;
  }
}

function fail(code, message, hint) {
  throw new CuError(code, message, hint);
}

function asResult(fn) {
  return Promise.resolve()
    .then(fn)
    .catch((err) => {
      if (err instanceof CuError) return err.toResult();
      return {
        ok: false,
        error: { code: "unexpected", message: String(err && err.message ? err.message : err) },
      };
    });
}

module.exports = { CuError, fail, asResult };
