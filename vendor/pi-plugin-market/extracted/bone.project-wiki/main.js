'use strict';
const { WikiService } = require('./service.cjs');
let service;
const { schema, description, planSafeActions } = require('./tool-contract.cjs');
async function onLoad() {
  service = new WikiService(pi);
  await pi.commands.register({ id:'bone-project-wiki.open',title:'BoneProjectWiki',keywords:['wiki','knowledge','知识库'],run:()=>pi.ui.openPanel({title:'BoneProjectWiki'}) });
  await pi.agent.registerTool({ name:'project_wiki',description,risk:'medium',planSafeActions,schema,execute:async(input,ctx)=>{
    if (ctx?.signal?.aborted) throw new Error('CANCELLED');
    return service.requestFromAgent(input,ctx?.signal);
  } });
}
async function onPanelInvoke(channel,payload) {
  if (channel === 'app.getLocale') return pi.app.getLocale();
  if (channel === 'ui.closePanel') return pi.ui.closePanel();
  if (!['wiki','wiki.search','wiki.search.cancel','wiki.save'].includes(channel)) throw new Error('UNKNOWN_CHANNEL');
  if (!service) throw new Error('PLUGIN_NOT_READY');
  if (channel === 'wiki.search') return service.requestLatestSearch(payload);
  if (channel === 'wiki.search.cancel') return service.cancelLatestSearch(payload);
  if (channel === 'wiki.save') return service.saveAndSnapshot(payload);
  return service.request(payload);
}
async function onUnload() {
  service?.dispose();
  await pi.agent.unregisterTool('project_wiki');
  await pi.commands.unregister('bone-project-wiki.open');
}
module.exports = { onLoad,onUnload,onPanelInvoke,schema };
