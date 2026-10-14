---
name: babysit
description: Run a PR review loop where external worker models fix the review findings (Grok through `tools grok`, Codex Sol through `tools codex`, chosen per PR) and this Claude session is the master that briefs them, watches them live, judges every fix with fable-judge, adds one correction commit, cherry-picks onto the PR branch, pushes, and reports with costs. Use it whenever the user asks to let Grok, Codex, Sol or "other models" fix PR reviews, to babysit workers on PRs, to run the worker review loop or its next phase, to compare worker models on review fixes, or says "babysit" — even when they only name PR numbers and a model. Not for a plain review loop that Claude fixes itself (use review-loop alone), and not for a one-off handoff that is not about PR review findings (use handoff-to alone).
---

# babysit: other models fix the review findings, this session judges

This session is the **master**. Workers (Grok or Codex Sol) do the fixing on their own PRs; the master briefs them,
watches them, judges each fix as if a stranger wrote it, corrects what is wrong, integrates, pushes and reports. The
process was proven on 2026-10-14 (Phase 1 and 2: Grok 4.7 Fast on #512, Sol 6.1 on #511); the numbers and the
mistakes it found are in [references/history.md](references/history.md). Read that once before your first run.

Why the master judges everything: both workers produced green tests and confident reports, and one of them still
shipped a defect (a raw error that broke a module's "throws only CdpLaunchError" contract). A worker's report is a
set of claims. The value of this loop is the judge.

## 0. Load the mandatory skills first

Invoke, with the Skill tool, before any other step:

1. `genesis-tools:handoff-to`: worker choice, the readiness gate, and its `references/grok.md` or
   `references/codex.md` for every spawn flag. Never hand-roll `grok -p` or `codex exec`.
2. `genesis-tools:agents-talk`: the lead's bus listener under Monitor, the 30-minute re-arm, worker identities.
3. `review-loop` (listed as `me:review-loop`; Martin's local skill, real files in
   `GenesisClaude/user/skills/review-loop/`): Rule 0 thread fetching, the five hidden channels, the round policy,
   the reply-file JSON, `round-summary.ts`, `post-replies.ts`, `new-threads.ts`, `thread-audit.ts`.
4. `fable-judge` when you judge (step 6), inline, no delegation of the verdict itself.

These skills own their mechanics; this file only says how they fit together. When they disagree with this file,
they win for their own mechanics, and you say so in the report.

## 1. The run card: what to configure

Write it to `/tmp/cc/<project>/<session>/babysit/run.json` at the start; the scripts read it.

| Field | Default | Notes |
|---|---|---|
| `prs` | asked | PR numbers. Small PRs first; never a PR another session owns (step 3.1). |
| `worker` per PR | `grok` | `grok` (model `grok-4.7-build-fast`, `--auth subscription`) or `codex` (model `gpt-6.1-sol`, effort `medium`, `--write ask`). Mix freely; one worker per PR. |
| `mode` | from `scripts/mode.ts` | `worktree` or `unified`, step 2. |
| `maxParallel` | 3 | Workers at once. The master is the bottleneck, not the workers. |
| `post` | ask | Post the round summary and replies after the push (review-loop step 4), or hold them in the vault. |
| `report` | vault note | Optionally also a bus message: `{ "session": "grok-dev", "to": "grokbot-developer" }`. |
| `stopAfter` | the user's words | A phase or round to stop at. Stop there even if everything is green. |
| `vault` | `<run>/vault` | The notes folder of this run: reply files, summaries, the rendered ledger. Set it. |
| `judge` | `Claude` | The name the round summary credits as judge ("… from <worker> judged by <judge>"). |
| `worktrees` | `<run>/worktrees` | Parent of the per-PR worker worktrees `bs-<N>`. |

Every script below takes `--run <run dir>` (or `BABYSIT_RUN`) and reads this card through `scripts/run.ts`.

## 2. Mode: a worktree per worker, or the unified branch

`bun .claude/skills/babysit/scripts/mode.ts --workers <n> [--swift <n>]` prints free disk, the estimate and a
recommendation. Measured on 2026-10-14: a worktree plus `bun install --ignore-scripts` costs about 0.12 GB (APFS
clones), and a GenesisKit Swift test build adds about 1 GB. The script recommends `worktree` when free disk stays
above 10 GB after all worker worktrees, else `unified`.

- **worktree (preferred)**: each worker gets its own worktree of its PR branch, commits there, and the master
  cherry-picks the pair onto unified afterwards. No index-lock races between workers, no half-written files from a
  neighbour in a typecheck, and the commits apply to the PR branch by construction.
- **unified**: workers share the main checkout on the unified branch (the 2026-10-14 setup). The master then
  cherry-picks onto the PR branch in a scratch worktree, and a file that unified changed later than the PR branch
  conflicts (#511's import list did). Use it only when disk is short.

🛑 **Confirmation period (from 2026-10-14 until Martin says he no longer needs it):** before you dispatch, show the
plan with AskUserQuestion and wait: the PRs, the worker per PR, the mode with the free-disk numbers, `post`, and
the stop point. After the confirmation period, state the plan in one line and proceed.

## 3. Prepare each PR

1. **Owner.** A PR another live session works on is not yours to dispatch. Look for a lock on its worktree
   (`git worktree list --porcelain`: the `locked` reason names the session), and for a live agent on its branch
   (`tools hub agents`). If one exists, ask it with `tools claude message <session> "<question>" --wait
   --wait-timeout 300` and dispatch only on an explicit "free". Silence is not consent.
2. **Stacks.** `gh pr view <N> --json baseRefName`: when a PR's base is another open PR's branch, a push to the parent
   moves the child's base, and GitHub then shows the parent's new commits in the child's diff until it is restacked.
   Push the parent first. Never give two workers in one round a file that both PRs change; run them one after the
   other instead. Do not restack the child in a round: that belongs to merge prep (review-loop landing recipe), or
   to the user's word.
3. Fetch the findings per review-loop Rule 0 (`tools github review <N> --llm -u`, never filtered by reviewer), sweep
   the hidden channels, `expand` every thread (the L1 table can scramble files). Keep each thread's `threadId`.
4. Read the source at every cited line before you brief: a stale or wrong finding is briefed as such, so the worker
   does not "fix" it.
5. **Round policy.** review-loop decides what gets fixed in each round (rounds 1 and 2: every valid finding; later
   rounds: critical and high). When the user's own words ask for a fix the policy would only answer ("fix the open
   threads"), the user's words win; say so in the plan.
6. Scope: `git fetch origin <pr branch>`, then `bun .claude/skills/babysit/scripts/pr-scope.ts <N> --compare HEAD`.
   It lists the PR's files, the test file of each one (a sibling `.test.ts`, or a neighbour test that imports it),
   and whether unified differs from the PR branch per file. That list is the outer bound. The brief allows the files
   the findings cite plus their tests, and any other PR file a fix provably needs. Missing a test file in the scope
   put Grok's tests in the wrong file on 2026-10-14.
7. **Worktree** (worktree mode): `bun .claude/skills/babysit/scripts/setup-wt.ts --run <dir> --pr <N>`. Detached at
   the PR head, `bun install --ignore-scripts` plus the repo's patches, the test wrapper's install stamp (else
   `scripts/test.ts` reinstalls everything inside the worker's sandbox), native files linked to the main checkout's
   twins (`link-native.ts`: on 2026-10-14 a stuck syspolicyd hung every NEW native binary at `_dyld_start`), nested
   app `node_modules` linked. About 7 s with a warm bun cache.
8. Baseline the cost: `tools grok usage --json --fresh` (the SuperGrok weekly percentage) for Grok workers. Every
   worker turn is booked in the cost ledger with its ai-spend price, login and label, and its report (Codex: the
   `turn_completed` bus event and `status --json` `cost`) ends with one line: API-equivalent, billed, and a Claude
   Opus/Sonnet estimate for the same tokens. The API-credit
   proof (the xAI console) is needed only for a `--auth api-key` worker or when the user asks for it. It lives in
   the user's own browser, so ask before you touch it, read an already-open console tab with a read-only CDP
   `Runtime.evaluate` of the page text, and never reload, navigate or restart the browser for it.

## 4. Brief and dispatch

Two brief forms. **Self-fetch** (the default since 2026-10-14):
`bun .claude/skills/babysit/scripts/fill-brief.ts --run <dir> --pr <N> --round <R> --model "<label>" --scopes "<a, b>"
[--swift] [--judge <findings.md>]` fills [references/brief-self-fetch.md](references/brief-self-fetch.md): the worker
lists and expands the threads itself with `tools github review`, fixes, commits once and writes the reply file; the
lead's judge findings on an earlier commit ride along with `--judge`. **Pasted findings**: fill
[references/brief-template.md](references/brief-template.md) per PR (the findings pasted in full, the scope,
the verify commands, the commit subject `fix(<scopes>): #<N> followup - <what>`, the reply-JSON shape, the bus
lines, the stop point). The handoff-to readiness gate applies: self-contained, a verify command the sandbox can
run, explicit negative constraints, a named checkpoint, a deliverable the sandbox can write.

Worker cwd: its worktree (worktree mode) or the main checkout (unified mode). The reply JSON and the rendered
summary go to `.claude/work/babysit/` inside that cwd (ignored by git; Grok's jail blocks writes outside cwd).

- Grok: `tools grok spawn --name bs-<N>-grok --cwd <cwd> -m grok-4.7-build-fast --auth subscription
  --label "babysit pr<N>" --prompt-file <brief>` with Bash `run_in_background` (it blocks for the whole turn).
- Codex: `tools codex spawn --name bs-<N>-sol --model gpt-6.1-sol --effort medium --write ask --cwd <cwd> --session
  <bus session> --label "babysit pr<N>" --prompt-file <brief>`.

The `--label` tags every cost-ledger row of the session, so a run's spend is one query later (step 9).

No subagents inside a worker: the brief says so, and the master treats a spawned subagent as a scope breach.

How each backend commits (measured 2026-10-14 with probe workers in linked worktrees of this repo):

- Grok's jail stops its file tools outside `--cwd`, but not git's own writes: a Grok worker commits normally in a
  linked worktree. Its report includes both uncommitted changes and `commitsThisTurn`, the number of commits added
  to HEAD during the turn. Independently verify those commits with `git log` when judging the worker.
- Codex's sandbox keeps every `.git` path read-only, even one passed as `--writable-root`, so `git add` and
  `git commit` fail with `index.lock: Operation not permitted` in every mode. Under `--write ask` each one becomes an
  escalation that the approval driver (step 5) accepts when it matches the brief. The brief therefore tells a Codex
  worker to run `git add -- <paths>` and `git commit` as two separate commands, never chained with `&&`.

### The run ledger: log every prompt, turn, verdict and push

Every run keeps `<run dir>/ledger.jsonl` ([scripts/ledger.ts](scripts/ledger.ts)), one event per line, so the user can
audit afterwards what each worker was told and what it answered, not only the outcome. Append as you go, never
reconstruct at the end:

- `spawn` and `steer`: the full prompt text (`--file <brief>`), with `--worker`, `--model`, `--pr`, `--round`.
- `turn`: the worker's final message when a turn ends (`lastText` of `tools codex wait --json`, Grok's report).
- `judge`: `--meta '{"verdict":"…","evidence":"…"}'`, plus refusals you overruled and the findings you fed back.
- `correction`, `push` (`range`), `post`, `decision`, `incident`, `note`.

`bun .claude/skills/babysit/scripts/ledger.ts append --run <dir> --kind steer --pr 501 --round 2 --worker bs-gk
--model gpt-6-astra --file steer.md`; import `appendEvent` when a script of the run already does the step (the
integrate script logs `push` and `post` itself). The Markdown is built on demand, never kept by hand:
`ledger.ts render --run <dir> --out <vault run folder>/<date>-<topic>-Ledger.md` (an overview table per PR, then each
PR's events in time order, prompts and final messages folded into `<details>`). Render it into the vault with every
report.

A later round is a `steer` into the SAME worker thread: the worker keeps its context and its prompt cache. The same
PR's next round gets a delta (what the judge decided, what to fix); a new PR for an idle worker gets only the new
PR's facts (worktree, branch, round policy, thread command) plus "same rules as your first brief".

## 5. Watch while they work

Three Monitors, all with `timeout_ms: 1800000`, each re-armed as the very next tool call after its expiry notice
(agents-talk):

1. The lead's bus: `tools agents login --agent-main --agent-name lead --format monitor --hide-worker-steps
   --session <s>`. Worker mail, Codex turn and approval events.
2. The workers: `bun .claude/skills/babysit/scripts/watch-workers.ts grok:<name> codex:<name> …`. One line per turn
   start and end, tool call, question and stall (3 minutes silent while running).
3. Codex approvals: `bun .claude/skills/babysit/scripts/approve-codex.ts --run <run.json> --name <name>`. The daemon
   itself accepts read-only commands (since 886b44308); this driver approves the brief's file edits, `git add` of
   scope files, the one commit with the brief's subject, and the brief's verify commands, including their one
   sandbox escalation for loopback tests. Everything else prints `NEEDS LEAD`; decide it yourself. Deny rituals
   (`tools say`), pushes, and anything outside scope.

Two-way proof: once per new worker, send a ping on the bus (`--to grok_pr<N>` or `--to codex_<name>`) and see the
reply arrive (Sol answered in 20 s, Grok in 59 s). During the confirmation period do it for every worker.

Waiting on a Codex turn: `bun .claude/skills/babysit/scripts/wait-turn.ts --run <dir> --worker <name> --thread <id>
--pr <N> --round <R>` with Bash `run_in_background`; the harness wakes the lead when the turn ends, and the worker's
final message lands in the ledger. Never poll. Steer with `scripts/steer.ts` (same flags plus `--file`), which logs the
prompt. `bun .claude/skills/babysit/scripts/round-ready.ts --run <dir> <N>…` says which PRs the reviewer bot has
re-reviewed at their current head, so their next round can start. To be woken instead of checking, run
`bun .claude/skills/babysit/scripts/watch-reviews.ts --run <dir> <N>…` as a Monitor (`timeout_ms: 1800000`, re-arm
on expiry): it prints a PR's line only when its head, eve's review of that head or its open threads change.

## 6. Judge each worker commit (fable-judge, inline)

🛑 Invoke the `fable-judge` skill for every round, before the push, and read the worker's summary, its reply file and
the full diff together ([references/judging.md](references/judging.md) is the checklist, the rule comes first there):
`bun .claude/skills/babysit/scripts/judge-pack.ts --wt <worktree> --range origin/<branch>..HEAD --replies <reply json>
--out <file>` puts the claims, the flagged refusals and deferrals, and the diff (tests first) in one file.
Checks plus planted regressions are not a judgement; the code itself is judged. In short: the diff is the truth, not the report;
rerun every claimed check yourself; plant the old code back to prove each new test fails without the fix; check the
fix against the module's documented contracts and its callers (the #511 defect hid in a caller); check scope, one
commit, nothing staged that is not the worker's; check the ready-to-post replies against the final code. Verdict per
PR: VERIFIED, VERIFIED WITH CAVEATS, or REFUTED, with evidence.

Every deferral is judged too, by severity. A critical or high finding the worker left OPEN because its fix needs a
file outside the PR is the lead's decision in the same round, not a reply: when the finding is about the PR's own
subject (on 2026-10-14 #516's one-scan rule needed `enrich.ts`), allow the file in a steer and send it back before
the push; defer it only with the reason in the reply. A Swift change the worker could not run is not judged until the
lead ran its tests: `swift-typecheck.ts` proves it compiles, and #501 round 2 typechecked clean yet broke a test.

## 7. Correct, integrate, push

At most **one correction commit** per PR per round, for what is wrong or below the bar (a defect, a test in the wrong
place, a misleading reply). None when the judge found nothing; say so. Worktree mode, one command for the rest:
`bun .claude/skills/babysit/scripts/integrate.ts --run <dir> --pr <N> --round <R>` runs the gates, pushes the judged
SHA (never HEAD at push time: a worker steered into its next round may commit meanwhile), copies the reply file to the
vault with the judge, renders and posts the round summary once (a `.posted` marker stops a rerun from posting twice),
then posts the thread replies and resolves them, and logs `push` and `post`. Details:
[references/integrate.md](references/integrate.md):

- worktree mode: the correction goes on the worker's worktree; verify there; push `HEAD:refs/heads/<pr-branch>`;
  then cherry-pick both commits onto unified in the main checkout.
- unified mode: correction on unified; cherry-pick both onto a scratch worktree of the PR branch; resolve context
  conflicts by keeping the PR branch's side plus the worker's change; verify; push.

Gates before each push: the test files of the scope (not the PR's whole suite: a test that launches a real
browser or app, such as the chrome-devtools headless tests, makes a 1.4 GB app copy per launch, so run it only when
the fix touches that path, and report it as NOT RUN otherwise), `bunx tsgo --noEmit`, Biome on the changed files,
`bun scripts/ci/check-tool-commands.ts`, `bash scripts/ci/placeholder-check.sh`. Never push unified. One push per PR
per round (review-loop round policy).

Then the replies: copy the worker's reply JSON to the run's vault folder, replace its SHAs with the PR-branch SHAs,
add the correction to the affected items and to `alsoInPush`, set every item's `"model": "Claude Opus 5.5
(fable-judge)"`, and render `round-summary.ts --range <old head>..<new head> --cwd <pr worktree>`. Post per review-loop
step 4 only when `post` is true.

## 7b. Optional: land a PR in master (only with the user's explicit approval)

Off unless the user approves it in their own words for this run ("drive the PRs into master after 3 rounds"), and
only for PRs the run owns: never another session's PR, never the integration branch. Ask once, early, and keep
running review rounds while the question is open: a missing answer never blocks a round, it only means no merge.

A PR lands when all hold: at least 3 review rounds done; no open critical or high finding; the reviewer bot reviewed
the CURRENT head; CI green on that head; its base is master or a parent the run merges first (a PR stacked on another
session's branch waits for that branch). Then the review-loop landing recipe, which
`bun .claude/skills/babysit/scripts/land.ts --run <dir> --pr <N> --merge` runs as one command (without `--merge` it
only prepares and prints the squash; every git call is an argument array, because a hand-typed
`--force-with-lease=$B:c1a…` in zsh read `:c` as a modifier and pushed without the lease):

1. Squash the review commits (the `#<N> followup` ones on top of the feature commits) into one
   `fix(<scopes>): #<N> followup - address PR review (<k> commits)` whose body lists each squashed subject; prove the
   tree is identical (`git rev-parse HEAD^{tree}` before and after) and run `bun scripts/git/check-commits.ts
   origin/master..HEAD`.
2. Push with `--force-with-lease=<branch>:<old head>`. An identical tree on a green head needs no new CI run
   (review-loop 4e); a rebase that resolved a conflict is new code: wait for CI and the bot.
3. `git fetch origin <branch>` in the main checkout (`tools github merge` compares against the local remote ref and
   refuses a "moved" branch otherwise), then `tools github merge --rebase <N>`. Stacks merge bottom-up; the tool
   retargets dependents.
4. Log a `note` event with the merge SHA, and list every PR that did not land with its reason in the report.

A PR that conflicts with master, or whose parent was just squash-merged, is restacked first:
`bun .claude/skills/babysit/scripts/restack.ts --wt <worktree> --onto origin/master [--upstream <fork point>]`. It runs
with hooks and rerere off (a hook froze on a stuck syspolicyd; rerere hid a conflict behind an old resolution),
resolves only the plugin version files (the higher version wins), and aborts on any code conflict: that one goes to
the worker who knows the PR, as a merge-prep steer that authorizes the rebase. `--upstream` is the commit the branch
forked from on its parent (a child stacked on a parent that kept growing forked before the parent's later commits;
find it with `git merge-base <child> <old parent head>`). Check with `git range-diff`, run the area tests, give a
child that changes plugin files a version above its new base, then push with `--force-with-lease`. A restack is new
code: wait for CI and the reviewer bot before the merge.

## 7c. Disk: watch it, reclaim /tmp safely

A night of worktrees, Swift builds and test runs fills a disk. Start `bun .claude/skills/babysit/scripts/df-watch.ts
--below-gb 5` with Bash `run_in_background` at the start of a run: it exits (and wakes you) only when free space drops
below the threshold. Then, and only with the user's standing permission for /tmp cleanup:

1. `bun .claude/skills/babysit/scripts/tmp-reclaim.ts --run <dir>` (dry run): lists the candidates in /tmp, $TMPDIR and
   each `/tmp/cc/<project>/<session>` folder, writes a plan file, deletes nothing. It skips live sessions (any agent
   transcript changed in the last 12 h, the run folder, `--protect`), system and daemon entries, anything holding a
   socket, a FIFO or a `.git`, open files (it stops if lsof gives no listing), anything changed in the last 6 h,
   symlinks, other users' and other devices' entries.
2. Read the list. Then `--apply --plan <file>` within 30 minutes: only the planned entries, each re-checked (same
   inode, still old, still closed), moved into a scratch folder in the same root and deleted there. The result is a
   `note` in the run ledger.

Never delete a worktree this way (it refuses `.git` anyway): worktrees go through step 8's release. Machine caches
outside /tmp (uv, SwiftPM, a repo's `.build`) are a separate, user-approved decision, not this script's.

## 8. Clean up after every round, automatically

Do not wait to be asked. When a round's pushes and unified picks are done:

- `tools codex stop --name <name>` for each Codex worker; a Grok worker ends with its turn.
- `tools agents leave --agent-name lead --session <s> --note "done: …"`, then stop the three Monitors.
- Remove every worker and scratch worktree: `git -C <wt> status --short` must be empty and its commits must be on a
  remote branch. Never `git worktree unlock` and never `remove -f -f` (`.claude/rules/plugins.md`). First clear the
  finished workers' locks: `bun plugins/genesis-tools/hooks/worktree-lock.ts stale <repo> --clear` (only dead or
  reused-pid locks). Then remove each worktree with
  `bun plugins/genesis-tools/hooks/worktree-lock.ts release <wt> --session <this session id>`: a worktree you named
  in a command carries this session's lock, and `release` unlocks and removes it in one step (a separate unlock would
  be re-locked by the next command that names the path), never forced, and it keeps the lock when git refuses.
  List any worktree still present in the report with its lock reason.
- Scratch stays in `/tmp/cc/<project>/<session>/babysit/` (briefs, logs, run card) for the report.

## 9. Report

A vault note per run (`<vault>/<project>/<date>-Babysit-<topic>/` in the user's notes vault, the run's reply files next to it) and, when
the run card names a recipient, a bus message to it (register with `tools agents login --agent-name <me> --once
--timeout 1 --session <s>`, then `tools agents message --body-file`). Contents, in this order: PRs and commits per PR
(worker and correction, unified and PR-branch SHAs, pushed ranges), fable-judge verdicts with the evidence, harness
bugs fixed (SHA and where cherry-picked), cost (`tools ai-spend workers --label babysit --by label,backend,name`:
each worker's API-equivalent and billed cost and the Claude estimate; plus the SuperGrok percentage before and
after, and the API credits when step 3.7 read them), monitoring facts (turns, tool calls, stalls, questions,
approvals), and what to change before the next run. Label the Claude figure an estimate: the same tokens on another
tokenizer, without the cache writes Claude would also bill.

## 10. Bugs in the harness: fix them, after the user confirms

A defect in handoff-to, agents-talk, `tools codex`, `tools grok`, `tools claude worker` or `tools agents` that broke a
step, cost real time, or reported something false: describe it in one line with the proposed fix and ask the user
(AskUserQuestion) before you change anything. On yes: fix on unified with a test, then cherry-pick onto the open PR
that owns that code (on 2026-10-14 that was #509 for Codex). Do not nitpick: wording, cosmetics and one-off quirks go
into the report's "what to change" list, not into a fix.
