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

### Step 4: Implement Fixes

For each selected thread:

1. Read the file mentioned in the thread
2. Understand the issue from the review comment
3. Apply the fix according to:
   - Suggested code (if provided in the review)
   - Issue description (if no suggestion)
4. Follow project coding patterns

**Important:**
- Fix threads one by one, validating each fix works
- If a fix is unclear, ask the user for clarification
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

**Commit links:** Always include a clickable link to the commit. Build the URL as:
`https://github.com/<owner>/<repo>/commit/<full-sha>`

Use markdown link format in the reply: `[short-sha](full-url)`.

**For fixed threads** — explain what was fixed, how, and link the commit:
```bash
tools github review <pr> --respond "Fixed in [abc1234](https://github.com/owner/repo/commit/abc1234def5678) — scoped stale cleanup to current project directory to avoid deleting other projects' cache entries." -t <thread-id>
```

**For skipped threads** — provide a detailed technical explanation of why:
```bash
tools github review <pr> --respond "Won't fix — the projectNameCache already prevents repeated filesystem resolution. The initial resolution is O(n) where n is path depth (~4-6 segments), and each existsSync call is a single stat syscall cached by the OS. Binary search wouldn't reduce the number of calls since we must verify each path segment exists. The current approach is correct and fast enough." -t <thread-id>
```

**Batch operations:** When multiple threads have the same fix/response, use comma-separated IDs:
```bash
tools github review <pr> --respond "Fixed in [abc1234](https://github.com/owner/repo/commit/abc1234def5678) — addressed review feedback." -t <thread-id1>,<thread-id2>,<thread-id3>
```

**Important:** Do NOT use `--resolve-thread` unless the user explicitly asks to resolve threads. Only reply.

**When the user asks to resolve threads**, add `--resolve-thread` to the reply command:
```bash
tools github review <pr> --respond "Fixed in abc1234 — scoped stale cleanup to ..." --resolve-thread -t <thread-id>
```

When resolving in batch:
```bash
tools github review <pr> --respond "Fixed in abc1234" --resolve-thread -t <thread-id1>,<thread-id2>,<thread-id3>
```

**Permission note:** `--resolve-thread` requires a GitHub PAT with `pull_requests:write` scope. If it fails with "Resource not accessible by personal access token", the `--respond` reply will still succeed. Report the permission issue to the user so they can resolve threads manually on GitHub.

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

## Key Rules

1. **Always cat the full markdown file** - don't truncate
2. **Ask before fixing** - let user choose what to fix
3. **Follow commit message style** - match existing repo patterns
4. **Run linting** - validate fixes don't break types
5. **One commit** - group all PR review fixes into a single commit
6. **Reference PR** - include PR number in commit message
