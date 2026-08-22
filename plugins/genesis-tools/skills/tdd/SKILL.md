---
name: tdd
description: >
  Test-first workflow for implementing ANY feature or bugfix — use BEFORE writing implementation
  code, even when the user never mentions tests. Also use whenever the user says "tdd", "red-green",
  "test-first", "write a failing test", "reproduce this bug with a test", "regression test", pastes
  an error message with "fix this", or asks to change the behavior of existing code. One unified
  red→green loop with mechanical evidence gates (verbatim RED capture, double-GREEN flake check,
  weakened-assertion guard) via a bundled Bun script. Not for: read-only questions, research,
  documentation, or config-only changes. Exceptions (throwaway prototypes, generated code, trivial
  changes) require asking the user first — see the body.
---

# TDD — Red, Green, Evidence

## The Iron Law

**NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.** Code written before its test gets removed from the working tree — not kept "as reference", not "adapted while writing tests". Remove it recoverably, never with `rm` and never with `git checkout --`: `git stash push -m "pre-TDD draft, superseded by test-first implementation" -- <files>`. Then implement fresh from the test; consulting the stash while implementing is testing after and defeats the point. If you did not watch the test fail, you do not know whether it tests anything.

Exceptions (throwaway prototypes, generated code, config files, trivial changes): ask the user before skipping. When you cannot ask (non-interactive run, subagent, headless), there is no exception — write the test. "Nobody was available to approve the skip" is not approval.

<HARD-GATE>
**MANDATORY: BEFORE writing any test body, READ `references/test-quality.md`.**
WHEN: before the first line of every new or edited test — bugfix or feature, first test of the session or the tenth — and before any `toMatchSnapshot` / `toMatchInlineSnapshot` assertion, which the reference treats separately.
WHY: without it you will write tautological tests that recompute the expected value the way the code does and pass by construction — they can never catch the bug. "I already know the pattern" is not an exemption: the file is the checklist you verify each test against, not a tutorial.
</HARD-GATE>

<HARD-GATE>
**MANDATORY: BEFORE adding any mock or test double, READ `references/mocking.md`.**
WHEN: the moment a test needs its first mock, fake, stub, or spy — even one you have written a hundred times. A plain function or closure standing in for a real dependency counts; "it's just a function, not really a mock" is the exact rationalization this gate exists to stop.
WHY: mocking a method without knowing its side effects silently removes the behavior the test depends on; the test then passes for the wrong reason and proves nothing. Run the file's gate functions before every mock — no "I already know mocking" escape.
</HARD-GATE>

## Step 0 — Resolve the test command

1. If the target repo has a `.claude/config` with `TEST_CMD` (full suite) and `TEST_CMD_SINGLE` (one file/test), use those. The file is flat shell-style `KEY=value` lines (`#` comments allowed); a `.claude/config.local` beside it overrides it key-by-key. Most repos do not have one.
2. Otherwise auto-detect — `package.json` `scripts.test`, `composer.json`, `pytest.ini` / `pyproject.toml`, `Makefile`, CI configs — state the command you picked in one line, and continue. Ask only when detection finds two plausible commands and picking wrong is expensive. In a repo with a test wrapper script, use the wrapper: bare runners can resolve against the wrong dependency tree.

User gives a GitHub issue URL or number → fetch it via the `genesis-tools:github` skill first.

## Entry ramps

**Bugfix** — the code exists and misbehaves. Restate the bug (what is broken / expected behavior / reproduction steps / affected area), locate the code path, then enter the loop. Your first prediction describes how the EXISTING code fails. Every bugfix-entry test carries a comment linking it to its origin: `// Regression test: <issue-or-report ref> — <one-line description>` (feature-entry tests do not need one).

**Feature** — the code does not exist yet. Agree the seams first: the public boundaries the tests observe behavior through, never internals (internal-coupled tests break on refactor with behavior unchanged). Confirm the seams with the user when the interface shape is in question. Then work in vertical slices: one test → one minimal implementation → repeat, each test a tracer bullet informed by the last cycle. Never write tests in bulk first — bulk tests verify imagined behavior and commit you to structure before you understand the implementation.

## The loop

### 1. Predict — before writing the test

State this inline and continue; do NOT block waiting for approval. Block only when the seam is genuinely ambiguous or a wrong guess is expensive to undo.

- **WHAT** the test asserts: "`cancelBooking()` on an already-cancelled booking throws"
- **PREDICT** the exact RED output: "Expected error, none thrown"
- **WHY** current code produces it: "no status guard before proceeding" (feature entry: "the function does not exist yet — TypeError/import failure")

### 2. RED — write the test, watch it fail

Write ONE test (test-quality gate above applies), then run it through the gate script:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/skills/tdd/scripts/tdd-gate.ts" red \
    --cmd "bun test src/cart.test.ts" --test-file src/cart.test.ts
```

It tees full output to the session dir, records the exit code, snapshots the test file(s), and prints the failure lines ready to quote. Quote the failure VERBATIM in your report — "I watched it fail" is a claim; a pasted failure line is proof.

### 3. Triage — prediction vs actual (MANDATORY)

| Actual RED result | Action |
|---|---|
| Matches prediction | Bug/gap confirmed. Proceed to GREEN. |
| Fails differently | The code misbehaves differently than you thought. Update understanding, re-predict, re-run. |
| Errors (import, setup, typo) — the gate flags these ⚠️ | An error is not a RED — fix the setup, re-run. Exception: feature entry where the module does not exist yet; then the import failure IS the expected first RED. |
| Passes | No-RED branch below. Do NOT proceed to GREEN. |

A mismatch is information, not process failure.

### 4. No-RED branch — the test passes when it should fail

Three hypotheses, in order: **(a)** the bug does not exist — ask the user for details; **(b)** test conditions differ from the report — recheck the reproduction steps; **(c)** already fixed — check `git log` on the affected code. (Feature entry, e.g. a test added to close a mutation-check gap: the existing code may already generalize to this case — confirm by READING the code, then keep the test as regression coverage.)

When the root cause stays unclear, form 2-3 competing hypotheses (H1/H2/H3) and confirm or eliminate each with EVIDENCE. Never guess runtime values — one real dump beats a hundred lines of static reasoning. For runtime instrumentation, invoke `genesis-tools:debugging-master` (your and the user's discretion).

### 5. GREEN — minimal fix, verified twice

Make the minimal production change that passes the test. Minimal means enough for THIS test only — do not implement later slices' branches early; the next slice's test earns the next branch. Fix at the root cause: when the buggy function has other callers, the fix belongs in the shared function, not in your call site. No refactoring, no unrelated fixes. Then run green with the SAME command RED witnessed (the gate refuses any other):

```bash
bun "${CLAUDE_PLUGIN_ROOT}/skills/tdd/scripts/tdd-gate.ts" green --cmd "bun test src/cart.test.ts"
```

The script enforces the gates. It runs the tests TWICE — this catches state that leaks between runs (it cannot see test-order dependence). If the two runs disagree, the test is FLAKY and the gate exits nonzero: do NOT declare done — find the nondeterminism source (time, randomness, shared state, test-order dependence), fix it, re-run the gate. It diffs the test file(s) against the RED snapshot and checks for created or changed `.snap` files: GREEN must come from production code, not from a weakened assertion or a recorded snapshot. An edit that removes or changes an assertion can never be waved through — re-run `red` so the edited test has its own witnessed failure. `--allow-test-edit "<reason>"` covers only edits that cannot change whether the test passes: comments, formatting, imports, identifier renames on lines no assertion touches (a rename that edits an assertion line needs a fresh `red` — one extra command, since the test still fails). Any edit to a value an assertion consumes, to how a test is registered (`skip`/`only`/`todo`), or that makes the assertion unreachable (an early return, a disabled branch) is an assertion change, whatever the diff looks like — re-run `red`. The gate also compares executed-test counts between RED and GREEN, so a skipped or deleted test cannot read as a pass. The reason and the exact diff of an allowed edit are recorded and printed in the report.

### 6. Refactor — optional, after green

Clean up names and duplication. Tests stay green; no new behavior. Next slice → back to step 1.

## Finishing (MANDATORY)

**Full suite.** Run `TEST_CMD` once the slice is green. The single-file gate proves your test passes; only the suite proves you broke nothing. Record it in the trace.

**Mutation check.** Mentally mutate the production code you wrote, one mutation per category: wrong constant/argument, inverted branch, missing side effect, empty return, missing validation (zero/empty/nil/unauthorized). For each, name the exact edit and the exact test that catches it — the report format below forces this. A mutation nothing catches marks the behavior as unprotected, or the test as tautological; add the missing test or state in one sentence why the behavior is out of scope. For critical code, real mutation tooling (e.g. Stryker) is available at your and the user's discretion.

## tdd-gate.ts

Use it whenever the test command runs locally — the normal case. Before falling back to prose gates, paste the failed gate invocation and its error; "it would not work here" is not evidence. All subcommands run as `bun "${CLAUDE_PLUGIN_ROOT}/skills/tdd/scripts/tdd-gate.ts" <subcommand>`:

```
red    --cmd "<test cmd>" --test-file <path> [--test-file <path>...] [--session <name>]
green  --cmd "<same cmd as red>" [--allow-test-edit "<reason>"]   # never --test-file here
report              # paste-ready evidence block; lists every completed slice in the session
clean  --session <name>                                           # explicit only, never bare
```

Sessions live at `~/.genesis-tools/tdd/sessions/<name>/`. Default name at `red`: the git branch (outside git, a timestamp); `green`/`report` follow the session the last `red` wrote from your working directory. `green` prints its binding (session name, red command, guarded files) — if the session name differs from the one your `red` printed, STOP: you are guarding the wrong files. Parallel agents on one branch must pass distinct `--session` names. Note: the harness substitutes `${CLAUDE_PLUGIN_ROOT}` at load time; if you see the placeholder unsubstituted, build the path from the "Base directory for this skill" line printed when this skill loaded.

Fallback recipe for remote/REPL-only environments (exit code preserved, artifacts on disk — never pipe to `tee`; `$?` after a pipe is the pipe's exit, not the test's):

```bash
mkdir -p /tmp/tdd && cp src/cart.test.ts /tmp/tdd/cart.test.ts.red
<cmd> > /tmp/tdd/red.txt 2>&1; echo "exit=$?"
diff -u /tmp/tdd/cart.test.ts.red src/cart.test.ts    # paste this output; empty means clean
<cmd> > /tmp/tdd/green1.txt 2>&1; echo "exit=$?"
<cmd> > /tmp/tdd/green2.txt 2>&1; echo "exit=$?"
```

Paste the exit lines and the diff into the trace. An unpasted gate did not run.

## Rationalizations

| Excuse | Reality |
|---|---|
| "Too simple to test" | Simple code breaks too. The test takes 30 seconds. |
| "I'll test after" | Tests passing immediately prove nothing — you never saw them catch anything. |
| "Already manually tested" | Ad-hoc is not systematic: no record, no re-run on the next change. |
| "Deleting X hours of work is wasteful" | Sunk cost — and nothing is deleted: the draft goes into a git stash. |
| "Keep it as reference" | You will adapt it — that is testing after. Stash it and implement fresh. |
| "Test is hard to write" | Hard to test means hard to use. Listen to the test; simplify the design. |
| "This is different because..." | It never is. Ask the user instead of deciding alone. |

## Report format

End with this trace. Paste the `tdd-gate.ts report` output as-is — do not retype the RED lines. A multi-slice feature session repeats the RED and GREEN lines once per slice; never report only the last slice:

```
## TDD Trace: <title>
**Type:** bugfix | feature   **Cause:** <root cause, bugfix only>   **Fix:** <one line>
**RED:** <verbatim failure line(s)> — prediction: matched | differed: <how>
**GREEN:** `<cmd>` — passed 2/2 runs · <production change>
**Guard:** test files unchanged since RED | non-assertion edit allowed: "<reason>"
**Suite:** `<TEST_CMD>` — <N passed, 0 failed>
**Mutation check:** one line per category (wrong constant · inverted branch · missing side effect ·
  empty return · missing validation), each as: `<file>:<line>` <before → after> → caught by
  `<test name>` | UNPROTECTED + <new test added, or one sentence why out of scope>
**Files:** test `<path>` · production `<path>`
```
