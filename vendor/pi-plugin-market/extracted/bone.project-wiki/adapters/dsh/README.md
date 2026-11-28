# BoneProjectWiki for DeepSeek Harness

This prebuilt Cordis bundle provides project-owned knowledge, source-linked memory, automatic recall and the original PI two-tab interface with automatic saving. Adapter 0.2.1 shows only its own version badge, `v0.2.1`; PI shows knowledge `v0.4.1`.

Tested target: DeepSeek Harness 0.2.2-rc.1 Web with Node 24.14.0. Node >=24.9.0 is required. Other prereleases and a separate Desktop carrier require validation.

## Installation

```sh
dsh plugin --profile web add /absolute/path/bone-dsh-project-wiki-0.2.1.tgz
```

Restart that profile, select the intended project and open its session. Use the right-sidebar Project wiki guide. The original two tabs, collapsible tree, Markdown read/edit modes, 350 ms autosave, source-summary editor and memory overview remain. More exposes import, preferences, context and export.

Each native React slot owns its original renderer, ShadowRoot, locale, menus, requests and disposable resources. Hiding a retained tab preserves drafts and before-reload protection; disposal removes its owned resources. The host document and globals are not replaced.

## Current-Agent memory maintenance

For an admitted genuine user turn, the plugin supplies a trusted maintenance workflow alongside bounded recalled facts. The current Agent uses its existing model; the plugin does not launch a separate model, scan chat history or persist literal keyword candidates from completion hooks.

After the task, the Agent considers stable user-explicit or verified preferences, corrections, lessons and decision context. With a durable increment, it snapshots, reads memoryIndex and related actual records/sources, then makes a small same-theme revision with expectedRevision. No increment means no memory tools, initialization or empty files. Conflicts, deletion, large rewrites and uncertain/sensitive inferences require confirmation. Secrets and assistant guesses are excluded. This semantic judgment is not independent fact verification.

Agent memory writes require maintainMemory with assessment of value, durability, novelty, concrete futureUse and evidence. Skip low-value, temporary, duplicate and test material before retaining anything. Synthesize a Chinese conceptual title and Chinese fact/summary; source text may retain its original language through independent memoryTitle. Direct Agent memory save/remember is rejected, including identity-only updates; explicit manual panel edits remain compatible. These checks enforce structure and negative decisions, not independent semantic understanding. Complete rules preserve full documents and require linked:true. The generated `.bone-project-wiki/memory/MEMORY.md` remains a bounded routing index with a collapsed read-only preview; it does not overwrite project-root or unowned/manually edited main files.

The plan-safe memoryIndex action derives current routes from actual records and sources without publishing the main file. Mutation results report mainMemory.persisted; false plus an error means an incomplete index update, even if the record was committed. Preserve its revision and report partial success. Explicit reindex can retry after the underlying issue is resolved. Existing direct helper exports remain compatibility APIs, not active lifecycle capture paths.

## Shared project data and boundaries

PI and DSH opening the same local directory share `.bone-project-wiki/`, schema-version-1 records and stable document identities. No migration is required. Refresh or the next retrieval sees saved changes; source changes withhold old summaries. Different machines or copies need external directory synchronization. Preferences and conversations remain client-owned.

The resolved Agent's immutable original session directory fixes filesystem authority. Model path hints only assert context. All knowledge I/O uses scoped DSH filesystem providers, canonical containment, current sandbox policy and opaque version fences. Read-only sessions cannot mutate; writes never fall back to Node or shell. Multi-file operations are not transactions.

Recall still excludes drafts, archives, out-of-scope facts and unverifiable linked summaries. Automatic facts are bounded to 1,200 characters / six entries / 180 body characters; manual content blocks remain 10,000 / sixteen / 1,800. Long rules retain complete full-read routes. The trusted maintenance workflow is separate from recalled fact budgets and diagnostic context hashes.

Diagnostics contain bounded hashes/counts/reasons, never raw prompts or bodies: ten/project, 20 KiB each. Actual bodies are revalidated after trace I/O. Manual preview, index and trace viewing do not create automatic traces. Preparation does not prove model receipt or use.

DSH disable clears pending preparation and maintenance generations; unload removes exact owned registrations. Its host can retain previously accepted text after full provider unload; full retraction needs a host fix. Consumed context cannot be revoked and committed facts are not rolled back. PI's generic running-steering boundary still lacks proven user provenance. PI background project routing needs the existing matching host correction.

## Capabilities, validation and distribution

HTML retains opaque-origin allow-scripts sandbox, no-referrer and local-only CSP. XLSX is offline/read-only and never evaluates formulas. DSH has no directory-removal API, so directory deletion is disabled before mutation. External application open/reveal is unavailable in Web.

Build with `node scripts/build-dsh.mjs` and an existing esbuild toolchain. Source includes real-provider memory tests, native React browser tests, PI extension-runner checks and a Python Playwright native flow. No model or paid API is needed. Test profiles must explicitly select/assert an owned temporary project: DSH_HOME isolates configuration, but the default workspace can remain in system Documents.

This is a local candidate, not a published npm release or hosted index. Discover has user-configured HTTPS indexes and no default central index. The index builder emits an empty pending index; only --published with verified real registry provenance creates an install entry. A local archive can be installed directly. The adapter adds no license grant to existing code; third-party notices are bundled separately.
