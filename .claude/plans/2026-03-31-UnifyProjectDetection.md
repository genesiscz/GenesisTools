# Unify Project Detection & Fix Session Search Bugs

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix three bugs that prevent `tools cc` and `tools claude history` from finding sessions in nested project directories (e.g. `CEZ/col-fe`) and large (>10MB) JSONL files.

**Architecture:** Extract a shared `resolveProjectFilter()` function that both `history` and `resume` commands use. It calls `encodedProjectDir()` to get the exact `~/.claude/projects/` directory name, eliminating glob guesswork. Also fix `readTailBytes` line-boundary detection and lift the 10MB indexing skip.

**Tech Stack:** TypeScript, Bun, bun:test

---

## Bugs & Failing Tests

| # | Bug | Test File | Test Name |
|---|-----|-----------|-----------|
| 1 | `readTailBytes` drops valid first line when slice starts on `\n` boundary | `session.utils.test.ts` | "preserves first line when slice starts exactly on a line boundary" |
| 2 | `readTailBytes` same bug (duplicate coverage) | `search.test.ts` | "preserves complete first line when slice starts on newline boundary" |
| 3 | `history` auto-detect takes parent org instead of leaf project | `search.test.ts` | "detects leaf project name, not parent org, for nested project dirs" |
| 4 | `extractProjectName` returns empty for encoded nested dirs | `search.test.ts` | "extractProjectName handles encoded nested project dir" |
| 5 | Glob pattern from parent org name matches sibling projects | `search.test.ts` | "glob pattern from parent org name is too broad" |
| 6 | `extractSessionMetadataFromFile` silently skips files >10MB | *(no test yet — needs file system mock)* | — |

Run all failing tests: `bun test src/utils/claude/session.utils.test.ts src/claude/lib/history/search.test.ts`

---

### Task 1: Fix `readTailBytes` line-boundary detection

**Files:**
- Modify: `src/utils/claude/session.utils.ts:94-106`
- Test: `src/utils/claude/session.utils.test.ts` (already exists, failing)
- Test: `src/claude/lib/history/search.test.ts` (already exists, failing)

**Step 1: Implement the fix**

In `readTailBytes`, check whether the byte slice starts on a newline boundary before dropping the first line:

```typescript
export async function readTailBytes(filePath: string, bytes = 8192): Promise<string[]> {
    const file = Bun.file(filePath);
    const size = file.size;
    const start = Math.max(0, size - bytes);
    const tail = await file.slice(start, size).text();
    const lines = tail.split("\n").filter((l) => l.trim());

    // First line may be partial if we sliced mid-line — drop it unless:
    // 1. We read from the start of the file (start === 0)
    // 2. The slice starts exactly on a newline boundary
    if (start > 0 && lines.length > 0) {
        const prevByte = await file.slice(start - 1, start).text();
        const startsOnBoundary = tail.startsWith("\n") || prevByte === "\n";

        if (!startsOnBoundary) {
            lines.shift();
        }
    }

    return lines;
}
```

**Step 2: Run tests to verify they pass**

Run: `bun test src/utils/claude/session.utils.test.ts src/claude/lib/history/search.test.ts -t "readTailBytes"`
Expected: All readTailBytes tests PASS (bugs 1 & 2 fixed)

**Step 3: Commit**

```bash
git add src/utils/claude/session.utils.ts
git commit -m "fix(session): readTailBytes preserves first line on boundary slice"
```

---

### Task 2: Extract shared `resolveProjectFilter()` function

**Files:**
- Modify: `src/utils/claude/index.ts` (add new export)
- Test: `src/claude/lib/history/search.test.ts` (update existing tests)

**Step 1: Add `resolveProjectFilter()` to `src/utils/claude/index.ts`**

This function returns the encoded project directory name that matches `~/.claude/projects/` entries:

```typescript
/**
 * Resolve the current working directory to a project filter string
 * that matches ~/.claude/projects/ directory names.
 *
 * Returns the encoded dir name (e.g. "-Users-jane-Projects-acme-corp-web-app")
 * if it exists, or falls back to basename(cwd) for glob matching.
 */
export function resolveProjectFilter(cwd?: string): string | undefined {
    const dir = cwd ?? process.cwd();
    const encoded = encodedProjectDir(dir);
    const projectsDir = resolve(homedir(), ".claude", "projects");
    const exact = resolve(projectsDir, encoded);

    if (existsSync(exact)) {
        return encoded;
    }

    // Fallback: basename for partial matching
    return basename(dir) || undefined;
}
```

Add necessary imports: `existsSync` from `node:fs`, `resolve`, `basename` from `node:path`, `homedir` from `node:os`.

**Step 2: Write a test for `resolveProjectFilter`**

Add to `search.test.ts`:

```typescript
it("resolveProjectFilter returns encoded dir matching ~/.claude/projects/", () => {
    const { resolveProjectFilter } = require("@app/utils/claude");
    // When called with actual cwd, should return an encoded string
    const result = resolveProjectFilter(process.cwd());
    expect(result).toBeTruthy();
    // Should start with "-" (Claude's encoding prefix)
    if (result!.startsWith("-")) {
        expect(result).toContain(basename(process.cwd()));
    }
});
```

**Step 3: Run tests**

Run: `bun test src/claude/lib/history/search.test.ts -t "resolveProjectFilter"`
Expected: PASS

**Step 4: Commit**

```bash
git add src/utils/claude/index.ts
git commit -m "feat(claude): add resolveProjectFilter for unified project detection"
```

---

### Task 3: Replace history command's broken heuristic

**Files:**
- Modify: `src/claude/commands/history.ts:232-242`

**Step 1: Replace the `Projects` heuristic with `resolveProjectFilter()`**

```typescript
// BEFORE (broken):
let project = options.project;
if (!project && !options.all) {
    const cwd = process.cwd();
    const cwdParts = cwd.split(sep);
    const projectIndex = cwdParts.findIndex((p: string) => p === "Projects" || p === "projects");
    if (projectIndex !== -1 && cwdParts[projectIndex + 1]) {
        project = cwdParts[projectIndex + 1];
        console.log(chalk.dim(`Auto-detected project: ${project} (use --all to search all projects)`));
    }
}

// AFTER (correct):
let project = options.project;
if (!project && !options.all) {
    project = resolveProjectFilter();
    if (project) {
        const displayName = detectCurrentProject() || project;
        console.log(chalk.dim(`Auto-detected project: ${displayName} (use --all to search all projects)`));
    }
}
```

Add import: `import { resolveProjectFilter, detectCurrentProject } from "@app/utils/claude";`

**Step 2: Update `findConversationFiles` glob to use exact match when encoded dir is passed**

In `src/claude/lib/history/search.ts:85-91`, when `project` starts with `-` (encoded dir), use exact path instead of glob:

```typescript
if (filters.project && filters.project !== "all") {
    if (filters.project.startsWith("-")) {
        // Exact encoded dir — no glob needed
        const projectPattern = `${PROJECTS_DIR}/${filters.project}/**/*.jsonl`;
        patterns.push(projectPattern);
    } else {
        // Partial name — glob match
        const projectPattern = `${PROJECTS_DIR}/*${filters.project}*/**/*.jsonl`;
        patterns.push(projectPattern);
    }
}
```

**Step 3: Run failing tests to verify they pass**

Run: `bun test src/claude/lib/history/search.test.ts -t "project detection"`
Expected: "detects leaf project name" and "glob pattern too broad" now PASS

**Step 4: Also update `resume` command to use `resolveProjectFilter`**

In `src/claude/commands/resume.ts:113`:

```typescript
// BEFORE:
const project = allProjects ? undefined : detectCurrentProject();

// AFTER:
const project = allProjects ? undefined : resolveProjectFilter();
```

Add import: `import { resolveProjectFilter } from "@app/utils/claude";`

**Step 5: Commit**

```bash
git add src/claude/commands/history.ts src/claude/commands/resume.ts src/claude/lib/history/search.ts
git commit -m "fix(claude): unify project detection across history and resume commands"
```

---

### Task 4: Lift the 10MB session indexing skip

**Files:**
- Modify: `src/claude/lib/history/search.ts:1486-1490`

**Step 1: Replace the hard skip with a line-limited read for large files**

```typescript
// BEFORE:
const fileStat = await stat(filePath);
if (fileStat.size > 10 * 1024 * 1024) {
    return null;
}

// AFTER:
const fileStat = await stat(filePath);
const isLargeFile = fileStat.size > 10 * 1024 * 1024;
```

Then add a line counter after the `for await` loop setup:

```typescript
const LINE_LIMIT = isLargeFile ? 200 : Number.POSITIVE_INFINITY;
let lineCount = 0;

for await (const line of rl) {
    if (!line.trim()) {
        continue;
    }

    lineCount++;
    if (lineCount > LINE_LIMIT) {
        break;
    }
    // ... rest of parsing
```

This reads only the first 200 lines of large files (enough for sessionId, gitBranch, firstPrompt, summary) instead of skipping entirely.

**Step 2: Run all tests**

Run: `bun test src/claude/lib/history/search.test.ts src/utils/claude/session.utils.test.ts`
Expected: All PASS

**Step 3: Commit**

```bash
git add src/claude/lib/history/search.ts
git commit -m "fix(claude): index large session files by reading first 200 lines instead of skipping"
```

---

### Task 5: Update tests — remove now-passing assertions, clean up unused imports

**Files:**
- Modify: `src/claude/lib/history/search.test.ts` — remove unused `{ resolve, sep }` import, unused destructured vars
- Modify: `src/utils/paths.test.ts` — remove unused `winHome`, `winPath`, `mod` vars from collapsePath tests

**Step 1: Clean up TypeScript warnings**

Fix the TS6133 warnings ("declared but never read") in both test files.

**Step 2: Run full test suite**

Run: `bun test src/claude/lib/history/search.test.ts src/utils/claude/session.utils.test.ts src/utils/paths.test.ts`
Expected: All PASS, 0 warnings

**Step 3: Commit**

```bash
git add src/claude/lib/history/search.test.ts src/utils/paths.test.ts
git commit -m "chore: clean up test imports and unused variables"
```

---

### Task 6: Address PR #137 review comments

After the above fixes, address the 11 review threads from PR #137. Key fixes:

| Thread | Fix | Complexity |
|--------|-----|------------|
| t1 | Sort ISO strings with `localeCompare` instead of `new Date()` | Trivial |
| t2 | Fix `separatorLines` calculation: `* 2` for `marginTop` | Trivial |
| t3 | Add setTimeout cleanup via `useRef` for unmount safety | Medium |
| t4 | Merge `perBucket` loop into direct result merge | Low |
| t6 | Check `proc.exited` exit code before marking ping "done" | Low |
| t7 | Implement `[2] Resume` action (currently no-op) | Medium |
| t8 | Use `SafeJSON.parse(lines[i], { strict: true })` | Trivial |
| t9 | Reformat `Array.from` to pass Biome formatter | Trivial |
| t10 | Already fixed by Task 1 (`readTailBytes` boundary fix) | Done |
| t11 | Already fixed by existing `collapsePath` (handles `\\`) | Verify |

**Step 1:** Apply t1, t2, t4, t8, t9 (trivial one-liners)
**Step 2:** Apply t3, t6 (medium — setTimeout cleanup, exit code check)
**Step 3:** Apply t7 (resume action — needs `findClaudeCommand` + clipboard copy)
**Step 4:** Verify t10 is fixed by Task 1, t11 is already handled
**Step 5:** Reply to all threads on GitHub
**Step 6:** Commit

```bash
git commit -m "fix(claude): address PR #137 review comments"
```
