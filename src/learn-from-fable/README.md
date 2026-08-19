# tools learn-from-fable

> **Staged pipeline distilling Fable 5's working style from local session transcripts into the Fable Pack.**

The premise: a stronger model's *procedure* is visible in its transcripts, and a weaker model can be taught to imitate it. This mines local sessions for decision points, filters for the ones that actually discriminate, evaluates whether the distilled skill helps, and regenerates the skill from what survived.

Run it with no arguments for guidance plus corpus stats.

---

## Commands

| Command | Description |
|---------|-------------|
| `bootstrap` | Check or create the fable config, asking where the pack repo lives |
| `stats` | Corpus census, mined and unmined state, stage guidance (default) |
| `report` | Full pipeline report: every run, number and proof path, as markdown |
| `list` | Unmined session queue with details, oldest first |
| `select` | Print unmined session paths, oldest first, for piping into `mine` |
| `pre-mine` | Deterministic parse and window census for the selection, no model calls |
| `mine` | Extract decision-point episodes and principle candidates (model-backed) |
| `filter` | Contrastive filter: keep episodes the reference scores high and a bare model scores low |
| `eval` | A/B eval: bare model versus model plus the fable-style skill, judged against the reference |
| `consolidate` | Multi-model vote on unconsolidated principles: useful or useless, with confidence, over N rounds |
| `spec` | Synthesize a FABLE-SPEC proposal from mined principles |
| `self-review` | Live Fable audits the spec, including growth control, while it is still served |
| `hooks` | Propose deterministic hooks from pack data |
| `skill` | Regenerate `fable-style` SKILL.md from the spec, with a parameterized line budget |
| `pre-score` | Guidance for ranking unmined sessions (implementation deferred) |

## Typical run

```bash
tools learn-from-fable bootstrap        # once: where does the pack repo live
tools learn-from-fable stats            # what is in the corpus, what to do next
tools learn-from-fable list
tools learn-from-fable pre-mine         # cheap: parse and census, no model calls
tools learn-from-fable mine             # the expensive stage
tools learn-from-fable filter
tools learn-from-fable eval
tools learn-from-fable consolidate
tools learn-from-fable spec
tools learn-from-fable skill
tools learn-from-fable report
```

---

## Why the stages are separate

Each stage is a gate, and the order controls cost.

**`pre-mine` before `mine`** because parsing and counting is deterministic and free, while mining is model-backed and is the expensive step. Knowing the window census first tells you whether a selection is worth mining at all.

**`filter` after `mine`** because most extracted episodes are not discriminating. The contrastive test keeps only the ones where the reference scores high **and** a bare model scores low. An episode both models handle well teaches nothing.

**`eval` before `spec`** because a principle that does not improve the A/B result should not reach the spec. The eval judges bare model against model-plus-skill on mined episodes, against the reference.

**`consolidate` before `spec`** because a single model's opinion on whether a principle is useful is noise. Several models vote across N rounds, with confidence.

## `spec` never overwrites the canonical spec

It writes a **proposal**. Promotion is a separate, human decision. `self-review` then has the live model audit that proposal, including growth control, which is the check against a spec that grows without bound.

## Notes

- `select` exists to be piped: it prints paths, oldest first, so you can hand a bounded selection to `mine` rather than mining the whole corpus.
- `report` is the audit trail. It renders every run with its numbers and proof paths, which is what makes a claim like "this principle improved the eval" checkable later.
- `skill` regenerates the `fable-style` skill with an explicit line budget, because an unbounded skill file stops being read.
- Related: the `fable-judge` skill does adversarial verification of finished work, and `fable-style` is the artifact this pipeline produces.
