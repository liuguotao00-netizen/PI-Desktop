/**
 * PI Computer Use — PI-Desktop 插件入口。
 *
 * 设计原则：
 *  1. 只在 agent 显式调用某个 cu_* 工具时动作；加载时不截图、不监听、不排队。
 *  2. 缺依赖时返回结构化错误（code + message + hint），绝不静默失败。
 *  3. 运行时环境每次调用重新探测，用户在设置里改会话/装依赖后无需重载插件。
 *
 * 宿主注入的全局 `pi` 对象负责把工具暴露给 agent；能力边界由 manifest.json 的
 * permissions 决定。
 */

const { TOOL_DEFS, createRuntime, descriptor } = require("./lib/tools.js");
const { asResult } = require("./lib/errors.js");

const registered = new Set();

async function onLoad() {
  for (const def of TOOL_DEFS) {
    await pi.agent.registerTool({
      ...descriptor(def),
      execute: async (args) => asResult(() => def.execute(createRuntime(), args || {})),
    });
    registered.add(def.name);
  }
}

async function onUnload() {
  for (const name of registered) {
    try {
      await pi.agent.unregisterTool(name);
    } catch {
      /* 卸载阶段不抛：宿主正在收摊 */
    }
  }
  registered.clear();
}

module.exports = { onLoad, onUnload, TOOL_DEFS };
