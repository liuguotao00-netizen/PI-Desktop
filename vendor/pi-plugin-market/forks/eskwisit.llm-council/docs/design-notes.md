# Design notes

What the council takes from each source. Credits are in the README.

**From Karpathy's design:**
- parallel Stage 1;
- anonymized Response labels;
- every member also ranks its own answer;
- a strict `FINAL RANKING:` format;
- a chairman synthesis;
- average-rank aggregation;
- graceful degradation.

**From Lehmann's design:**
- the five lenses and their tensions;
- context framing, with one clarifying question at most;
- the three review questions;
- the five-part verdict;
- the chairman may side with a dissenter;
- "don't council trivial questions".

**Our own choices:**
- **Prompts:** the review, chairman and title prompts are written for this plugin.
- **Casting:** models are cast per user from their delegation catalog, with exclusions and a saved
  cast.
- **Labels:** shuffled.
- **Aggregation:** per advisor seat.
- **Parser:** reads the **last** `FINAL RANKING`, case-insensitive, with word boundaries and
  deduplication.
- **Privacy:** during review the Stage 1 files are emptied and the label map stays with the
  plugin. This is best effort: models may recognise their own writing, and a sub-agent that goes
  looking could still read the plugin's data directory.
- **Failover:** immediate, along each seat's cast chain, with run-wide failure memory.
