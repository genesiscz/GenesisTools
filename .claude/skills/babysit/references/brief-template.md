# Worker brief template

Fill every `{{…}}`, delete the variant you do not use, and check that no `{{` is left
(`rg -n '\{\{' <brief>`). Write the brief to `/tmp/cc/<project>/<session>/babysit/brief-<N>.md` and pass it with
`--prompt-file`. The harness injects the generic worker contract (Stop-and-report, RESULT/AT/CHANGED/VERIFY/OPEN, no
rituals) itself; do not repeat it.

````markdown
# Fix the review findings of PR #{{PR}}, in one commit, and draft the round summary

You are a worker in a review loop: you fix the findings, and the lead (a Claude session) judges your work
afterwards. Work carefully; quality is judged, not speed.

## Where you are

- Repository: `{{CWD}}`.
  - worktree mode: a worktree of the PR branch `{{BRANCH}}`, detached at its head. Stay on that commit; do not
    create branches.
  - unified mode: the main checkout on `feat/<date>-enhancements-unified`. Other sessions edit and commit here at the
    same time: files you did not change are theirs. {{LATER_CHANGES_NOTE}}
- Read `CLAUDE.md` first, then the area rules it names for the files you touch.
- PR #{{PR}}, "{{TITLE}}", `{{BRANCH}}` into `{{BASE}}`. You may change ONLY these files:
{{SCOPE}}
- Commit subject: `{{SUBJECT}}`

## Verify

{{VERIFY}}

## Talk to the lead while you work (the agents bus)

Grok variant:
- Your FIRST action: start the `monitor` tool with `persistent: true` on exactly this command, and keep working after
  its `ready` line:
  `tools agents login --agent-name {{BUS_NAME}} --format json --kinds message --session {{BUS_SESSION}}`
- Every line that monitor prints is mail from the lead. Act on it, then answer with:
  `tools agents message --from {{BUS_NAME}} --reply <message_id> --body '<answer>' --session {{BUS_SESSION}}`
- Send at most ONE bus message per turn; a second send in one turn has been cancelled by the harness before. Never
  report a send as done unless the command printed its success line.
- Just before your final report, stop that monitor with `kill_command_or_subagent`.

Codex variant:
- You are on the bus as `codex_{{NAME}}`; the lead is `lead`. Mail from the lead reaches you as turn input. Answer
  each one with the `--reply` command its header gives you, then carry on. Do not run a receive command yourself.

## The findings ({{REVIEWER}}, PR #{{PR}}; expanded text)

{{FINDINGS}}

## What to do

1. For each finding, read the current source at the cited lines BEFORE you judge it. A finding is a claim with a
   timestamp, not a fact. One verdict per finding: `fixed`, `rejected` (cite the file:line that disproves it),
   `already-done`, or `no-change` (real, but not worth a change; say why).
2. Fix the valid ones at the root, and respect the module's documented contracts (what a function promises to throw
   or return) and its callers. Add or extend a test that fails without the fix, in the test files listed above. Do
   NOT create a new test file.
3. Verify with the commands above and keep their real output.
4. Commit exactly ONCE, with only your own changes, as two separate commands (do not chain them with `&&`):
   `git add -- <each file you changed, by exact path>`, then
   `git commit -m "<the subject above>" -- <the same paths>`. The paths after `--` make the commit take only your
   files even when another session has staged something in the same index. If the commit-msg hook prints a
   corrected subject, commit with that. Never `git add -A`, `.` or `-a`; never stash, reset, checkout, restore,
   switch, rebase, pull, push or amend. If the commit fails because `index.lock` already exists (another session is
   committing), wait 5 seconds and try once more; if it fails with `Operation not permitted`, stop and report it.
5. Write this round's reply file `.claude/work/babysit/{{PR}}-r{{ROUND}}-replies.json` (create the folder; it is
   ignored by git), one item per finding:

   ```json
   {
     "pr": {{PR}},
     "round": {{ROUND}},
     "model": "{{MODEL_LABEL}}",
     "intro": "Round {{ROUND}}. {{REVIEWER}} reviewed with N threads. X were valid and are fixed; Y are rejected with evidence.",
     "items": [
       {
         "ref": "t1",
         "threadId": "<Thread ID from the finding>",
         "reviewer": "{{REVIEWER}}",
         "where": "<file>:<line>",
         "title": "<one-line title of the defect>",
         "context": "<what was flagged and why it matters>",
         "verdict": "fixed",
         "commits": ["<your commit, 9-char short SHA>"],
         "codeBefore": { "lang": "ts", "code": "<1 to 8 lines before>" },
         "codeAfter": { "lang": "ts", "code": "<1 to 8 lines after>" },
         "howFixed": "<what the change does>",
         "confidence": 90,
         "reply": "<text to post on the thread: bare SHAs, never the characters ://>"
       }
     ]
   }
   ```

   `fixed` and `partly-fixed` need `commits` and `howFixed`; `codeBefore`/`codeAfter` go together, at most 8 lines
   each, only when code changed; `confidence` is how sure you are the fix (or rejection) is right.
6. Render the summary: `bun ~/.claude/skills/review-loop/scripts/round-summary.ts <the reply file> --range <sha>~1..<sha>
   --repo {{REPO}} --out .claude/work/babysit/{{PR}}-r{{ROUND}}-summary.md`. Exit 2 means the JSON is invalid: fix it
   and render again.
7. Post NOTHING to GitHub: no `gh pr comment`, no `gh api` writes, no `tools github review respond`/`resolve`.

## Stop and report

- This turn: steps 1 to 6, then STOP with your final report.
- STOP early and report if a fix needs a file outside the list, a new file other than the reply file and summary, a
  new dependency, or a change to a public interface other code uses.
- Do NOT spawn subagents or delegate to another agent.
- Final report, in this order: the rendered summary, each thread's ready-to-post reply (ref, then text), your commit
  SHA with `git show --stat <sha>`, every verify command with its real output, then the RESULT / AT / CHANGED /
  VERIFY / OPEN lines.
````

`{{LATER_CHANGES_NOTE}}` (unified mode only, from `pr-scope.ts`): name the files that differ between unified and the
PR branch, say what the later changes are, and tell the worker to keep its diff tight to the finding's lines and to
use only functions the PR branch has (Sol checked the PR branch itself on 2026-10-14 and avoided a later PR's
function; say it so every worker does).
