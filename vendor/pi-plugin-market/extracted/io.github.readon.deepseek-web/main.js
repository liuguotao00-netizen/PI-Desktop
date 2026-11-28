// Host entry for the DeepSeek Web plugin.
//
// All runtime functionality (the deepseek_search / deepseek_fetch tools and the
// /search command) is registered in the agent process through
// contributes.agentExtensions -> extensions/deepseek-web/index.ts.
// This host module deliberately performs no host-side work; it exists to satisfy
// the required `main` entry and exposes empty lifecycle hooks.

async function onLoad() {}

async function onUnload() {}

module.exports = { onLoad, onUnload };
