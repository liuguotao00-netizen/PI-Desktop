# Current-Agent memory maintenance and main memory index

## Scope

Knowledge 0.4.0 / DSH adapter 0.2.0 replaces the installed lifecycle's literal regex settlement capture with maintenance performed by the admitted current Agent. The plugin prepares a trusted workflow for genuine user input and tool continuations; the current conversation model decides whether a stable increment exists and uses existing revision-checked `project_wiki` tools. No separate model, history scan, background summarizer or post-settlement model/tool execution is added.

The older exported literal extraction/save helpers remain available for programmatic compatibility. They are not the active automatic lifecycle and do not constitute a second consolidation pipeline. Direct external file/helper writes can leave derived files stale until a normal mutation or explicit reindex; fresh `memoryIndex` projections do not trust that stored index.

## Semantic maintenance contract

Finish the current task before maintenance. Evaluate concrete future utility, importance, stability, novelty and provenance before library activity. Skip one-off requests, temporary progress, low-value details, test fixtures, duplicates and assistant speculation. No useful durable increment means no memory tool activity, initialization or empty files. Never retain credentials or private absolute paths.

For a durable increment: snapshot -> optional initialization -> memoryIndex -> relevant actual record/source reads -> minimal same-theme `maintainMemory` -> confirmed tool result. Preserve qualifications, scope, provenance and time context. Conflicts, deletion, large rewrites, uncertain inferences or sensitive content require user confirmation.

`maintainMemory` requires a bounded `assessment`: decision (`retain`/`skip`), value (`high`/`normal`/`low`), stability (`durable`/`temporary`), novelty (`new`/`update`/`duplicate`), reason (400 characters), concrete futureUse (400) and evidence (1000). Retain requires all fields and confirmed status; an update requires a fresh identity and expectedRevision. Skip requires decision and reason. Low, temporary, duplicate and explicit skip outcomes return `accepted:false,saved:false` before library I/O. Exact normalized facts in the same scope are also suppressed after actual-source checks. Raw assessment evidence is not persisted or returned.

Short facts use `maintainMemory(kind:memory)` with a Chinese conceptual title and Chinese synthesized content up to 800 characters. Complete rules use `maintainMemory(kind:document)` with full original content, Chinese summary and optional independent Chinese memoryTitle. The source may retain its original language. Preserve important conditions and exceptions; do not copy filenames or conversation logs. Independent titles survive source renames, while linked document metadata retains the current source title.

PI and DSH registered tools carry a host-owned Agent origin. Direct Agent memory `save`/`remember` is rejected, including identity-only memory updates. Origin is not a wire parameter. Manual panel save/remember remains available without model assessment. Generic filesystem tools are outside this plugin's enforcement boundary; trusted guidance forbids using them to bypass admission. Existing records are not migrated or deleted automatically.

Assessment is performed by the current model, not an independent verifier. The host enforces bounded structure, negative outcomes, Chinese-character presence, existing memory policy and exact duplicates; it cannot prove semantic understanding, full Chinese fluency or paraphrase novelty. Responses mark `independentlyVerified:false`. No real-model quality sample has been run.

Retained results require `saved:true`; documents also require `linked:true`. A saved record with `mainMemory.persisted:false` and an error remains committed. Report partial success and preserve the returned revision.

## Main file and fresh tool view

The generated path is `.bone-project-wiki/memory/MEMORY.md`. Project-root `MEMORY.md` and all other user files retain their ownership. Existing memory records keep schema version 1, stable IDs, document links and revisions; records are not migrated or mass-confirmed.

The main file groups routes by existing topics and contains titles, relative links, read IDs, revisions, scopes and linked-source reading conditions. It copies no memory fact bodies. Drafts, archived, sensitive/request-only bodies and unverifiable linked summaries are excluded. The main file is excluded from record scans and cannot recursively enter effective recall. It is bounded to 64 KiB, omits whole routes when full, and reports the number omitted plus the full-collection route.

`project_wiki({action:"memoryIndex",workspacePath})` is a plan-safe read. It derives current routes from actual records and source bodies and returns:

```json
{
  "path": ".bone-project-wiki/memory/MEMORY.md",
  "content": "generated Markdown routes",
  "revision": "hash of the generated view",
  "count": 2,
  "omitted": 0,
  "persisted": true
}
```

A stale/missing stored file has `persisted:false`; an unowned/manually edited file also reports `error:"MAIN_MEMORY_FILE_CONFLICT"`. The returned content remains the fresh derived view, not unverified bytes from a user-modified file. Reading does not publish the main file. Existing optional JSON-cache behavior remains unchanged.

## Synchronization, failure and lifecycle

Initialization, explicit reindex and successful memory/knowledge Markdown mutations mark the owning project operation dirty. Once the operation has completed, the same project FIFO synchronizes the main file. Document and linked-summary writes within `remember` therefore share one final index update. Panel save retains its entry and snapshot result shape, with additive top-level `mainMemory` metadata. Ordinary save retains the record shape with the same additive publication metadata.

A generated file carries an ownership marker and a hash of its full body. Missing files can be created. Existing files without that marker, or whose body does not match its stored hash, are preserved. Updates publish once and verify fresh readback; they do not retry by adopting a competing writer's version. DSH uses its provider's existing version fences. The PI host lacks a cross-process compare-and-swap filesystem primitive; this is not a cross-process filesystem transaction.

Cancellation, disposal and project changes remain interruptions and cannot publish subsequent queued work. A non-interruption index error returns `mainMemory:{path,persisted:false,error}` with the committed record. The model must report partial success. Reindex can retry a resolved failure; it does not authorize overwriting an unowned file. External edits can stale the stored derived routes, so consumers must read and validate actual records/sources before using facts.

The memory overview adds a collapsed, read-only main-file disclosure. It fetches routes only when opened and discards late results after refresh, navigation or disposal. It shows synced, pending, conflict and unavailable states without replacing the original two-tab layout or editor.

## Retained invariants and limits

Automatic fact recall remains 1,200 characters / six entries / 180 body characters. Manual content blocks remain 10,000 / sixteen / 1,800. The separate trusted maintenance workflow is not a recalled fact and is excluded from fact-context hashes and budgets. Full facts or complete read pointers remain the presentation units.

Project authority follows the invoking session. Provider permissions, sandbox containment, per-project queues, strict input validation, source-body authority and private bounded preparation diagnostics remain in place. Manual overview/index/preview does not capture facts or create automatic preparation traces. No history access, additional permission, user-profile install or cloud synchronization is added.

PI generic running steering still lacks proven human provenance at the extension boundary. DSH can retain accepted context text after full provider unload; configuration disable empties a retained registered provider. Current tools cannot revoke already consumed model context or roll back an already committed record. Retiring settlement autosaves removes their dependence on PI's early `agent_settled` notification.
