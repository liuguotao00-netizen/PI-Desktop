# Memory trigger audit

This audit covers the PI extension and DeepSeek Harness (DSH) adapter against DSH `0.2.2-rc.1`, using Node `24.14.0`. Validation uses temporary projects, the real local DSH filesystem provider, its prompt registry and agent registry, and the existing built PI extension runner. It makes no model requests and does not use a running user profile.

The active lifecycle uses the current Agent's semantic maintenance workflow. It injects trusted plugin guidance separately from untrusted recalled facts; it does not extract literal regex candidates for automatic settlement writes. The current session model decides whether a durable increment exists and uses the existing `project_wiki` tool during the admitted user turn. No background model, history replay/scan, or completed/error-hook tool invocation is involved.

The record format remains version 1. Actual memory and source bodies remain authoritative. Automatic recall remains bounded to 1,200 characters / 6 entries / 180 body characters per entry; manual context remains 10,000 / 16 / 1,800. These are recalled-data budgets; the fixed trusted maintenance workflow is a separate prompt block. Complete full-read pointers replace facts that do not fit. Confirmation, scope, source freshness and candidate isolation remain in force. Recalled content never acquires instruction authority.

## Maintenance contract

`memory-maintenance.cjs` supplies one workflow for both hosts:

- Finish the current user task first. Retain only stable, user-explicit or verified durable preferences, corrections, lessons and decisions. Exclude questions, temporary tasks, assistant guesses, secrets and private paths.
- With no durable increment, perform no memory/index tool activity and create no empty library or files. With an increment, discover the project through `snapshot`, initialize only if needed, then read `memoryIndex` and relevant current records and authoritative documents.
- `.bone-project-wiki/memory/MEMORY.md` is plugin-generated routing. The Agent must not write it with generic filesystem tools or treat it as fact authority. Record and source bodies retain authority.
- Prefer a minimal same-theme revision using a freshly read `id` (or a document's stable `recordId`) and `expectedRevision`. Preserve appropriate topics, scope and importance; avoid duplicate paraphrases. Conflicts must not be silently overwritten. Deletion, large rewrites and sensitive, inferred or uncertain content require user confirmation.
- From knowledge 0.4.1 / DSH 0.2.1, actual Agent writes pass through `maintainMemory` with bounded value, durability, novelty, concrete future use and evidence assessment. Host-owned origin prevents direct memory save/remember and identity-only update bypasses. Low/temporary/duplicate/skip outcomes perform no library I/O. Chinese conceptual titles and synthesized facts are required; semantics remain current-model self-assessment. Manual panel editing remains compatible.
- Preserve full rules through admitted `maintainMemory(kind:document)`, using the existing document/summary persistence internally. Complete linked success requires `linked:true`; report derived-index failures separately from committed records.

The public `saveAutomaticMemories` PI export and DSH `saveCandidates` remain backward-compatible programmatic helpers. Their literal-language validation, bounded candidates and deduplication remain covered by direct tests. Neither helper is called by the active lifecycle. Their names and historical `automatic-agent-memory` source metadata do not describe a current settlement trigger.

## Trigger matrix

| Host / public trigger | Recall and maintenance | Persistence and invalidation |
| --- | --- | --- |
| PI genuine-user `before_agent_start` | Read project context for the incoming prompt and append the separate trusted workflow, including for ordinary tasks. Revalidate actual memory/source context and snapshot hashes after trace I/O. | No candidate capture or record write. Project/session identity, preparation ticket and cancellation guard publication. A newer same-session preparation invalidates the older one. |
| PI `agent_settled` | No new recall or guidance. | Invalidate preparation ownership only. No memory/index/tool activity. |
| PI `message_end` / `agent_end` | No new recall or maintenance opportunity. | A relevant assistant `error` or `aborted` message invalidates preparation. No persistence. |
| PI `session_shutdown` | No new recall. | Invalidate owned preparation. No persistence. |
| PI running steering / generic user-message notification | No new automatic guidance hook; provenance limitation below applies. | No speculative capture or generic-user-event persistence. |
| DSH activation / `agent/created` | Register agent-scoped providers, including existing agents from supported `agents.list()`. | No history replay, capture or writes. Exact provider disposers belong to the plugin. |
| DSH accepted `agent/pre-step` | Respect the decision returned by downstream `next()`. Only accepted messages with `role:user` and actual `source.kind:user` grant maintenance. Prepare recall with bounded query and explicit safe paths. | No candidate capture. Admission ticket, turn identity, lifetime, generation, preparation sequence and cancellation fence publication across awaits. |
| DSH admitted-turn tool continuation | Retain maintenance guidance and original/latest query text within that user turn. Injected/tool/replay messages cannot supply query text or grant a new maintenance opportunity. | No settlement writes. Query is bounded to 32,000 characters, retaining initial/latest text; explicit project-relative paths are bounded to 16. |
| DSH rejected pre-step / downstream admission failure | No guidance publication. Preserve the host decision or original exception. | Clear the owned opportunity and abort its preparation. A suspended obsolete admission cannot revive it. |
| DSH `session/event: turn/end` / matching `agent/error` | Clear text, query, paths and guidance. | Abort owned preparation/admission for that turn, regardless of completion reason. No completed/error-hook tool calls or record writes. An older turn's boundary does not clear a newer opportunity. |
| DSH settings disable / enable | Disabled providers return empty text on refresh. Re-enable requires fresh genuine user admission. | Disable clears owned state and cancels preparation; an old off/on generation cannot publish later. Manual tools and stored records remain available. |
| DSH agent disposal / plugin cleanup | Dispose the exact provider and permanently close that plugin instance. | Abort owned preparation and clear state; no unrelated whole-agent abort. Accepted-text host limitation below remains. |
| Both hosts: explicit tools / manual context / preview / trace listing | Use existing project, query and permission boundaries. | Saves are current-Agent tool calls or explicit programmatic helpers. Manual preview/trace listing neither capture facts nor create automatic preparation traces. |
| Both hosts: `forget` / memory `delete` | Purge related derived traces before and after verified deletion. | Existing revision/permission contracts remain. Cleanup failure must not report complete forgetting. |

## Freshness and trace ownership

PI compares both `contextHash` and `snapshotHash` after fresh actual-body reads. Tests edit actual memory and linked source bodies during blocked trace publication: the old recalled text is withheld while trusted guidance can remain, and only the owned trace is removed. Cancellation, project/session changes, failure and superseding preparations withhold the entire late addition. Cleanup uses pinned directories and original inode/size/timestamp ownership and refuses external replacements.

DSH re-reads actual context after trace I/O. It records the provider publication's exact opaque version, including publication followed by cancellation. Cleanup uses a fresh `host.run`, pins the same project/provider, and deletes only that version under the current sandbox policy. It does not reuse a canceled preparation signal or adopt a replacement version. CAS conflict or policy refusal remains `AggregateError([originalError, cleanupError], 'TRACE_CLEANUP_FAILED')`, with a bounded warning code.

Shared trace reads accept a real nonempty opaque version or PI's finite `mtimeMs`; size and version/timestamp must agree around bounded reads. No DSH timestamp is fabricated. Tests cover `prepareMemory -> memoryTraces -> forget/delete -> empty traces`, actual-body changes, exact-version replacements, read-only cleanup refusal and bounded retention. Diagnostics contain hashes/counts/allowlisted reasons, no raw query or body. A trace records prepared recall only, not the separate maintenance workflow or model receipt/use.

## External host limitations

**PI has no proven human provenance for running steering.** The initial `before_agent_start` is the supported opportunity used here. The generic message payload does not expose the runtime's steering identity lookup; extensions can also queue user text through `sendUserMessage`. A generic user role is insufficient proof of genuine human steering. No new event or protocol is invented.

**PI settlement is not final success.** The runtime emits `agent_settled` before pending recoveries and resumed delegation work. This no longer causes automatic memory writes because persistence has been removed from settlement. A current-Agent tool write already committed during its turn is still not rolled back by a later failure, and this change does not promise otherwise.

**DSH can retain accepted text after full plugin unload.** The agent loop assembles before the pre-step waterfall and refreshes at request admission. The supported prompt registry retains an accepted context's old string when its registration disappears; late optional providers are not added. Preinstalling through `agents.list()` supports existing agents. Settings-disable empties the still-registered provider, but full unload must dispose registrations and cannot retract a string already accepted by the host. The real registry regression demonstrates that the retained string can include recalled facts and maintenance guidance. A host change is required for full retraction; no undocumented registry mutation or unrelated runtime abort is used.

Cleanup cannot bypass disposed host/agent state, a changed project/provider, current permissions or file versions. A provider that commits and throws without returning a publication version leaves no provable ownership for cleanup. Cancellation cannot reverse an already committed tool write or retract context already consumed by a model.

The workflow is guidance to the current model, not a deterministic semantic classifier. Offline fixtures replace the external model with explicit tool decisions. They prove lifecycle gating, real tool/service persistence, minimal revision and later recall; they do not prove that a model received, followed or correctly interpreted the workflow.

## Regression validation

Run from the task worktree with Node 24 on `PATH`, `DSH_API_ROOT` pointing to existing DSH package links, and `PI_DESKTOP_ROOT` pointing to an existing built PI checkout. No dependency installation is required:

```sh
node --test --test-timeout=30000 extension.test.mjs
node --test --test-timeout=15000 adapters/dsh/tests/memory.test.mjs adapters/dsh/tests/host.test.mjs adapters/dsh/tests/boundaries.test.mjs adapters/dsh/tests/cross-host.test.mjs
node tests/extension-host.mjs
```

The lifecycle tests cover real tool/service creation, read-before-update with `expectedRevision`, one-record same-topic correction, later recall, direct helper compatibility, zero settlement/error writes, no empty-project initialization, accepted-source gating, continued guidance, bounded initial/latest task queries and paths, cancellation during trace I/O, disable generations, pending-admission end/error/disposal, original error identity and existing-agent reload/unload behavior.

At this lifecycle handoff, PI extension tests pass (54), DSH backend tests pass (44), and the real PI extension-runner fixture passes. A broader four-file run (`extension.test.mjs memory-retrieval.test.cjs document-memory.test.cjs recall-traces.test.mjs`) ran 130 tests: 121 passed and 9 failed in the parent-owned `memory-retrieval.test.cjs`. Those assertions still combine trusted guidance with recall budgets/hashes, expect recall-only prompt text, or omit generated-main-file reads. They require integration updates; this audit does not claim that broader suite is green.

Native UI/profile E2E, model requests, packaging and release validation belong to the parent integration task. No user profile, dependency environment, commit or push was changed by this lifecycle work.
