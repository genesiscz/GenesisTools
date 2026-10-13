# What the first run showed (2026-10-14, Phase 1 and 2)

Full report: the vault note `GenesisBrain/GenesisTools/2026-10-14-ReviewLoopWorkersExperiment/`. The facts this
skill is built on:

| | Grok 4.7 Fast on #512 | Sol 6.1 on #511 |
|---|---|---|
| Findings | 2 (a regex, a Swift scroll chase) | 4 (a window failure, an empty-placement fallback x2, a README) |
| Time | 10 min 37 s, 82 tool calls | 9 min 13 s, 3.01 M tokens (2.86 M cached), 12 k output |
| Cost | $2.44 API-equivalent, billed to SuperGrok (weekly 3% to 4%; API credits unchanged at $8.55) | ChatGPT subscription |
| Verdict | VERIFIED WITH CAVEATS: both fixes right, both new tests fail on the old code; tests in the wrong file (brief's fault) | VERIFIED WITH CAVEATS: three fixes right; one broke the module's error contract, so the CLI would have printed a stack trace |
| Bus round trip | 59 s (Grok's `monitor` tool) | 20 s (daemon delivers mail as turn input) |
| Cherry-pick onto the PR branch | clean (files identical on unified and the PR) | one import-line conflict (unified held a later PR's imports) |

Master time for both PRs: about 35 minutes of judging, corrections, picks, gates and pushes. The workers were not the
bottleneck.

## Defects the run found in the harness, and their fixes

- Codex `--write ask` sent every `cat` and `sed -n` to the lead (40 approval requests in 9 minutes): Codex's
  read-only set does not parse a `zsh -lc` script. Fixed in 886b44308 and 82b57885d: the daemon accepts plainly
  read-only commands itself (21 of Sol's 21 reads).
- A Codex file-change approval named only an item id. Fixed in 886b44308: it names the files.
- `tools codex tail --tail 0` printed every event (`slice(-0)`). Fixed in fcb1fdacf.
- `tools codex tail --format …` ignores `--tail` and stops at the end of a turn: the watcher uses `--events`.
- review-loop's `post-replies.ts` answered by session ref, which is renumbered between sessions. Fixed in
  GenesisClaude 68bb044: it answers and resolves by `threadId`.

## Worker behaviour worth knowing

- Sol checked the PR branch before committing and replaced a later PR's function with the PR's own code: tell every
  worker to do that in unified mode.
- Sol needed two sandbox escalations to run fake-server tests (loopback listen is blocked) and tried `tools say`
  at the end despite the contract; the approval gate stopped it.
- Grok followed scope and the one-send-per-turn bus rule exactly, read the commit-scope rules itself, and used the
  hook's corrected subject. It ended its bus login by killing its monitor (`agent_left` reason `signal`).
- Neither worker asked a question or stalled for 3 minutes.
## Probes after the first run (2026-10-14 01:55)

- A Grok worker in a linked worktree of this repo committed normally (9df1fcb36): its jail does not cover git's own
  writes to the main `.git`. Its turn report still said "turn 1 changed NOTHING", because that check counts only
  uncommitted files.
- Two Codex workers (`--write allow`) failed the same commit with `fatal: Unable to create
  '.../.git/worktrees/<name>/index.lock': Operation not permitted`, one of them with `--writable-root <main>/.git`.
  The Codex sandbox keeps `.git` read-only even inside a writable root. Under `--write ask` the commit escalates to
  the lead and runs outside the sandbox once approved (that is how Sol committed on #511).
- Four plan-only test runs of this skill (two with it, two without) found: the shared index can carry another
  session's staged files into a bare `git commit` (the brief now commits with `-- <paths>`); #513 is stacked on #504;
  #498's worktree was locked by another live session; `pr-scope.ts` printed "same" for a ref it could not resolve and
  missed a neighbour test file.
