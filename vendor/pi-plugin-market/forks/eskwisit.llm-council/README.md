# LLM Council for PI-Desktop

Ask one model and you get one answer, with no way to tell whether it is great or mediocre. The
council runs your question through **five advisors**. Each thinks from a deliberately different
angle on the model best suited to that angle. They review each other anonymously, and a chairman
delivers a verdict: where they agree, where they clash, what they all missed, what to do, and the
one thing to do first.

It combines two designs:

- [karpathy/llm-council](https://github.com/karpathy/llm-council): several models answer, rank
  each other's anonymized answers into a leaderboard, and a chairman synthesizes the result.
- [Ole Lehmann's llm-council skill](https://github.com/aiwithremy/claude-skills-llm-council):
  five thinking lenses that create tension, context framing, blind-spot reviews and a structured
  verdict.

## The council

| Advisor | Lens | Cast on |
|---|---|---|
| The Contrarian | Assumes there is a fatal flaw and finds it | your strongest reasoning model |
| The First Principles Thinker | What are we actually trying to solve? Reframes | your strongest reasoning model |
| The Expansionist | The upside everyone is missing | a strong model, ideally another vendor |
| The Outsider | Fresh eyes, no context; catches the curse of knowledge | a strong model, ideally another vendor |
| The Executor | Can it be done? What do you do Monday morning? | a strong practical model |
| Chairman | Synthesizes the answers and reviews into the verdict | your strongest reasoning model |

The lenses create three tensions:
- **Contrarian ↔ Expansionist:** downside against upside.
- **First Principles ↔ Executor:** rethink it against just do it.
- **The Outsider** keeps everyone honest.

Casting different vendors adds Karpathy's model diversity, because different models have
different blind spots.

## Usage

1. Install the `.piplug` from the plugins page, or load this folder for development. Use Agent
   mode with a workspace folder open.
2. Say "council this: …", "pressure-test this", or bring a real decision.

The council is for decisions with real stakes, not for lookups or writing tasks.

## Your models, not ours

Nothing in the plugin names a model. PI-Desktop gives every agent the list of models you can
delegate to (Anthropic, OpenAI, Google, xAI, OpenRouter, a local model, and so on).

**The first time you convene the council:**
1. The orchestrator reads that list.
2. It casts each seat by the strength the lens needs, plus 1–3 fallbacks, preferring vendor
   diversity.
3. It shows you the cast to confirm.
4. It saves the cast in the plugin's settings.

Later runs reuse that cast until one of its models disappears from your list.

**To rule out a model or provider,** for example a free tier that stalls under load, tell the
council ("don't use Gemini, it's free tier"). It records a glob such as `google/*` and your note.
You can also edit them under **Plugins → LLM Council → Settings**:

| Setting | Holds |
|---|---|
| Council cast | models per seat, `{ "contrarian": ["model", "fallback"], … }`; clear it to recast |
| Excluded models | glob patterns the council never casts, e.g. `["google/*"]` |
| Model notes | notes the council reads before casting |

With no delegation models configured, every seat uses the session model. The council still runs,
but without model diversity.

## How a session runs

1. **Frame.** The orchestrator reads the relevant workspace context and writes one neutral,
   specific question. If the question is too vague, it asks one clarifying question first.
2. **Stage 1.** The five advisors answer in parallel, 150–300 words each, fully committed to their
   angle.
3. **Stage 2.** The answers are shuffled into Response A–E. Each advisor, in a fresh session,
   evaluates them all and names the strongest, the biggest blind spot and what everyone missed. It
   ends with a strict `FINAL RANKING:`. The rankings are averaged into a "street cred" table.
4. **Stage 3.** The chairman sees every answer with its advisor and model, every review and the
   table, and writes the verdict. The chairman may side with a dissenter.

Each run is saved under `.llm-council/runs/<timestamp>/` in your workspace as `report.md` and
`transcript.json`.

**Failover.** No seat dangles and no failed model is retried. A seat that errors, shows no
activity 45 s after launch, stalls past its idle or maximum time, or ends without output is
stopped and relaunched on the next model in its cast chain: its primary model, the same model
through your other accounts (added automatically), then the fallbacks you confirmed. The plugin
does the bookkeeping (`council start` / `council next`, recorded in the run's `failovers.json`): a
model that fails anywhere in a run is skipped for every later seat, and every substitution is
logged in the report. A small guard extension blocks, while a run is active, a seat delegated to a
generic sub-agent, a resumed seat, or a launch on a model that already failed.

## What is in the box

| Part | Where | Role |
|---|---|---|
| Orchestrator | `skills/llm-council.md`, a plugin skill | Casting, framing, stages, failover, presentation |
| Persona sub-agents | `subagents/*.md`, installed to `~/.agents/subagents/` | `council-contrarian`, `council-first-principles`, `council-expansionist`, `council-outsider`, `council-executor`, `council-chairman`. Each carries its lens, thinking level, Read/Write tools and timeouts. None names a model |
| Agent tool | `main.js` | `council`, one tool with an `action`: `get`/`set` (cast, exclusions, notes), `start`/`next` (the model each seat launches on; failover bookkeeping), `anonymize` (shuffle and hide authorship), `tally` (rankings, street cred, chairman prompt), `report` (report and transcript) |
| Guard extension | `extension/council-guard.js` | Blocks `Task` calls that break the council's rules while a run is active; never blocks anything else and fails open |

PI-Desktop plugins can contribute skills and agent tools but not sub-agents, which load only from
`~/.agents/subagents/`. So the plugin copies its personas there when it loads and removes them when
it unloads (a persona you edited is left alone).

## Permissions

| Permission | Why |
|---|---|
| `agent.prompt.inject` | indexes the LLM Council skill so the agent can load it |
| `agent.tool.register` | the `council` tool the agent calls during a run |
| `agent.extension` | the guard that watches `Task` calls during a run |
| `fs.read`, `fs.write` | reading and writing the run files, limited to `.llm-council/**` in the workspace |

`agent.prompt.inject`, `agent.tool.register`, `agent.extension` and `fs.write` are high-risk
permissions. The plugin has no network access and runs no programs.

### What it can and cannot do

It **can**:

- read and write files under `.llm-council/` in your workspace, where each run keeps its question,
  answers, reviews, prompts and report. During review it empties the Stage 1 answer files so
  reviewers cannot tell who wrote which
- copy its six `council-*.md` personas to `~/.agents/subagents/` on load, and remove them on
  unload unless you edited them
- keep each run's label map and Stage 1 answers in its private data directory
  (`~/.pi-desktop/plugins/data/eskwisit.llm-council/runs/`), deleted after 30 days
- keep the cast, exclusions and notes in its plugin settings

It **cannot** and does not:

- access the network, so nothing leaves your computer except through the models you cast
- run programs or shell commands, or load code
- read or write workspace files outside `.llm-council/`
- touch any file in `~/.agents/subagents/` other than its own six `council-*.md` personas (and
  obsolete council personas it shipped before, recognised by their "Use only from the llm-council
  skill." marker)

Details for reviewers are in [docs/security-review.md](docs/security-review.md).

## Known limits

- **Agent mode only.** PI-Desktop hides plugin tools and delegation in Plan and Goal mode.
- **A workspace folder must be open.** The run files live in it, and the plugin's file access is
  limited to `.llm-council/` there.
- **Anonymity is best effort.** Reviewers see only Response A–E, and the files that would tell them
  who wrote what are emptied during review. Models may still recognise their own writing, and a
  sub-agent that goes looking could read the plugin's data directory, which PI-Desktop does not
  hide from agents.
- **Sub-agent slots.** PI-Desktop loads at most 16 sub-agent definitions; the council uses 7. If
  the personas don't show up after installing, start a new session.
- **Timeouts are watched by the orchestrator.** The personas' idle and maximum durations are
  enforced by the skill's watch loop, not by PI-Desktop.
- Tested on macOS. Nothing is platform-specific, but Windows and Linux have not been tried.

## Development

The plugin has no build step and no dependencies. Run the tests with Node 20 or later:

```bash
node --test tests/
```

The tests load `main.js` with a fake PI-Desktop host in a temporary folder and cover the ranking
parser, aggregation, prompts, casting and exclusions, the full anonymize → tally → report flow,
failover bookkeeping, the guard extension, state surviving a restart, persona install and removal,
and the manifest matching the registered tools.

## Credits

The council's design follows [karpathy/llm-council](https://github.com/karpathy/llm-council) (an
anonymous peer ranking and a chairman synthesis) and
[Ole Lehmann's llm-council skill](https://github.com/aiwithremy/claude-skills-llm-council) (the
five advisor lenses, the framing step, the review questions and the verdict structure). The
review and chairman prompts and the code are written for this plugin, and the advisor
personas adapt Lehmann's lenses. Neither repository declares a license. What comes from each
source is listed in [docs/design-notes.md](docs/design-notes.md).

## License

[Apache-2.0](LICENSE)

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
