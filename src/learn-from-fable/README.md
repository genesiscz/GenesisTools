# tools learn-from-fable

A staged pipeline that distills the working style of Claude Fable from your local Claude Code transcripts into the
Fable Pack: a spec of principles, golden traces, and the `fable-style` skill that weaker models (Sonnet, Opus, Haiku)
load. It is for someone who runs Fable sessions on this Mac and wants the procedure in them to outlive the model.

The premise: a stronger model's *procedure* is visible in its transcripts, and a weaker model can be taught to imitate
it. The tool mines local sessions for decision points, filters for the ones that actually discriminate, evaluates
whether the distilled skill helps, and regenerates the skill from what survived. Procedure transfers, capability does
not: the pack never makes a model "as good as Fable".

## Quick start

```bash
tools learn-from-fable bootstrap --pack-path ~/FablePack   # once: write the config that names the pack folder
tools learn-from-fable                                     # stats: corpus census, mined and unmined, stage list
tools learn-from-fable list --limit 10 --details           # the unmined queue, oldest first
tools learn-from-fable pre-mine --limit 3                  # free: parse and count windows, no model calls
tools learn-from-fable mine --limit 3                      # model-backed: episodes and principle candidates
tools learn-from-fable report                              # every run, number and proof path as one document
```

`mine`, `filter`, `eval`, `consolidate` and `spec` call models through the ai-proxy (`mine` can use another backend),
so set the stage models in the config first (see Configuration) and have the proxy running (`tools ai-proxy up`).

## Commands

The tool takes `-v, --verbose` and `--readme` (print this page). With no subcommand it runs `stats`. Every command
except `bootstrap` needs the config and stops with "No fable config yet" until `bootstrap` has written it.

### Setup and census

- `bootstrap [--pack-path <path>]`: check or create the config. With a config and no flag it only reports the pack
  path and whether it exists. Without a config it asks where the pack lives (default `GT_FABLE_PACK_PATH`, else
  `~/FablePack`). At the prompt, type an absolute path: `~` is not expanded there (only your shell expands it, for
  the flag). A non-interactive run needs `--pack-path`. A new `--pack-path` keeps the saved `models`, `notes` and
  `sessionSources`. It writes only the config: it does not create the pack folder or a git repository.
- `stats` (default): the census. Pack path, whether the spec exists, candidates, mined counts (prose miner, episode
  miner from the legacy `skillopt-data/mined.jsonl` plus `meta/mined.jsonl`, and the union), the unmined count, the
  last prose-mined session, stage runs, unmined sessions per project (top 12), and the stage list.
  `--min-size <bytes>` (default 100000), `--json`.
- `list`: the unmined queue, oldest first, with stem, age, size, project and source (`live` or `mirr`).
  `--limit <n>` (default 20), `--min-size <bytes>` (default 100000), `--all` (include mined sessions),
  `--details` (read each transcript head for the branch and the first prompt), `--json` (implies `--details`).
- `select`: the same queue as bare paths, one per line, for `mine --session`. `--limit <n>` (default 5),
  `--min-size <bytes>` (default 100000), `--json` (full candidate objects).
- `report`: one markdown document over the whole pack: config, mined sessions, episode files per model, filter
  runs, consolidation, A/B eval runs, the stage-run audit trail, and where to verify every model call. Rendered for
  the terminal by default. `--md` (raw markdown, for saving), `--json`.

### Mining

`mine` and `pre-mine` take the same flags. `pre-mine` stops after the parse and makes no model calls. It runs one
session at a time and ignores `--session-concurrency`. With the default backend it needs no model, so it runs before
any model is configured. With `--backend grok` or `claude-code` it still needs a model id from `--model` or
`models.mine`.

- `pre-mine`: parse each selected transcript and count its turns, Fable turns and extraction windows. It records a
  stage run, nothing else.
- `mine`: send the sampled windows to the extractor model. It returns decision points (the turns where Fable's next
  move teaches something) and principle candidates (a habit plus its why). The tool builds each episode itself from
  the transcript, so the model only picks turns and cannot invent the situation.

| Flag | Default | What |
|---|---|---|
| `--limit <n>` | `3` | Sessions this run |
| `--min-size <bytes>` | `100000` | Smallest transcript to consider |
| `--max-windows <n>` | `6` | Windows sampled per session, spread evenly |
| `--max-per-session <n>` | `4` | Episode cap per session |
| `--model <id>` | `models.mine` | Extractor model |
| `--backend <name>` | `ai-proxy` | `ai-proxy`, `grok` or `claude-code` |
| `--cc-profile <name>` | none | Profile for the `claude-code` backend |
| `--session <path...>` | selection | Explicit transcript files |
| `--session-concurrency <n>` | `3` | Sessions mined at once |
| `--effort <level>` | none | `low`, `medium` or `high` |
| `--hedge-after <secs>` | `0` (off) | Re-issue an extractor call that runs longer |
| `--json` | | Machine-readable output |

Pipe a bounded selection in rather than mining the whole corpus:

```bash
tools learn-from-fable mine --session $(tools learn-from-fable select --limit 5)
```

### Scoring and voting

- `filter`: the contrastive filter. For each unscored episode a bare model answers the situation, and the judge
  scores both that reply and Fable's real next move. An episode is kept when the reference scores at least
  `--keep-ref` and the bare reply at most `--keep-naive`.
  - `--slug <slug>`: episodes of one miner (default: all raw episode files).
  - `--filter-bare-model <id>`: the bare model (default `models.filterBare`).
  - `--filter-reference-model <id>`: the judge that scores both replies (default `models.judge`). It does not write
    a reference; the reference is Fable's own move from the transcript.
  - `--keep-ref <x>` (default 0.85), `--keep-naive <x>` (default 0.55), `--judge-batch <n>` (default 6),
    `--limit <n>`, `--effort <level>`, `--json`.
  - A run writes one `meta/filter-runs.jsonl` row for each slug that kept at least one episode. A run that keeps
    nothing writes no row there, so `report` shows no filter run for it; `meta/stage-runs.jsonl` still records it.
- `eval`: the A/B eval. The eval model answers each episode twice, bare and with the pack's `fable-style` skill in its
  system prompt, and the judge scores both against Fable's move. It prints mean soft score and hard rate per arm,
  and warns when an arm lost or skipped episodes.
  - `--model <id>` (default `models.eval`), `--judge-model <id>` (default `models.judge`).
  - `--slug <slug>`, `--limit <n>`, `--judge-batch <n>` (default 6), `--effort <level>`, `--json`.
  - `--filtered-only`: only episodes the filter has scored. The filter writes scores onto every episode it judged,
    kept or dropped, so this means "scored", not "kept".
- `consolidate`: several models vote on every unconsolidated principle: useful or useless, a confidence from 0 to
  100, and an optional "duplicate of an earlier one". Survivors of a round go to the next one.
  - `--models <ids>`: comma-separated voters (default `models.judge` and `models.eval`; the same model twice is one
    voter).
  - `--rounds <n>` (default 3), `--batch-size <n>` (default 20 principles per call),
    `--survive-threshold <x>` (default 0.5, the useful-vote fraction to survive), `--effort <level>`, `--json`.

### Writing the pack

- `spec`: merge mined principles into a FABLE-SPEC proposal, starting from the current canonical spec. It reads the
  consolidated survivors and, unless told otherwise, the raw unconsolidated candidates too, vetted ones first and
  strongest first. It writes a new file and never the canonical spec.
  - `--model <id>` (default `models.judge`), `--effort <level>`.
  - `--max-lines <n>` (default 200): line budget of the produced document.
  - `--min-confidence <n>` (default 70): drop voted principles below this; raw candidates have no vote to fail.
  - `--batch <n>` (default 120): candidates per merge pass; each pass merges into the running draft.
  - `--first-output <secs>` (default 300): silence before a pass is abandoned and retried. Opus answers in about
    3 s; grok can take 200 s and more.
  - `--consolidated-only`: skip the raw candidates.
  - `--no-tighten`: skip the last pass that splits oversized bullets back into principles.
  - `--out <path>` (default `<pack>/pack/FABLE-SPEC.<runId>.md`), `--json`.
- `skill`: an instruct stage. It prints the spec, the golden traces and the instructions for the LLM that ran it to
  rewrite `<pack>/skills/fable-style/SKILL.md` from the spec. `--max-lines <n>` (default 150) sets the body budget,
  because an unbounded skill file stops being read. `--sync` skips the instructions and copies the canonical skill to
  `~/.claude/skills/fable-style/SKILL.md` (a symlinked target stays a symlink).

The other instruct stages compute nothing. They print pack data plus instructions for the LLM that ran them:

- `self-review`: a live Fable session (ideally) audits the canonical spec: wrong, overfit or why-less principles,
  growth control (per-section caps, merged near-duplicates), and principles mining has not surfaced. The signal
  expires when the model stops being served. Its instructions tell the model to rewrite principles in place in the
  canonical `pack/FABLE-SPEC.md`, to note every change in `pack/changelog.md`, and to commit the pack repo. So a
  `self-review` changes the canonical spec directly, outside the proposal flow of `spec`.
- `hooks`: propose 3 to 7 deterministic Claude Code hooks from the spec and the unconsolidated principles. It writes
  nothing.
- `pre-score`: ranking unmined sessions before mining is deferred by design. The interim recipe it prints: run
  `pre-mine --limit 20` and mine the sessions with many Fable turns and many windows first, error-recovery-heavy
  projects first. A model-backed scorer pays off once mining cost dominates (more than 50 sessions a run).

## How it works

### The full loop

```bash
tools learn-from-fable bootstrap                 # once: where does the pack repo live
tools learn-from-fable stats                     # what is in the corpus, what to do next
tools learn-from-fable list --details
tools learn-from-fable pre-mine                  # cheap: parse and census, no model calls
tools learn-from-fable mine                      # the expensive stage
tools learn-from-fable filter
tools learn-from-fable consolidate --rounds 2
tools learn-from-fable spec                      # prints the proposal path plus the diff and cp to promote it
tools learn-from-fable skill                     # the running LLM rewrites SKILL.md from the promoted spec
tools learn-from-fable skill --sync
tools learn-from-fable eval --filtered-only
tools learn-from-fable report
```

The tool never runs git. Commit the pack folder yourself after a run; the printed instructions of `skill` and
`self-review` tell the model that ran them to commit it too. `golden-traces.md` is kept by hand (the
`/learn-from-fable` command keeps it at 15 episodes or fewer); `skill` only reads it.

### Why the stages are separate

Each stage is a gate, and the order controls cost.

- **`pre-mine` before `mine`**, because parsing and counting is deterministic and free, while mining is model-backed
  and is the expensive step. The window census tells you whether a selection is worth mining at all.
- **`filter` after `mine`**, because most extracted episodes are not discriminating. An episode both models handle
  well teaches nothing. The filter's output feeds `eval --filtered-only` and `report`; `spec` reads principles, not
  episodes.
- **`consolidate` before `spec`**, because a single model's opinion on whether a principle is useful is noise.
  Several models vote across N rounds, with confidence. It is optional: `spec` also reads the raw candidates unless
  you pass `--consolidated-only`.
- **`eval` after `skill`**, because it measures the skill that is in the pack now against a bare model. It does not
  gate single principles: only `report` reads `eval-runs.jsonl`. Run it once before a regeneration for a baseline and
  once after, and say plainly when n is too small to conclude anything.

### `spec` never overwrites the canonical spec

It writes a **proposal** and refuses both the canonical path and any existing file. Promotion of a proposal is a
separate, human decision: read the diff it prints, then copy the proposal over `pack/FABLE-SPEC.md`. `self-review`
reads the canonical spec, so it audits a proposal only after you promote it. Only `spec` writes a proposal:
`self-review` tells the model to edit the canonical spec directly, log each change in `pack/changelog.md`, and commit
the pack. Growth control in `self-review` is the check against a spec that grows without bound.

### Where data lives

- Config: `~/.genesis-tools/claude/fable/config.json`.
- Legacy transcript mirror: `~/.genesis-tools/claude/fable/sessions/` (machine-local, read only).
- The pack: a folder you choose, outside this repository. `stats` and every stage create `meta/` in it when it is
  missing.

```text
<pack>/
  pack/FABLE-SPEC.md                  canonical spec, hand-owned
  pack/FABLE-SPEC.<runId>.md          spec proposals
  pack/golden-traces.md               hand-kept traces that skill prints
  pack/changelog.md                   the pack's changelog
  skills/fable-style/SKILL.md         canonical skill: eval injects it, skill --sync copies it
  meta/stage-runs.jsonl               one record per stage run: params, inputs, outputs, error and stack
  meta/mined.jsonl                    one row per session and model mined
  meta/episodes/episodes.<slug>.raw.jsonl
  meta/episodes/episodes.<slug>.filtered.jsonl
  meta/principles/unconsolidated.jsonl
  meta/principles/consolidated.jsonl
  meta/principles/unconsolidated.<runId>.voted.jsonl
  meta/filter-runs.jsonl              one row per filter run and slug that kept episodes
  meta/eval-runs.jsonl
  processed.jsonl                     legacy prose-miner manifest (read only)
  skillopt-data/mined.jsonl           legacy episode-miner manifest (read only)
```

`<slug>` is the miner's runner id with every run of characters outside `a-z A-Z 0-9 . _ -` turned into one `-`. A
runner id is `ai-proxy:<model>[:<effort>]`, `grok:acp-default` or `claude-code:<profile>:<model>`, so mining with
`work/claude-sub/sonnet` writes `episodes.ai-proxy-work-claude-sub-sonnet.raw.jsonl`. Pass that slug to
`filter --slug` and `eval --slug`.

The tool reads transcripts and never writes them. `consolidate` never deletes its input: it renames
`unconsolidated.jsonl` to `unconsolidated.<runId>.voted.jsonl`, so `hooks` afterwards sees only principles mined since.

### Which sessions count

- Sources are the `sessionSources` in the config: the Claude projects folder (`~/.claude/projects`, or
  `$CLAUDE_CONFIG_DIR/projects`) and the mirror. A live source is searched with ripgrep for the exact string
  `"model":"<fable id>"`. The mirror holds only Fable sessions, so every `.jsonl` in it counts.
- The Fable id is the one the `fable` alias names in the model catalog: `claude-fable-5-2` since 2026-11-10
  (`claude-fable-5-1` from 2026-09-04). A session answered only by an older Fable is not found in a live source, and its turns do not count as Fable turns, so it
  yields no episodes. No flag changes it.
- Subagent transcripts and `agent-*` files are skipped. Files under `--min-size` (100000 bytes) are skipped. Copies of
  one session under several folders collapse to the largest file. The queue runs oldest first, because style
  evolution reads forward.
- A session is mined once any manifest names it: `processed.jsonl`, `skillopt-data/mined.jsonl`, or
  `meta/mined.jsonl` for any model. Reading only the legacy file once made `stats` report 1 mined and 120 unmined
  right after 20 sessions had been mined.
- Only top-level Fable turns become episode references; sidechains and subagent turns never do. Duplicate message
  lines around compaction and resume are dropped by uuid: 18 of 324 corpus files had them, the worst 538 lines
  (measured 2026-07-24).
- A window holds up to 36000 characters of condensed turns, with thinking shown to the extractor. An episode's
  situation holds up to 22000 characters (every user turn, then the most recent actions and results, no thinking).

### Models, backends and cost

- By default every model-backed stage calls through the local ai-proxy, which owns usage accounting. What a call
  costs depends on the proxy account behind the model id: a subscription or a metered API key. `mine` is the
  expensive stage.
- `mine` alone can switch backends with `--backend`:
  - `grok`: warm `grok agent stdio` processes from the grok CLI (`~/.grok/bin/grok`, or under `GROK_HOME`), about
    4 to 5 s a prompt against about 14 s for a cold `grok -p`. It runs the CLI's default model and ignores
    `--model` with a warning, but the stage still needs a model id from `--model` or `models.mine`.
  - `claude-code`: `tools cc run <profile> -- -p` with no tools, no settings sources, no MCP servers and one turn.
    `--cc-profile` is required; nothing defaults it. The model id goes to Claude Code's own `--model` as it is, so
    pass a Claude Code model name (`--model sonnet`). Without `--model` it gets the ai-proxy id from `models.mine`
    (such as `work/claude-sub/sonnet`), which is not a Claude Code model name.
  - Calls of the `grok` and `claude-code` backends do not go through the proxy, so the proxy has no record of them.
  - `--effort` reaches only the ai-proxy backend. It also becomes part of the runner id, so mining with an effort
    writes its own episode file.
- Every ai-proxy call carries tags: the stage run id as the session, the stage name, and a job label such as
  `extract-window-3-1a2b3c4d`. `tools ai-proxy calls --session <runId>` lists one run's calls, `--stage mine` a
  whole stage, and `--show` prints the full prompt and response. Tokens and write-time cost per request are in
  `~/.genesis-tools/ai-proxy/usage/requests.jsonl`.
- Calls in flight: 6 per stage. `mine` runs 3 sessions at once, each with up to 6 windows in flight. The proxy fans
  out cleanly: 20 concurrent grok-4.5 calls finished in 8.9 s wall against a 133 s serial sum (2026-07-24).
- Hedging is off by default. Measured 2026-07-24 on grok-4.5: four hedges fired at 25 s, the two that won saved
  2.8 s and 4.0 s, and the straggler that set the wall time (48.0 s) got a slower second attempt (69.0 s). The
  latency is upstream queueing, so a duplicate joins the same queue. Use `--hedge-after` only when a provider's tail
  is connection-bound.

### Scoring

The judge grades each candidate move against Fable's real move on four axes:

| Axis | Weight | Question |
|---|---|---|
| a1 action class | 0.35 | Same class of move (verify, probe the premise, ask, ...)? |
| a2 evidence | 0.25 | Would running it produce the same decisive evidence? |
| a3 spec | 0.25 | Fraction of the moment's spec principles it satisfies |
| a4 specificity | 0.15 | Concrete paths and commands from this situation? |

The soft score is the weighted sum. The hard score is 1 only when a1 is 1 and the soft score is at least 0.7. A
reply that restates principles ("I should verify first") without a concrete command scores a4 = 0 and cannot score
a1 = 1. A batch whose JSON comes back short is halved and only the missing items are judged again, down to one.

### Safety rails

- **Re-mining is idempotent.** Episode ids are the session stem plus the turn index, so a second run merges by id
  and keeps the filter's scores. Before this, one episode was present five times.
- **An outage does not retire a session.** A session with no episodes and failed calls on at least half its sampled
  windows is not marked mined. The proxy crashed mid-run on 2026-07-25 and 83 sessions were marked done with zero
  episodes, which had to be unpicked by hand.
- **A dead proxy is not a filter result.** When every episode fails on infrastructure, `filter` fails the stage
  instead of recording "kept 0/94" as a green run (2026-07-25).
- **Scores are written back onto dropped episodes too**, so the next run pays only for unassessed ones. Before this,
  a run that judged 446 episodes and kept 148 left 292 looking unfiltered.
- **Silent calls are cut.** An ai-proxy call that produces nothing in 90 s is retried once; one that goes quiet for
  60 s after it started fails. Across 55 filter calls on 2026-07-25 the first token arrived at p50 2.0 s, p90 11.2 s,
  max 14.7 s. A clean but empty completion also gets one retry. `spec` passes get 300 s for their first output,
  because a pass rewrites the whole document.
- **A spec pass cannot erode the draft.** A pass is rejected, then retried once with the reason named, when it
  loses more than 15% of the content or of the bullets against the largest draft so far, or drops a whole section.
  Bullets over 420 characters count as oversized; the tighten pass asks for 340. The hand-written spec averages 229
  characters a bullet; the 2026-07-25 v6 proposal had grown to an average of 736 and a worst bullet of 4363 inside
  its line budget.
- **Every stage run is audited.** `meta/stage-runs.jsonl` gets a record on success and on failure; a failure carries
  the message, the stack, the inputs and any partial outputs. Only a failure after the stage started is recorded:
  the checks that run before it (stage model, ripgrep, cc profile) fail with no record. `report` is the audit trail
  that makes a claim like "this principle improved the eval" checkable later.

## Configuration

`~/.genesis-tools/claude/fable/config.json`. `bootstrap` writes every key except `models`; add the `models` block by
hand (later `bootstrap` runs keep it):

```json
{
  "packPath": "/absolute/path/to/FablePack",
  "sessionsMirrorPath": "/absolute/path/to/.genesis-tools/claude/fable/sessions",
  "sessionSources": ["/absolute/path/to/.claude/projects", "/absolute/path/to/.genesis-tools/claude/fable/sessions"],
  "models": {
    "mine": "work/claude-sub/sonnet",
    "filterBare": "work/claude-sub/sonnet",
    "judge": "work/claude-sub/opus",
    "eval": "work/claude-sub/sonnet"
  },
  "notes": "Written by tools learn-from-fable bootstrap."
}
```

| Key | Default | Used by |
|---|---|---|
| `packPath` | required | every stage |
| `sessionsMirrorPath` | `~/.genesis-tools/claude/fable/sessions` | candidate listing |
| `sessionSources` | Claude projects folder and the mirror | candidate listing |
| `models.mine` | none | `mine` |
| `models.filterBare` | none | `filter` |
| `models.judge` | none | `filter`, `eval`, `spec`, `consolidate` voters |
| `models.eval` | none | `eval`, `consolidate` voters |
| `notes` | bootstrap's note | nothing |

- Paths are stored absolute; the tool does not expand `~` in this file.
- Model ids are full ai-proxy ids, `<account>/<provider>/<model>` (`tools ai-proxy models` lists them). They are
  machine-specific, so they live here and never in code. A stage with no model from its flag or the config stops and
  names the key to set.
- `bootstrap` refuses a config file that does not parse and leaves it as it is.

Environment variables:

- `GT_FABLE_PACK_PATH`: the pack path `bootstrap` suggests.
- `CLAUDE_CONFIG_DIR`: the Claude folder (default `~/.claude`) whose `projects/` `bootstrap` writes into
  `sessionSources`, and the root of the `skill --sync` target.
- `GROK_HOME`: where the `grok` backend finds the grok CLI.

## For agents

- `--json` on `stats`, `list`, `select`, `pre-mine`, `mine`, `filter`, `eval`, `consolidate`, `spec` and `report`
  prints one JSON result on stdout. `select` without `--json` prints one path per line.
- With `--json`, a stage that finds nothing to do prints one info line on stderr, no JSON, and exits 0. Treat empty
  stdout as "nothing to do". The cases: `mine` and `pre-mine` ("Nothing unmined for this selection."), `filter`
  ("No unfiltered episodes"), `eval` ("No episodes to evaluate"), `consolidate` ("No unconsolidated principles") and
  `spec` ("No principle candidates yet").
- A stage that fails after it starts exits 1 and appends an `error` record to `meta/stage-runs.jsonl`. A check that
  fails before the stage starts also exits 1, but writes no record: no model for the stage, no ripgrep, no
  `--cc-profile` for the `claude-code` backend, or a config file that does not parse. Read stderr
  (`ERROR: <message>`) or the day log for those.
- Four refusals print an error on stderr and still exit 0, so do not trust the exit code alone: no config ("No fable
  config yet"), `consolidate` with no voter models, `bootstrap` without `--pack-path` in a non-interactive run, and
  `skill --sync` with no canonical `SKILL.md`.
- The instruct stages (`skill`, `self-review`, `hooks`, `pre-score`) print markdown for the model that ran them.
  Follow it in-session. Only `skill --sync` changes a file by itself; the printed instructions of `skill` and
  `self-review` tell the model to edit pack files and commit the pack.
- In a GenesisTools checkout, the `/learn-from-fable` command (`.claude/commands/learn-from-fable.md`) drives the whole
  loop through this CLI: `[max-sessions]` (default 3), `--stats-only`, `--repack` (skip mining, regenerate the skill).
  Never read a raw `.jsonl` transcript in the main session; the CLI parses them.
- Helper scripts live in the repository's `scripts/learn-from-fable/` folder:
  - `bun scripts/learn-from-fable/audit-spec.ts <spec.md> [baseline.md]`: is a proposal still a list of principles
    (oversized bullets, near-duplicates)? The v6 proposal passed every stage metric with 55 of 78 bullets over 400
    characters.
  - `bun scripts/learn-from-fable/tighten-spec.ts <in.md> <out.md> [--model <ref>]`: split the oversized bullets of
    an existing proposal without re-running the merge passes (model calls, default `models.judge`).
  - `bun scripts/learn-from-fable/transcript-parity.ts <session.jsonl...>`: the parser parity harness. Run it whenever
    `lib/transcript.ts` changes. Its Python side, `transcript_parity.py`, prints the same JSON shape from the Python
    reference parser (it needs `SKILLOPT_PATH`); diff the two outputs.
  - The `probe-*.ts` and `replay-*.ts` scripts are the latency, concurrency and guard probes behind the measured
    numbers above.

## Troubleshooting

- **"No fable config yet".** Run `tools learn-from-fable bootstrap --pack-path <folder>`.
- **"--pack-path required in non-interactive mode."** `bootstrap` cannot prompt; pass the flag it prints.
- **"No model configured for stage 'mine'."** Set `models.mine` (or the named key) in the config, or pass the
  stage's model flag.
- **"ripgrep is required to enumerate fable sessions."** Install it (`brew install ripgrep`). Without it a live
  source cannot tell a Fable session from any other.
- **0 candidates, but you have Fable sessions.** Check the model id in the transcripts: only the id the `fable` alias
  names counts (see Which sessions count). Lower `--min-size` for short sessions.
- **A second model mines other sessions, not the same ones.** Automatic selection skips a session that any model
  mined, so `--model` alone moves on to the next unmined sessions. For side-by-side episodes, pass the paths:

  ```bash
  tools learn-from-fable mine \
      --model work/claude-sub/opus \
      --session $(tools learn-from-fable list --all --json --limit 50 | jq -r '.sessions[] | select(.mined) | .path')
  ```

- **`filter` fails with "every episode failed on infrastructure".** The proxy is down: `tools ai-proxy up`.
- **`eval` fails with "No skill to evaluate".** Write `<pack>/skills/fable-style/SKILL.md` first (`skill`).
- **`spec` refuses to overwrite.** The target is the canonical spec or an existing file; pass another `--out`.
- **"ClaudeCodeRunner requires an explicit cc profile."** The `claude-code` backend needs `--cc-profile <name>`.
- **"No voter models."** Pass `consolidate --models a,b` or set `models.judge` and `models.eval`.
- **A stage failed and you need the detail.** For a failure after the stage started, the full error is in
  `meta/stage-runs.jsonl`. A missing model, a missing ripgrep or a missing cc profile fails before the stage starts
  and writes no record there: read stderr or the day log. Prompts behind JSON repairs and drift retries are in the day
  log under `~/.genesis-tools/logs/`.
- **The command printed an error but exited 0.** The refusals for no config, no voter models, a non-interactive
  `bootstrap` without `--pack-path` and `skill --sync` without a skill do not set an exit code (see For agents).
- **`mine --backend claude-code` gets the wrong model.** Without `--model`, Claude Code gets the ai-proxy id from
  `models.mine`, which is not a Claude Code model name. Pass one: `--model sonnet`.

## Related

- [`tools ai-proxy`](../ai-proxy/README.md): runs every model call, and its `calls` command opens a run's transcripts.
- [`tools cc`](../cc/README.md) and [`tools claude`](../claude/README.md): `cc run <profile>` is the `claude-code`
  backend.
- [`tools grok`](../grok/README.md): drives the same grok CLI as a headless worker. The `grok` backend talks to
  that CLI directly, not through `tools grok`.
- `fable-style` is the skill this pipeline produces. `fable-judge` is a separate skill for adversarial verification
  of finished work; it is not part of this tool.
