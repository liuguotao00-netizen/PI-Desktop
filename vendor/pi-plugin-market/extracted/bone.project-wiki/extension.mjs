import policy from './memory-policy.cjs';
import { readProjectContextStats } from './memory-context.mjs';
import maintenance from './memory-maintenance.cjs';
import { writeRecallTrace, discardRecallTrace } from './recall-trace-storage.mjs';

export { readProjectContext, readProjectContextStats, saveAutomaticMemories } from './memory-context.mjs';
export const { extractAutomaticMemoryCandidates, memoryRequest, usableMemory } = policy;
const { MAINTENANCE_GUIDANCE } = maintenance;
const traceErrorCode = error => /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code || error?.message || '') ? error.code || error.message : 'TRACE_WRITE_FAILED';

export default function boneProjectWiki(pi) {
  const preparations = new Map();
  const keyFor = ctx => JSON.stringify([ctx.cwd, ctx.sessionManager?.getSessionId?.() || '']);
  const discard = key => preparations.delete(key);
  pi.on('before_agent_start', async (event, ctx) => {
    const key = keyFor(ctx), cwd = ctx.cwd, ticket = Symbol('preparation');
    discard(key); preparations.set(key, ticket);
    const current = () => preparations.get(key) === ticket && keyFor(ctx) === key && !ctx.signal?.aborted;
    let trace, published = false;
    try {
      if (!current()) return;
      const options = { query: event.prompt, explain: true };
      let result;
      try { result = await readProjectContextStats(cwd, options); }
      catch (error) { if (current()) ctx.ui?.notify?.(`BoneProjectWiki: automatic memory was not loaded (${error.code || error.message}).`, 'warning'); }
      if (!current()) return;
      if (result?.text && result.explanation) {
        // Read actual memory and source bodies again; existence and cached metadata cannot prove freshness.
        const fresh = async () => {
          const latest = await readProjectContextStats(cwd, options);
          return latest.explanation?.contextHash === result.explanation.contextHash
            && latest.explanation?.snapshotHash === result.explanation.snapshotHash;
        };
        try {
          trace = await writeRecallTrace(cwd, result.explanation, { sessionId: key, signal: ctx.signal,
            isCurrent: current, validateReferences: fresh });
        } catch (error) {
          if (error.message === 'STALE_RECALL_REFERENCES') result = null;
          else if (current()) ctx.ui?.notify?.(`BoneProjectWiki: recall preparation diagnostics were not saved (${traceErrorCode(error)}).`, 'warning');
        }
        if (!current()) return;
        if (result && !await fresh()) result = null;
      }
      if (!current()) return;
      const additions = [result?.text, MAINTENANCE_GUIDANCE].filter(Boolean);
      if (additions.length) {
        published = Boolean(result?.text);
        return { systemPrompt: [event.systemPrompt, ...additions].join('\n\n') };
      }
    } finally {
      if (trace && !published) {
        try { await discardRecallTrace(cwd, trace); }
        catch (error) { ctx.ui?.notify?.(`BoneProjectWiki: recall cleanup failed (${traceErrorCode(error)}).`, 'warning'); }
      }
      if (preparations.get(key) === ticket) {
        preparations.delete(key);
      }
    }
  });
  // Settlement only ends preparation ownership; memory writes belong to the current Agent's tool calls.
  pi.on('agent_settled', (_event, ctx) => discard(keyFor(ctx)));
  pi.on('session_shutdown', (_event, ctx) => discard(keyFor(ctx)));
  const discardFailedTurn = (event, ctx) => {
    const message = event.message || (Array.isArray(event.messages) ? event.messages.findLast(item => item?.role === 'assistant') : null);
    if (message?.role === 'assistant' && ['aborted', 'error'].includes(message.stopReason)) discard(keyFor(ctx));
  };
  pi.on('message_end', discardFailedTurn);
  pi.on('agent_end', discardFailedTurn);
}
