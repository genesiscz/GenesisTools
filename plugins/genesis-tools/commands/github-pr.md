---
name: genesis-tools:github-pr
description: Fetch PR review comments, select which to fix, implement fixes, and commit
argument-hint: "<pr-number-or-url> [-u] [--open] [--open-only]"
---

# GitHub PR Review Fixer

Fetch PR review comments, let user select which to fix, implement fixes, and commit.

## Usage

```
/github-pr <pr-number-or-url>              # All threads
/github-pr <pr-number-or-url> -u           # Only unresolved threads
/github-pr <pr-number-or-url> --open       # Cat + open in Cursor
/github-pr <pr-number-or-url> --open-only  # Open in Cursor only, wait for input
```

> **Underlying CLI:** This command uses `tools github review` under the hood. See the `genesis-tools:github` skill for full CLI reference and options.

## Input: $ARGUMENTS

Parse arguments:
- First arg: PR number or full GitHub URL (required)
- `-u` flag: Only show unresolved threads
- `--open` flag: After catting, also open the review file in Cursor
- `--open-only` flag: Skip cat, open in Cursor, then stop and wait for user input

## Process

### Step 1: Fetch PR Review Comments

Run the github review command with markdown output:

```bash
tools github review <pr-number-or-url> -g --md [-u if flag present]
```

The script outputs the file path to stdout (e.g., `.claude/github/reviews/pr-137-2026-01-03T13-44-20.md`).

### Step 2: Read and Display Review

**If `--open-only` flag is present:**
1. Open the review file in Cursor:
   ```bash
   cursor <generated-file-path>
   ```
2. Stop and wait for user input on what to do next (do not proceed to Step 3)

**Otherwise:**

Use `cat` to read the generated markdown file completely:

```bash
cat <generated-file-path>
```

**If `--open` flag is present:**
Also open the review file in Cursor:
```bash
cursor <generated-file-path>
```

Present a summary to the user:

- PR title and state
- Total threads count
- Breakdown by severity (HIGH/MEDIUM/LOW)
- Breakdown by status (resolved/unresolved)

### Step 3: Ask User Which Comments to Fix

Use AskUserQuestion tool to let user select which review threads to address:

**Question Format:**
```
Which review threads should I fix?

Options:
1. Fix all unresolved threads (X threads)
2. Fix only HIGH priority threads (Y threads)
3. Fix HIGH + MEDIUM priority threads (Z threads)
4. Let me specify thread numbers
```

If user chooses "specify thread numbers", ask for comma-separated thread numbers (e.g., "1, 3, 5, 7").

### Step 3.5: Critically Evaluate Each Thread Before Fixing

**Do not blindly implement every review comment.** Reviewers make mistakes. Before touching any code, evaluate each thread:

1. **Read the actual code** at the referenced file and line — don't rely solely on the reviewer's description
2. **Verify the claim** — is the reviewer correct? Does the bug/issue actually exist?
3. **Check for false positives** — common reviewer mistakes include:
   - Flagging patterns that are correct for the runtime (e.g., Bun vs. Node.js APIs)
   - Misreading control flow or missing existing guards (e.g., claiming `clearTimeout` is missing when it's present)
   - Suggesting `JSON.stringify` replacer doesn't recurse (it does, by spec)
   - Flagging intentional design choices (local CLI security model, YAGNI, by-design behavior)
   - Missing framework/library guarantees that make the concern moot
4. **Categorize each thread** before doing anything:
   - `VALID` — reviewer is correct, fix needed
   - `FALSE_POSITIVE` — reviewer is wrong; push back with a clear technical explanation
   - `BY_DESIGN` — intentional choice; decline with rationale
   - `ALREADY_FIXED` — addressed in a prior commit

**When you're unsure about a thread** — use `AskUserQuestion` to ask the user rather than guessing. For example:
- "Thread #5 claims X — I see the guard on line 42 which looks like it addresses this. Is this intentional or should I still fix it?"
- "Thread #12 suggests using vm2 for sandboxing — this is a local CLI where the user writes their own presets. Should I decline this or implement it?"

**Never assume intent.** If a thread is ambiguous (e.g., the reviewer's suggested fix would change behavior in a way that might or might not be desired), stop and ask before implementing.

### Step 4: Implement Fixes

For each thread marked `VALID`:

1. Read the file mentioned in the thread
2. Understand the issue from the review comment
3. Apply the fix according to:
   - Suggested code (if provided in the review)
   - Issue description (if no suggestion)
4. Follow project coding patterns

**Important:**
- Fix threads one by one, validating each fix works
- If a fix is unclear, use `AskUserQuestion` — do not assume
- Run linting/type checking on modified files if applicable

### Step 5: Commit Changes

After all fixes are applied:

1. Check git status for changes
2. Check recent commit messages for style:
   ```bash
   git log --oneline -10
   ```
3. Create commit with message matching project style:
   - Common patterns: `fix(scope): description`, `feat(scope): description`
   - Reference the PR in the message

Example commit:
```bash
git commit -m "$(cat <<'EOF'
fix(scope): address code review issues

Fixes review comments from PR #137:
- Fixed issue X
- Added proper type annotations
- Improved error handling
EOF
)"
```

### Step 6: Reply to Threads

After committing, reply to each thread on GitHub explaining what happened.

**IMPORTANT: Delegate to a background agent.** Thread replies are many independent shell commands that don't need the main agent's context. Spawn a **haiku** Task agent (subagent_type: `Bash`) to run all the reply commands. This saves significant time and tokens.

#### Preparing the reply commands

**Commit links:** Always include a clickable link to the commit. Build the URL as:
`https://github.com/<owner>/<repo>/commit/<full-sha>`

Use markdown link format in the reply: `[short-sha](full-url)`.

**Author tagging:** When replying, tag the review author in the response:
- For `@coderabbitai` threads: prefix reply with `@coderabbitai`
- For `@gemini-code-assist` threads: prefix reply with `/gemini`
- For other bot reviewers: tag them with `@<username>`

**For fixed threads** — explain what was fixed, how, and link the commit:
```bash
tools github review <pr> --respond "@coderabbitai Fixed in [abc1234](https://github.com/owner/repo/commit/abc1234def5678) — scoped stale cleanup to current project directory." -t <thread-id>
```

**For skipped threads** — provide a detailed technical explanation of why:
```bash
tools github review <pr> --respond "/gemini Won't fix — the projectNameCache already prevents repeated filesystem resolution." -t <thread-id>
```

**Batch operations:** When multiple threads have the same fix/response, use comma-separated IDs:
```bash
tools github review <pr> --respond "Fixed in [abc1234](https://github.com/owner/repo/commit/abc1234def5678) — addressed review feedback." -t <thread-id1>,<thread-id2>,<thread-id3>
```

#### Dispatching to a background agent

Build the full list of `tools github review <pr> --respond "..." -t <id>` commands, then spawn a **haiku** agent with `run_in_background: true`:

```
Task tool call:
  subagent_type: "Bash"
  model: "haiku"
  run_in_background: true
  prompt: |
    Run each of these commands. Report only errors — if a command succeeds, just note the thread ID.
    If a command fails, include the full error output.

    1. tools github review <pr> --respond "..." -t <id1>
    2. tools github review <pr> --respond "..." -t <id2>,<id3>
    ...
```

The main agent should **not wait** for the reply agent — continue to Step 7 immediately.

**Important:** Do NOT use `--resolve-thread` unless the user explicitly asks to resolve threads. Only reply.

**When the user asks to resolve threads**, add `--resolve-thread` to the reply commands:
```bash
tools github review <pr> --respond "Fixed in abc1234" --resolve-thread -t <thread-id1>,<thread-id2>
```

**Permission note:** `--resolve-thread` uses `resolveReviewThread` GraphQL mutation. Fine-grained PATs may fail with "Resource not accessible by personal access token" even with `pull_requests:write` set, because GitHub does not support this mutation for fine-grained PATs. The tool now automatically falls back to the `gh` CLI token (classic OAuth with `repo` scope) which always has the needed permission. No manual action required.

### Step 7: Report Summary

Display final summary:
- Number of threads fixed
- Number of threads skipped (with reasons)
- Files modified
- Commit hash
- Whether thread resolution succeeded or failed (permission issue)

## Example Flow

```
User: /github-pr 137 -u

1. Run: tools github review 137 -g --md -u
2. cat .claude/github/reviews/pr-137-2026-01-03T13-44-20.md
3. Display: "PR #137 has 14 unresolved threads (0 HIGH, 14 MEDIUM, 0 LOW)"
4. Ask: "Which threads to fix?"
5. User selects: "Fix all unresolved"
6. Fix each thread, run linting
7. Commit: "fix(scope): address code review issues..."
8. Report: "Fixed 14 threads, modified 5 files, commit abc1234"
```

---

## Multi-PR Analysis Workflow

When the user provides **multiple PR URLs/numbers**, switch to analysis-first mode: spawn parallel agents to evaluate each PR's review comments, write structured plans, and present a consolidated report before touching any code.

### When to use this mode

- User provides 2+ PR URLs in the same message
- User says "analyze these PRs", "review all of these", "write plans for..."
- User explicitly asks for a report before implementing

### Step 1: Setup

```bash
mkdir -p .claude/plans/reviews
```

Get the current datetime for filenames:
```bash
date -u +"%Y-%m-%dT%H-%M-%S"   # e.g. 2026-02-18T23-18-22
```

Plan files go to: `.claude/plans/reviews/PR-<id>-<datetime>.md`

### Step 2: Fetch All PR Reviews in Parallel

Run simultaneously for all PRs:

```bash
tools github review <pr-url> -g --md        # all threads (default)
tools github review <pr-url> -g --md -u     # unresolved only (if requested)
```

**Special case — if user says "resolve threads where `<author>` replied first":**
1. Fetch all threads (without `-u`) to find threads where that author has a reply
2. Batch-resolve: `tools github review <pr> --resolve-thread -t id1,id2,...`
   - Note: `--resolve-thread` automatically falls back to `gh` CLI token if the primary token lacks permission — no manual action needed
3. Re-fetch with `-u` to get the remaining unresolved threads for analysis

### Step 3: Dispatch One Agent Per PR (in parallel)

Use the `superpowers:dispatching-parallel-agents` skill to structure parallel dispatch. Each agent:

1. **Must invoke** `superpowers:receiving-code-review` skill to guide evaluation
2. **Must invoke** `superpowers:writing-plans` skill to structure the output plan
3. Reads the generated review markdown file
4. Reads the actual source files referenced in each thread (using Glob/Grep/Read)
5. For each thread, assigns a verdict:
   - `VALID_FIX_NEEDED` — real issue, needs a fix
   - `FALSE_POSITIVE` — reviewer is wrong or lacks context
   - `BY_DESIGN` — intentional, no fix needed
   - `ALREADY_FIXED` — addressed in a prior commit
6. Writes plan to `.claude/plans/reviews/PR-<id>-<datetime>.md`

**Agent prompt template:**

```
You are analyzing PR #<id> review comments for the <repo> repository.

1. Invoke the `superpowers:receiving-code-review` skill to guide your evaluation
2. Read the PR review file: `<path-to-review-md>`
3. For each thread, READ THE ACTUAL SOURCE FILES at the referenced location before
   forming any opinion. Then assign a verdict:
   - VALID_FIX_NEEDED — reviewer is correct, a real fix is needed
   - FALSE_POSITIVE — reviewer is wrong (misread the code, wrong about the API,
     doesn't understand the runtime, etc.) — push back with evidence
   - BY_DESIGN — intentional choice; decline with rationale
   - ALREADY_FIXED — addressed in a prior commit
4. Invoke the `superpowers:writing-plans` skill to structure the output
5. Write a plan to `.claude/plans/reviews/PR-<id>-<datetime>.md`

CRITICAL EVALUATION RULES:
- Do NOT blindly accept reviewer claims. Reviewers make mistakes. Verify by
  reading the actual code at the referenced line.
- Common false positives to watch for:
  - Claiming a guard/check is missing when it exists
  - Misunderstanding Bun vs. Node.js APIs
  - Flagging intentional security model for local CLI tools
  - Suggesting JSON.stringify replacer "only hits top-level" (it recurses)
  - Flagging YAGNI concerns for features that are out of scope
  - Misreading control flow or variable scope
- If you are UNSURE about a thread's verdict (the code is ambiguous or the
  design intent is unclear), flag it as NEEDS_CLARIFICATION in the plan and
  note exactly what question needs answering — do not guess.

CONSTRAINTS:
- DO NOT modify any source files
- DO NOT switch branches or run git operations (use `git show <branch>:<file>`
  or `gh api` to read code on other branches without checking out)
- DO NOT commit anything
- Plans are for LATER execution, not now

Plan must include:
- PR title and branch
- Per-thread: Thread ID, file/line, concern, verdict, justification (with code evidence)
- If VALID_FIX_NEEDED: exact file, what to change, how (code snippet if applicable)
- If FALSE_POSITIVE/BY_DESIGN: the technical reply text to post on GitHub
- Summary verdict table
- Prioritized fix list (HIGH → MED → LOW)
- GitHub reply text for every thread (fixed, won't fix, already fixed, needs clarification)
```

**Important constraints for agents:**
- Agents must NOT switch branches — read code as-is on the current branch
- If a PR's files are on a different branch, use `gh api` or `git show <branch>:<file>` to read them without checking out
- Plans stay in this repo's `.claude/plans/reviews/` regardless of which branch holds the PR code

### Step 4: Collect Results and Present Report

After all agents complete, read each plan file and compile a consolidated report using this template:

---

### Report Template

```markdown
## PR Review Analysis Report — <date>

> Plans saved to `.claude/plans/reviews/`
> [Any warnings: resolve failures, branch issues, description updates, etc.]

---

## PR #<id> — `<title>`
**Branch:** `<branch>` | **Threads analyzed:** <N>

| Verdict | Count |
|---------|-------|
| VALID_FIX_NEEDED | X |
| FALSE_POSITIVE | X |
| BY_DESIGN | X |
| ALREADY_FIXED | X |

### Fixes Required:

| Priority | Thread | File | Issue |
|----------|--------|------|-------|
| 🔴 HIGH | #N | `file:line` | One-line description of bug/issue. Fix: brief description |
| 🟡 MED  | #N | `file:line` | ... |
| 🟢 LOW  | #N | `file:line` | ... |

---

## Grand Summary

| PR | Branch | Valid Fixes | Total Threads |
|----|--------|-------------|---------------|
| #id | `branch` | N | N |
```

---

### Step 5: Ask What to Do Next

After presenting the report, ask:

```
What would you like to do?

1. Implement all PRs in parallel (separate worktrees per PR)
2. Implement one PR at a time (you choose order)
3. Just post replies now, implement later
4. Skip to replying on a specific PR
```

If implementing: use `superpowers:using-git-worktrees` skill when PRs are on different branches.
If replying: use the reply text prepared in each plan (see Step 6 of the single-PR flow above).

---

## Example Flow (Multi-PR)

```
User: analyze these PRs and write plans:
  - https://github.com/org/repo/pull/29
  - https://github.com/org/repo/pull/33
  - https://github.com/org/repo/pull/31 (resolve threads where I replied first)

1. mkdir -p .claude/plans/reviews
2. Fetch all 3 PR reviews in parallel
3. PR #31: resolve author-replied threads, re-fetch -u
4. Spawn 3 parallel agents (one per PR)
5. Agents write plans to .claude/plans/reviews/PR-{29,33,31}-2026-02-18T23-18-22.md
6. Compile and present consolidated report
7. Ask user what to do next
```

## Key Rules

1. **Always cat the full markdown file** — don't truncate
2. **Ask before fixing** — let user choose what to fix
3. **Follow commit message style** — match existing repo patterns
4. **Run linting** — validate fixes don't break types
5. **One commit** — group all PR review fixes into a single commit
6. **Reference PR** — include PR number in commit message
7. **Push back on wrong reviews** — read the actual code before accepting a reviewer's claim. If the issue doesn't exist, the fix is already present, or the concern contradicts the design, say so clearly in your reply with a technical explanation. Don't implement fixes that aren't needed.
8. **Ask, don't assume** — whenever a thread is ambiguous, its intent is unclear, or implementing it could have unintended consequences, use `AskUserQuestion` to clarify with the user before proceeding. Assumptions that turn out wrong waste more time than asking.
