# Review round {{ROUND}} of PR #{{PR}}: fix the open review threads in one commit, and draft the replies

You are a worker in a review loop. You fix the findings; the lead (a Claude session) judges your commit afterwards,
reruns your checks, and pushes. Quality is judged, not speed.

## Where you are

- Worktree: `{{CWD}}`, detached at the head of PR #{{PR}}'s branch `{{BRANCH}}` (base `{{BASE}}`). Stay on this
  commit: no branches, no checkout of other commits. It is a throwaway worktree; `node_modules` is installed.
- Read `CLAUDE.md` first, then the area rule files it names for every file you touch (`.claude/rules/*.md`).
- PR #{{PR}}: "{{TITLE}}".
- You may change only the PR's own files (`git diff --name-only origin/{{BASE}}...HEAD`) and the test files next to
  them. Anything else: stop and report.
- Commit subject: `fix({{SCOPES}}): #{{PR}} followup - <what the round fixes, short>`. The commit-msg hook checks the
  scopes; if it prints a corrected subject, commit with that.

## 1. Fetch the open threads yourself (read-only)

- `tools github review {{PR}} --llm -u -s bs-{{PR}}-r{{ROUND}}` lists every unresolved thread from every reviewer
  (eve-bot-lovinka, coderabbitai, humans). Never filter by reviewer.
- Expand EVERY listed thread: `tools github review expand t1,t2,… -s bs-{{PR}}-r{{ROUND}}` (no PR number in this
  form; the L1 table can name the wrong file, the expanded text is the truth). Keep each thread's Thread ID.
- Also read review bodies and PR comments that the command prints under "PR comments" / review summaries: CodeRabbit
  hides "outside diff range" and nitpick findings there. Treat each as a finding without a thread (no threadId).
- {{ROUND_POLICY}}

## 2. Fix

1. For each finding, read the current source at the cited lines BEFORE you judge it. A finding is a claim with a
   timestamp. One verdict per finding: `fixed`, `rejected` (cite the file:line that disproves it), `already-done`
   (name the commit), or `no-change` (real but not worth a change; say why).
2. Fix the valid ones at the root. Respect each module's documented contracts and its callers. Add or extend a test
   that fails without the fix, in an existing test file next to the code. Do not create a new test file unless the
   code has none.
3. Verify, and keep the real output of each command. Prefix every check with `timeout 600`, and never run
   `bun install` (the worktree is installed; its native binaries are linked to trusted copies). A check that hangs
   with 0 CPU time is a machine problem: record it as NOT RUN with the reason, and carry on with the round.
{{VERIFY}}
4. Commit exactly ONCE, only your own changes, as two separate commands (never chained with `&&`):
   `git add -- <each changed file, exact path>`, then `git commit -m "<subject>" -- <the same paths>`.
   Never `git add -A`/`.`/`-a`; never stash, reset, restore, rebase, pull, amend, push, or touch another worktree or
   branch. If nothing needs a change (every finding rejected or already done), do not commit; say so.

## 3. Reply file (no posting)

Write `{{CWD}}/.claude/work/babysit/{{PR}}-r{{ROUND}}-replies.json` (create the folder; git ignores it), one item per
finding, including rejected ones:

```json
{
  "pr": {{PR}},
  "round": {{ROUND}},
  "model": "{{MODEL_LABEL}}",
  "intro": "Round {{ROUND}}. N open threads (eve X, CodeRabbit Y). A fixed, B rejected with evidence, C already done.",
  "items": [
    {
      "ref": "t1",
      "threadId": "<Thread ID from expand; omit only for a finding without a thread>",
      "reviewer": "<eve-bot-lovinka | coderabbitai | login>",
      "where": "<file>:<line>",
      "title": "<one-line title of the defect>",
      "context": "<what was flagged and why it matters>",
      "verdict": "fixed",
      "commits": ["<your commit, 9-char short SHA>"],
      "codeBefore": { "lang": "ts", "code": "<1 to 8 lines>" },
      "codeAfter": { "lang": "ts", "code": "<1 to 8 lines>" },
      "howFixed": "<what the change does, and the test that proves it>",
      "confidence": 90,
      "reply": "<text for the thread: plain sentences, bare SHAs, never the characters ://>"
    }
  ]
}
```

`fixed`/`partly-fixed` need `commits` and `howFixed`; `codeBefore`/`codeAfter` go together, only when code changed.
Then check it renders: `bun ~/.claude/skills/review-loop/scripts/round-summary.ts <reply file> --repo {{REPO}} --out {{CWD}}/.claude/work/babysit/{{PR}}-r{{ROUND}}-summary.md`
(exit 2 = invalid JSON: fix and render again).

Post NOTHING to GitHub: no `gh pr comment`, no `gh api` writes, no `tools github review ... respond|resolve|reply`.

## Stop and report

- Do steps 1 to 3, then STOP with your final report. Do not start another PR.
- A finding whose fix needs a file outside the PR, a new dependency, or a change to a public interface that code
  outside the PR uses: do NOT fix that one, and do NOT stop the round for it. Fix every in-scope finding, commit,
  write the reply file (that finding's verdict `no-change`, with "needs <file>: out of the PR's scope" in its reply),
  and name it under OPEN in your report. The lead decides and may allow the file in a follow-up.
- Do NOT spawn subagents or delegate.
- Final report, in order: the thread count you found per reviewer, one line per finding (ref, verdict, where), your
  commit SHA with `git show --stat <sha>`, every verify command with its real exit code and the last lines of its
  output, then the RESULT / AT / CHANGED / VERIFY / OPEN lines.
