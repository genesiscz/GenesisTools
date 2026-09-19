# Acceptance evidence and unfinished work

Use this when resuming an interrupted implementation or checking whether a control plan is complete.

Read the original plan's acceptance clauses and later user changes before a completion note. For each clause retain the implementing symbol and a test or live receipt that can falsify it. Separate implemented-and-verified, implemented-but-unverified, missing, and explicitly superseded. A module named after a feature proves none of its acceptance clauses. A user's additional demonstration or skill request does not cancel earlier missing implementation.

For Codex sessions, a Claude-only interruption scanner may return “No transcript.” That is an unsupported-format result, not an empty obligation list. Read the native session's user messages and tool receipts; do not invent Claude queue-operation fate labels. Do not repeat an answered approval question.

For supported Claude transcripts use both `--all` and `--boundary`: the former disables the
saved incremental cutoff, the latter adds non-queued requests. Neither promises an exhaustive
message inventory when the scanner filters short or uncheckable text. A full audit must also
retain short corrections, answered questions and user-edited goals. For Codex, enumerate native
user-text records and goal edits directly, separating runtime-injected context by its metadata.
Deduplicate message IDs, not repeated wording; a repeated instruction is evidence. Trace a
promised rerun to its actual result. An older successful run does not close a later failed rerun.

## Measure decision policies

```bash
# Exact-only: no UI actions and no model requests.
bun src/control/index.ts compare-choosers --split all

# Requires the user's Jev authorization. Synthetic text only; no desktop actions.
bun src/control/index.ts --provider typesafe compare-choosers --jev --split all --calibrate
```

The calibration report collects one response per case/mode, then sweeps conservative policies with no extra paid requests. Development labels choose the policy; held-out labels only measure it. The runtime policy is unchanged. Keep provider, corpus, raw rows, selection rule, usage availability and failed attempts with the report. Missing costs/tokens are unknown, not free. Correct abstentions count toward correctness; report wrong choices and abstentions separately so stopping on everything cannot masquerade as task completion.

Ten synthetic examples are a smoke corpus. Handoff counts do not measure assistant conversation turns. Task duration must include observation, actions and verification; decision replay cannot prove desktop throughput. One successful rerun cannot establish parity with another computer-use system. Do not lower execution thresholds to improve a demonstration.

For actual end-to-end evidence, `live-smoke.ts --task-benchmark` runs alternating public-API
stepwise and compound tasks. Its `--host-paced` mode records real host dispatch boundaries.
Report both verified outcomes and the number of calls, including failures, and keep the measured
fixture/task scope explicit. See [automation-playbooks.md](automation-playbooks.md).

## Source, cache and loaded instructions

Inspect the installed plugin's source before refreshing it:

```bash
codex plugin list --json
```

A worktree may contain new instructions while the marketplace still points at the main checkout. Reinstalling then loads the old source. Resolve source provenance before using the supported plugin update flow; do not overwrite a cache, silently repoint a shared marketplace, or merge a feature branch merely to claim refresh. Distinguish source committed, cache installed, and instructions actually loaded. An already-loaded conversation retains its earlier instructions; explicitly read the current source for this task and use a fresh thread after a verified install.

## Remaining platform limits

Native popup selection does not cover every custom web dropdown. An app that omits validation attributes needs an explicit observed postcondition. OCR clicks intentionally refuse changed pixels, including animation; an unchanged AX tree cannot override this. Scoped semantic waits require a caller-selected evidence container to exclude unrelated changing text. Preserve these limits in acceptance reports until a targeted implementation and proof close them.
