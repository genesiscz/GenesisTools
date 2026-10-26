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

## 0a. Start of every run: the checklist

Do all of these before the first dispatch, in this order:

1. The skills of step 0 are loaded.
2. 🛑 **Disk alarm:** `bun .claude/skills/babysit/scripts/df-watch.ts --below-gb 5` with Bash `run_in_background`. It
   exits, and so wakes you, only when free space drops below 5 GB. When it fires, run step 7c's `tmp-reclaim.ts` at
   once and start the alarm again; never wait for the user (2026-10-18: the disk sat full three times while the lead
   waited for the user, although this script and Martin's standing permission existed).
3. The run card (step 1) and the mode (step 2).
4. The plan confirmation for the workers you spawn yourself (step 2).
5. The owner check of every PR (step 3.1).
6. Decisions: every ❓ DECISION of the run goes into the decision log under its chat number and into the chat, and
   gets a `decision` event in the run ledger (review-loop, "Decisions during a loop"). A later mention is a link.
   Its answer is recorded in the same turn (`question_update`, state `acknowledged`, or `superseded` with
   `supersededBy`), so the widget stops asking for it.

## 1. The run card: what to configure

Write it to `/tmp/cc/<project>/<session>/babysit/run.json` at the start; the scripts read it.

| Field | Default | Notes |
|---|---|---|
| `prs` | asked | PR numbers. Small PRs first; never a PR another session owns (step 3.1). |
| `worker` per PR | `grok` | `grok` (model `grok-4.7-build-fast`, `--auth subscription`) or `codex` (model `gpt-6.1-sol`, `--write ask`). Mix freely; one worker per PR. |
| `effort` per PR | from the work | Codex `--effort`: `low`, `medium`, `high`, `xhigh` or `max`. A fix round: `medium`, `high` for a Critical or a cross-file finding. An independent review (step 7a): no effort; `--mode review` picks high or xhigh from the diff size and gates the depth (handoff-to, "Effort is the review's depth"). |
| `mode` | from `scripts/mode.ts` | `worktree` or `unified`, step 2. |
| `maxParallel` | 3 | Workers at once. The master is the bottleneck, not the workers. |
| `post` | ask | Post the round summary and replies after the push (review-loop step 4), or hold them in the vault. |
| `report` | vault note | Optionally also a bus message: `{ "session": "grok-dev", "to": "grokbot-developer" }`. |
| `stopAfter` | the user's words | A phase or round to stop at. Stop there even if everything is green. |
| `vault` | `<run>/vault` | The notes folder of this run: reply files, summaries, the rendered ledger. Set it. |
| `judge` | `Claude` | The name the round summary credits as judge ("… from <worker> judged by <judge>"). |
| `worktrees` | `<run>/worktrees` | Parent of the per-PR worker worktrees `bs-<N>`. |

**Codex model: Sol unless a finding needs Astra.** A large PR is not a hard PR: its findings are mostly Medium and Low
fixes that Sol handles. Use `gpt-6-astra` only when the user names it for a PR, when a Sol worker missed the same
finding twice after the judge's correction, or for a finding that crosses systems (process lifecycle, concurrency,
kernel or OS APIs, a stacked chain that must stay consistent). Steering the same session keeps its model, so decide
again at each round: an Astra session that finished its hard finding hands the next round to a Sol session. On
2026-10-14 the overnight run gave Astra every large PR by size: 47 of the 62 worker rounds, and $903 of the $924
API-equivalent spend of the `bs-*` workers (an Astra worker cost $201 to $217 for about 20 turns; the Sol worker $21
for 25 turns; `tools ai-spend workers --backend codex --by model,name`).

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

🛑 **Plan confirmation for the workers you spawn yourself** (Martin, 2026-10-18; it narrows the confirmation period
that started 2026-10-14). Before you dispatch a worker that YOU decided to spawn, show the plan with
AskUserQuestion and wait: the PRs, the worker per PR, the mode with the free-disk numbers, `post`, and the stop
point. A session the user assigns to you (he names it, or another session hands it over on his word) needs no
confirmation: state the plan in one line and proceed. (2026-10-18: the lead dispatched self-spawned workers with no
confirmation.)

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
5. **Round policy**: review-loop's "Round policy" section is the source; this is its short form (Martin,
   2026-10-18). The executable rule is `scripts/policy.ts`; `fill-brief.ts` derives it from the round, GitHub's
   changed-file count and `--dedicated-review`, and both brief templates and judging use that generated policy.
   Count the fix rounds of the PR; a follow-up PR starts again at round 1.
   - Rounds 1 and 2 fix every valid finding, Medium and Low included, whatever the PR's size. No deferral, and every
     file a valid fix needs is in scope. A `no-change` or rejection needs a cited file:line that proves the finding
     wrong.
   - Round 3 and later fix every valid Critical and High, and CodeRabbit's Major (its level above Minor; there is no
     High in its scale). A Medium or Low is fixed only when it is cheap (about 20 changed lines) or the same class as
     an earlier round's fix; every other one gets a reply (valid or not, and why
     it waits) and its thread stays OPEN: resolve only a thread that was acted on. Record such a deferral with the
     reply transport's `"verdict": "belongs-elsewhere"` and explain the policy in the reply; `integrate.ts` keeps it
     in the summary but posts it in a separate `post-replies.ts --no-resolve` batch, never the batch that resolves
     threads (Martin, 2026-10-17 12:45). (2026-10-18: a lead fixed a Low in round 3 with neither reason.)
   - **A valid security finding is always fixed**, at any severity and in any round. Read the reviewer's category
     (`🔒 Security`), not only its severity.
   - **A dedicated code review the user asks for** (an independent worker review such as `review-brief.ts` on Astra
     or Sol) is fixed in full, whatever round the PR is in. Fix it yourself or steer the PR's fixing worker, then
     judge it as any round (Martin, 2026-10-17 13:05).
   - **Merge bar:** when the last round's Critical and High findings are fixed and judged, merge without waiting
     for eve to review that last fix (eve's degraded pass counts as a review). A PR over about 50 changed files
     still needs at least one CodeRabbit review, asked through review-loop's `scripts/cr-queue.ts`; a smaller PR may
     land on eve's review. Green CI, and a reply on every Critical, Major, High, Security, refused and deferred
     thread (review-loop step 5a).
6. Scope: `git fetch origin <pr branch>`, then `bun .claude/skills/babysit/scripts/pr-scope.ts <N> --compare HEAD`.
   It lists the PR's files, the test file of each one (a sibling `.test.ts`, or a neighbour test that imports it),
   and whether unified differs from the PR branch per file. That list is the starting context, not a scope limit.
   The brief allows every file a valid fix needs, including files outside the original PR diff; explain those files
   in the reply. Missing a test file in the scope
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

A Codex worker's sandbox has no network, so `tools github review` and `gh` fail inside it (2026-10-16: two round 2
fixers stopped before their first edit). Before every spawn or steer of a round, run
`bun .claude/skills/babysit/scripts/fetch-threads.ts --run <dir> --pr <N> --round <R>`: it writes the threads (listed
and expanded, with Thread IDs), the review bodies and the bot PR comments into the worktree, and the brief points there.

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
- Codex: `tools codex spawn --name bs-<N>-sol --model gpt-6.1-sol --effort <run card effort> --write ask --cwd <cwd> --session
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
   start and end, shell command, question and stall (3 minutes silent while running); file reads and greps are only
   counted at the turn end (`--tools all` prints them too).
3. Codex approvals: `bun .claude/skills/babysit/scripts/approve-codex.ts --run <run.json> --name <name>`. The daemon
   itself accepts read-only commands (since 886b44308); this driver approves the brief's file edits, `git add` of
   scope files, the one commit with the brief's subject, and the brief's verify commands, including their one
   sandbox escalation for loopback tests. Everything else prints `NEEDS LEAD`; decide it yourself. Deny rituals
   (`tools say`), pushes, and unrelated file changes. Add every file a valid fix needs to the worker's scope before
   approving it.
   - **Trust level**, read from the run card on every poll, so a switch reaches running drivers at once:
     `approve-codex.ts trust <strict|edits|routine|all> --run <run.json> [--name <worker>]`. `routine` (the default)
     also approves any command inside the worker's worktree unless it pushes, deletes, commits outside the brief,
     changes packages, reaches the network or starts an agent. `edits` lets a worker only edit and read: the driver
     refuses every other command by itself, and the lead runs the checks and commits (Martin, 2026-10-26: "they
     shouldnt run anything thats ur job during fixing"). `approve-codex.ts builds deny --run <run.json>` refuses test
     runs, builds and typechecks on every level (a full disk, a busy Mac). Rituals are refused without asking.
   - 🛑 **Watch the shared feed, never the per-worker logs:** every driver also writes its NEEDS LEAD lines to
     `<run dir>/needs-lead.log`, and repeats a request still waiting after 3 minutes as `STILL WAITING` every 10
     minutes. A Monitor on `tail -n 0 -F <run dir>/needs-lead.log` sees drivers started after it. After a session
     restart, `approve-codex.ts pending --run <run.json>` lists every waiting request. A driver runs until its
     worker's session closes. (2026-10-26: 28 workers each waited 20 to 30 minutes on one read, because the lead's
     monitor tailed only the logs that existed when it started and six drivers had stopped at a 30-minute deadline.)

Two-way proof: once per new worker, send a ping on the bus (`--to grok_pr<N>` or `--to codex_<name>`) and see the
reply arrive (Sol answered in 20 s, Grok in 59 s). Do it for every worker you spawn yourself.

Waiting on a Codex turn: `bun .claude/skills/babysit/scripts/wait-turn.ts --run <dir> --worker <name> --thread <id>
--pr <N> --round <R>` with Bash `run_in_background`; the harness wakes the lead when the turn ends, and the worker's
final message lands in the ledger. Never poll. First steer with `scripts/steer.ts` (same flags plus `--file`), which logs
the prompt and the pre-delivery answering-turn fence. A live wait needs that steer record for the worker, PR and
round; an earlier finished turn never answers it, while a new reply that finished before the wait starts still counts.
`bun .claude/skills/babysit/scripts/round-ready.ts --run <dir> <N>…` says which PRs the reviewer bot has
re-reviewed at their current head, so their next round can start; add `--wait <minutes>` under Bash `run_in_background`
to block until eve (or every bot `--bots` names) reviewed each head (exit 0) or the deadline passes (exit 3). Never
write a one-off waiter that greps its output. To be woken on every change instead, run
`bun .claude/skills/babysit/scripts/watch-reviews.ts --run <dir> <N>…` as a Monitor (`timeout_ms: 1800000`, re-arm
on expiry): it prints a PR's line only when its head, any reviewer's latest review of that head, its open threads or
the PR comments by others change. Watch every reviewer, never eve alone, and keep the PRs merged in the last 24 hours
on the list: a review can arrive after the merge (2026-10-14: #502, #503 and #505 each got findings after theirs).
🛑 An event with new open threads is work, also on a merged PR and also when it says APPROVED: read the threads
(`audit-reviews.ts <N> --bodies`) the same turn. On 2026-10-14 an event showed three new threads on merged #502 and
sat unread for 70 minutes.

🛑 Kill a process only after its working folder is proven to be one of the run's own worktrees
(`lsof -a -d cwd -p <pid>`). A name match is not proof: on 2026-10-14 the lead killed another session's pre-commit
hook, believing it was a worker's.

## 6. Judge each worker commit (fable-judge, inline)

🛑 Invoke the `fable-judge` skill for every round, before the push, and read the worker's summary, its reply file and
the full diff together ([references/judging.md](references/judging.md) is the checklist, the rule comes first there):
`bun .claude/skills/babysit/scripts/judge-pack.ts --wt <worktree> --range origin/<branch>..HEAD --replies <reply json>
--report <worker-final file> --out <file>` puts the claims, the flagged refusals and deferrals, and the diff (tests first) in one file.
Checks plus planted regressions are not a judgement; the code itself is judged. In short: the diff is the truth, not the report;
rerun every claimed check yourself; plant the old code back to prove each new test fails without the fix; check the
fix against the module's documented contracts and its callers (the #511 defect hid in a caller); check scope, one
commit, nothing staged that is not the worker's; check the ready-to-post replies against the final code. Verdict per
PR: VERIFIED, VERIFIED WITH CAVEATS, or REFUTED, with evidence.

Judge against the same derived round policy from `scripts/policy.ts` that `fill-brief.ts` put in the brief.
Every required finding is fixed in its PR before the push; a valid security finding and every valid finding in a
dedicated user review are always required. In rounds 1 and 2 that is every valid finding, and a deferral is not
accepted. Medium/Low findings deferred by the later-round policy get explained replies and remain OPEN; verify that
integrate partitions those replies into its no-resolve batch. If a required fix needs a file outside the original
diff, change it in this PR and explain it in the reply; scope never excuses a required fix. A Swift change the worker
could not run is not judged until the lead ran its tests through `swift-slot.ts`: `swift-typecheck.ts` proves it
compiles, and #501 round 2 typechecked clean yet broke a test.

🛑 **Swift and "ready".** CI runs no Swift. A PR that changes Swift is prepared for merge only after a local run of the
FULL Swift suite of every package it changes, at the PR's final head, with the result written into the PR (the
commands, the head SHA, the test count, the exit code; a round summary's "Also in this push" line or a PR comment).
Add `src/macos/GenesisTools` (`--disable-build-manifest-caching`) when GenesisKit changed. A filtered judge run is
not the suite (Martin, 2026-10-18; that night Swift PRs were called ready before their suites reran).

## 7. Correct, integrate, push

At most **one correction commit** per PR per round, for what is wrong or below the bar (a defect, a test in the wrong
place, a misleading reply). None when the judge found nothing; say so. Worktree mode, one command for the rest:
`bun .claude/skills/babysit/scripts/integrate.ts --run <dir> --pr <N> --round <R>` runs the gates, pushes the judged
SHA (never HEAD at push time: a worker steered into its next round may commit meanwhile), copies the reply file to the
vault with the judge, renders and posts the round summary once (a `.posted` marker stops a rerun from posting twice),
then posts the thread replies, resolves acted-on items, leaves policy-deferred threads OPEN, and logs `push` and `post`. Details:
[references/integrate.md](references/integrate.md):

- worktree mode: the correction goes on the worker's worktree; verify there; push `HEAD:refs/heads/<pr-branch>`;
  then cherry-pick both commits onto unified in the main checkout.
- unified mode: correction on unified; cherry-pick both onto a scratch worktree of the PR branch; resolve context
  conflicts by keeping the PR branch's side plus the worker's change; verify; push.

Every conflict, in any step, is resolved through `bun .claude/skills/babysit/scripts/conflicts.ts`: `resolve <file>
<ours|theirs|both|base> ...` (one side per block, in file order), or edit the file yourself and run `check <file> ...`,
which fails on a leftover conflict marker and on a JSON file that does not parse. Run `check` before `cherry-pick
--continue` or `rebase --continue`, and before you copy a resolved file into another checkout. Never resolve with an
inline `bun -e` script: on 2026-10-14 one returned the pick names as text, wrote the word `ours` into both plugin
manifests (d9687720a), and the genesis-tools plugin did not load in any new session for 12 hours.

Gates before each push: the test files of the scope (not the PR's whole suite: a test that launches a real
browser or app, such as the chrome-devtools headless tests, makes a 1.4 GB app copy per launch, so run it only when
the fix touches that path, and report it as NOT RUN otherwise), `bunx tsgo --noEmit`, Biome on the changed files,
`bun scripts/ci/check-tool-commands.ts`, `bash scripts/ci/placeholder-check.sh`. Never push unified. One push per PR
per round (review-loop round policy).

Then the replies: copy the worker's reply JSON to the run's vault folder, replace its SHAs with the PR-branch SHAs,
add the correction to the affected items and to `alsoInPush`, set every item's `"model": "Claude Opus 5.5
(fable-judge)"`, and render `round-summary.ts --range <old head>..<new head> --cwd <pr worktree>`. Post per review-loop
step 4 only when `post` is true.

## 7a. An independent review round (when the user asks for one)

A round counts only when it fixed or answered real findings. The round policy (step 3.5) sets no minimum number of
rounds: after two rounds with no Critical or High, switch to merge prep (review-loop "Round policy"), and land by the
merge bar. When the user asks for a dedicated review of a PR, before or after its merge, run an independent read-only
review: `bun
.claude/skills/babysit/scripts/review-brief.ts --run <dir> --pr <N> --wt <worktree> [--post-merge] [--swift]`. It
prints the brief path and then the spawn line: `tools codex spawn --mode review --base origin/<PR base>` (after a
merge `--base <merge commit>^ --paths <the PR's files>`) with the brief as `--prompt-file`, for a worker that did NOT
fix this PR (Sol; Astra only for a risky cross-system PR, by the model rule in step 1). Leave out `--effort`: the
harness picks high or xhigh from the diff size, gives the worker the manifest and the tier's contract, and gates the
depth after the turn (one steer with the unread files, then one rerun a tier higher as `bs-<N>-review-<tier>`, then
`shallow`). Read the result with `tools codex review-depth bs-<N>-review`; a `shallow` verdict is not a finished
review. Every run of the round is one command away: `tools codex reviews --pr <N>` (or `--label babysit`). Judge its
findings like a bot's. Before a merge they become the next fix round (`fill-brief --judge <review
file> --dedicated-review`); after a merge they go to a follow-up PR from master (2026-10-14: #518 carried #509's after-merge findings).
Never count a reply-only round, or a label, as a fix round: on 2026-10-14 the report said "#500 merged after 3
rounds" when GitHub showed two round summaries.

## 7b. Optional: land a PR in master (only with the user's explicit approval)

Off unless the user approves it in their own words for this run ("drive the PRs into master"), and
only for PRs the run owns: never another session's PR, never the integration branch. Ask once, early, and keep
running review rounds while the question is open: a missing answer never blocks a round, it only means no merge.

A PR lands when all hold: review-loop step 5a ("Before you call a PR ready") passes; the rounds followed the round policy
(step 3.5), which sets no minimum count; every finding required by the derived policy is fixed and judged (every valid security finding and all
dedicated-review findings included), so no critical or high finding is open; eve reviewed the head before the last
fix (the merge bar, step 3.5); a PR over about 50 files has a CodeRabbit review; the thread replies of review-loop step 5a; CI green
on the landing tree; its base is master or a parent the run merges first (a PR stacked on another session's branch
waits for that branch). Merge without waiting for eve to review the last judged fix. Policy-deferred Medium/Low
threads may remain OPEN. In an unattended land-it job a red CI, an open
Critical or High, a conflict or a failing test is the next task, never a reason to park the PR with a note (Martin,
2026-10-05: "you just resolve the issues and iterate until ur able to drive it to master"); keep the guardrails
(`tools github merge` only, no bypassed check, no paid CodeRabbit usage). Then the review-loop landing recipe (its
file-set check for a recommitted stacked branch included), which
`bun .claude/skills/babysit/scripts/land.ts --run <dir> --pr <N> --merge` runs as one command (without `--merge` it
only prepares and prints the squash; every git call is an argument array, because a hand-typed
`--force-with-lease=$B:c1a…` in zsh read `:c` as a modifier and pushed without the lease):

0. Optional, only when asked for a PR: a commit limit (for example "10 commits max" for a handed-over PR). It is not
   a rule for every PR. Regroup a longer history into thematic commits with exactly the same final tree
   (`git diff <old head> <new head>` prints nothing), reset to the PR's fork point (`git merge-base HEAD origin/master`),
   never to a moved `origin/master`; then `land.ts … --max-commits <n> --head <regrouped sha>` refuses more than
   asked. Contiguous segments regroup without a conflict through `git commit-tree "<segment end>^{tree}" -p <prev>`;
   `--head` refuses a regroup whose tree differs from the PR head's. Add `--squash` when the user asked to squash-merge.
1. Squash the review commits (the `#<N> followup` ones on top of the feature commits) into one
   `fix(<scopes>): #<N> followup - address PR review (<k> commits)` whose body lists each squashed subject; prove the
   tree is identical (`git rev-parse HEAD^{tree}` before and after) and run `bun scripts/git/check-commits.ts
   origin/master..HEAD`.
2. Push with `--force-with-lease=<branch>:<old head>`. An identical tree on a green head needs no new CI run
   (review-loop 4e); a rebase that resolved a conflict is new code: rerun CI and judge it. Do not wait for eve to
   review the last judged fix; the CodeRabbit-review and per-thread-reply requirements still hold.
3. `git fetch origin <branch>` in the main checkout (`tools github merge` compares against the local remote ref and
   refuses a "moved" branch otherwise), then `tools github merge --rebase <N>`. Stacks merge bottom-up; the tool
   retargets dependents.
4. Check `gh pr view <N> --json state`: a restacked merge can leave the PR OPEN (#501, 2026-10-15). Log a `note`
   event with the merge SHA, and list every PR that did not land with its reason in the report.

A PR that conflicts with master, or whose parent was just squash-merged, is restacked first:
`bun .claude/skills/babysit/scripts/restack.ts --wt <worktree> --onto origin/master [--upstream <fork point>]`. It runs
with hooks and rerere off (a hook froze on a stuck syspolicyd; rerere hid a conflict behind an old resolution),
resolves only the plugin version files (the higher version wins), and aborts on any code conflict: that one goes to
the worker who knows the PR, as a merge-prep steer that authorizes the rebase. `--upstream` is the commit the branch
forked from on its parent (a child stacked on a parent that kept growing forked before the parent's later commits;
find it with `git merge-base <child> <old parent head>`). Check with `git range-diff`, run the area tests, give a
child that changes plugin files a version above its new base, then push with `--force-with-lease`. A restack is new
code: rerun CI and judge it before the merge; eve need not re-review the last judged fix. A PR over about 50
files keeps its CodeRabbit review, and the thread replies of review-loop step 5a still hold. When the restack carries a fix round too, push it with
`integrate.ts … --restacked-from <old head>`: the lease is that old head, and the gates check only the PR's own commits.

## 7c. Disk: watch it, reclaim /tmp yourself

A night of worktrees, Swift builds and test runs fills a disk. `df-watch.ts --below-gb 5` runs from the start of
every run (step 0a.2). When it fires, or whenever free disk is low, reclaim at once with the steps below. Do not wait
for the user and do not ask: Martin gave the standing permission on 2026-10-18 (an agent may reclaim its own
session scratch and its own build output, and `tmp-reclaim.ts` is the sanctioned way to delete in /tmp, not `rm`).
On 2026-10-18 the disk sat full three times while the lead waited for him, and the lead's own session folder held
14 GB, most of it SwiftPM scratch builds.

1. `bun .claude/skills/babysit/scripts/tmp-reclaim.ts --run <dir>` (dry run): lists the candidates in /tmp, $TMPDIR and
   each `/tmp/cc/<project>/<session>` folder, writes a plan file, deletes nothing. It skips live sessions (any agent
   transcript changed in the last 12 h, the run folder, `--protect`), system and daemon entries, anything holding a
   socket, a FIFO or a `.git`, open files (it stops if lsof gives no listing), anything changed in the last 6 h,
   symlinks, other users' and other devices' entries.
2. Read the list. Then `--apply --plan <file>` within 30 minutes: only the planned entries, each re-checked (same
   inode, still old, still closed), moved into a scratch folder in the same root and deleted there. The result is a
   `note` in the run ledger.

Limits you must know:

- The plain dry run never picks a LIVE session's folder, and that includes your own. For your own session run a
  second dry run with `--own-session <your session uuid>` (then `--apply --plan <file>` as above): it lists BUILD
  OUTPUT only inside `/tmp/cc/<project>/<that session>/`, even though the session is live. That is SwiftPM triple
  folders (`arm64-apple-macosx`, `x86_64-apple-macosx`), SwiftPM scratch folders that hold only SwiftPM's own
  entries, and Swift or clang module caches (only `.pcm`, `.swiftmodule` and their stamp files). It never lists
  notes, logs, reply files, patches, briefs, `node_modules` or `removals/`, and it keeps the other guards (no open
  file, socket, FIFO or `.git` inside; not changed in the last `--min-age-minutes`, default 10; the same inode and
  the same build-output class again at apply). Measured 2026-10-18 on this run's lead session: 38 candidates,
  10.55 GB. Worker and scratch worktrees still go through step 8's release, and review clones through review-loop's
  `scripts/cleanup.ts`.
- Never delete a worktree this way (it refuses `.git` anyway): worktrees go through step 8's release.
- Machine caches outside /tmp (uv, SwiftPM, a repo's `.build`) are a separate, user-approved decision, not this
  script's.
- 🛑 Never copy a SwiftPM `.build/` folder for a bench or an A/B: build and measure in the checkout's real `.build`,
  and for a before and after use two worktrees that already exist (Martin, 2026-10-07; four copies cost 3.5 GB on a
  full disk, 2026-10-06, when the session folder had grown to 3.8 GB).
- Check `du -sh /tmp/cc/<project>/<session>` before the final report.

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

Before every round report and before the final one, run `bun .claude/skills/babysit/scripts/audit-reviews.ts --run
<dir> <every open PR and every PR merged in the last 24 hours>`. It lists every reviewer (bots and people), every
open, unanswered or silently resolved thread, PR comments, findings kept in a review body ("outside diff range"), and
everything that arrived after a merge; it exits 1 while any of those needs work. A merged PR's late finding becomes a
follow-up commit on a branch from master, with a reply on the thread naming it. Never write "every thread answered" or
"clean at merge" without a fresh exit 0, or a list of what is still open.

Thread replies follow review-loop's "Thread replies by severity" (Martin, 2026-10-18): every Critical, Major, High
and Security thread gets our reply on the thread, from any reviewer, CodeRabbit included (every reply item carries
the required `severity`, and post-replies posts the CodeRabbit ones of those severities); so does every refusal and
deferral. A fixed Medium or Low CodeRabbit
thread that WE resolved without a reply is not a gap and needs no backfill: post-replies resolves it silently on
purpose, because a thread reply spends CodeRabbit's hourly chat budget, and the round summary comment carries the
answer. The audit counts those apart ("resolved by us with the answer in the round summary"). Answer by hand only a
thread the reviewer resolved itself with no answer anywhere (2026-10-14: five #515 threads were answered by hand for
nothing). (2026-10-18: Critical and High CodeRabbit threads were resolved with no reply.)

Before the word "ready" goes into any report, run review-loop step 5a ("Before you call a PR ready") for each PR.

## 10. Bugs in the harness: fix them, after the user confirms

A defect in handoff-to, agents-talk, `tools codex`, `tools grok`, `tools claude worker` or `tools agents` that broke a
step, cost real time, or reported something false: describe it in one line with the proposed fix and ask the user
(AskUserQuestion, and post it to the decision log under its chat number, step 0a.6) before you change anything. On yes: fix on unified with a test, then cherry-pick onto the open PR
that owns that code (on 2026-10-14 that was #509 for Codex). Do not nitpick: wording, cosmetics and one-off quirks go
into the report's "what to change" list, not into a fix.
