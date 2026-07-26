---
description: Distill Fable 5's working style from local session transcripts into the "Fable Pack" (spec + golden traces + skill) so weaker models can imitate its procedure
argument-hint: [max-sessions] [--stats-only | --repack]
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Agent
---

# /learn-from-fable — bottle Fable 5's working style

Incrementally mine local Claude Code transcripts of `claude-fable-5` sessions and distill them into the **Fable Pack**, so weaker models (Sonnet/Opus/Haiku) inherit Fable's *procedure*: how it plans, sequences commands, verifies before claiming done, reports outcomes, and recovers from errors.

The pipeline is a TypeScript CLI: **`tools learn-from-fable`** (`src/learn-from-fable/`). This command drives that CLI — do NOT re-implement stages as bash/python pipelines. Bash is only for the pack-repo git commit and the few merge steps that are genuinely editorial LLM work. Every stage run is audited in `<pack>/meta/stage-runs.jsonl` with inputs/outputs/errors.

Research & rationale (author's local vault note, not committed here): `/Users/Martin/Tresors/Projects/GenesisBrain/Claude/Fable/2026-07-08-PreserveFable5Style.md`

**Arguments** (`$ARGUMENTS`): first numeric token = max sessions to mine this run (**MAX**; default **3**). `--stats-only` = Stages 0–1 only. `--repack` = skip mining, regenerate the skill from the existing spec (Stages 0 + 5 + 6 only).

**Paths** come from `~/.genesis-tools/claude/fable/config.json` (`packPath` = pack repo in the GenesisBrain vault, own git; `sessionsMirrorPath` = frozen legacy mirror, machine-local). The CLI resolves them itself — you only need `packPath` for the editorial merge and git steps:

```bash
FABLE="$(jq -r .packPath "$HOME/.genesis-tools/claude/fable/config.json")"
```

## Ground rules (read fully before acting)

- **Procedure transfers, capability doesn't.** Never claim the pack makes a model "as good as Fable".
- **Principles + rationale, not MUST-lists.** Every captured rule carries its *why*.
- **Originals are read-only.** Never modify anything under `~/.claude/projects/` or the mirror.
- **Protect main context.** Raw transcripts are megabytes. The CLI reads them deterministically; you never Read a `.jsonl` transcript in the main session.
- **Use the CLI, don't improvise.** If a CLI command fails, read its stderr and `~/.genesis-tools/logs/<today>.log`, fix the one thing that broke (in `src/learn-from-fable/` if it's a real bug), and note the deviation in your final report.
- **Fold deviations back into this file, same run.**
- Model choice per stage lives in config.json `models` (mine/filterBare/judge/eval) — full ai-proxy ids like `foltyn/claude-sub/claude-sonnet-5`; override per-run with the CLI flags, never by editing code.

## Stage 0 — Bootstrap (always; idempotent)

```bash
tools learn-from-fable bootstrap
```

If it reports missing config, STOP and ask the user for `packPath` (current answer: `GenesisBrain/Claude/Fable/LearnFromFable`) before continuing. `$FABLE/README.md` is versioned — do not regenerate it.

## Stage 1 — Corpus census (always; no copying)

```bash
tools learn-from-fable stats --json
```

Report: candidates, mined counts (prose/episodes/union), per-project map, stage-run count. If `--stats-only`, stop here.

## Stage 2 — Select sessions

```bash
tools learn-from-fable list --limit MAX --details   # human view: size/age/project/branch/first prompt
tools learn-from-fable select --limit MAX           # machine view: absolute paths, oldest first
```

Selection rules (already in the CLI): live corpus + mirror, stem-dedupe keep-largest, ≥100KB, skips `agent-*`/subagents, skips already-mined, OLDEST first. If nothing is unmined: report and stop (unless `--repack` → Stage 5).

## Stage 3 — Mine (deterministic extractor + LLM via ai-proxy)

Dry-run first to see the plan without spending tokens, then mine:

```bash
tools learn-from-fable pre-mine --limit MAX
tools learn-from-fable mine --limit MAX
```

The miner model comes from config (`models.mine`); to mine the same sessions with a second model for side-by-side artifacts, re-run with `--model <account/provider/model>`. Per-model results land in `meta/episodes/episodes.<model-slug>.raw.jsonl` + `meta/mined.jsonl`; principles in `meta/principles/unconsolidated.jsonl`.

Optional quality gate (contrastive filter — keeps only episodes where the reference beats a bare model):

```bash
tools learn-from-fable filter
```

## Stage 4 — Merge principles into the pack (editorial; main session)

Consolidation vote (multi-model useful/useless with confidence, duplicate drop):

```bash
tools learn-from-fable consolidate --rounds 2
```

Then the ONLY hand-editing of the run: fold survivors from `meta/principles/consolidated.jsonl` into `$FABLE/pack/FABLE-SPEC.md` — strengthen existing entries over adding near-duplicates; reject one-off trivia. Keep `$FABLE/pack/golden-traces.md` at ≤15 episodes (`[REASON]/[ACT]/[OUTCOME]` shape; new entries replace weaker ones). Append one `$FABLE/pack/changelog.md` entry (date, sessions, principles added/strengthened, traces swapped).

## Stage 5 — Regenerate the skill

```bash
tools learn-from-fable skill --max-lines 150 --sync
```

This prints the consolidated pack data plus regeneration instructions — follow them: rewrite `$FABLE/skills/fable-style/SKILL.md` from the spec (spec is the single source of truth), then `--sync` copies it to `~/.claude/skills/fable-style/`. Keep the existing frontmatter (name `fable-style`) verbatim.

## Stage 6 — Measure (A/B eval; optional but preferred each run)

```bash
tools learn-from-fable eval --filtered-only
```

Bare vs +skill on mined episodes, judged against the Fable reference; persists to `meta/eval-runs.jsonl`. Report `meanSoft`/`hardRate` per arm — and say plainly when n is too small to conclude anything.

## Stage 7 — Commit the pack + report

```bash
git -C "$FABLE" add -A
git -C "$FABLE" commit -m "fable-pack: mine <N> sessions ($(date +%F))" || echo "nothing to commit"
git -C "$FABLE" log --oneline -1
```

Never push the pack repo anywhere. End with: sessions mined and what they taught (2–4 bullets); spec sections touched; golden-trace count; census numbers; consolidation survivors/drops; eval numbers (or "unmeasured"); the pack commit hash; skill-sync status; any failures or deviations.

## Extra instruct-stages (run when asked, not part of the default loop)

```bash
tools learn-from-fable self-review   # Fable-only: self-review latest sessions against the spec
tools learn-from-fable hooks         # proposes hook candidates from the spec
tools learn-from-fable pre-score     # pre-scoring instructions for unmined sessions
```

Each prints pack data + instructions for the running LLM; follow them in-session.
