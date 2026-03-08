# GitHub Review LLM — Plan 2: CLI Commands + LLM Output

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `--llm` flag, session support, and expand/respond/resolve/sessions subcommands to `tools github review`.

**Architecture:** New LLM formatter functions in `review-output.ts`, restructured review command with Commander subcommands in `review.ts`.

**Tech Stack:** TypeScript, Commander, chalk (for terminal), plain text (for LLM)

**Prerequisite:** Plan 1 (Foundation) must be completed first.

---

### Task 2.1: Add LLM Formatters to review-output.ts

**Files:**
- Modify: `src/github/lib/review-output.ts` (add at end, after `saveReviewMarkdown`)

**Step 1: Add imports at top of file**

Add to existing imports at line 6:
```typescript
import { formatRelativeTime } from "@app/utils/format";
```

**Step 2: Add `formatReviewLLM()` function at end of file**

```typescript
// =============================================================================
// LLM-Optimized Formatting (plain text, token-efficient)
// =============================================================================

/**
 * Format review data as compact L1 summary for LLM consumption.
 * Shows thread list with ref IDs (t1, t2, ...) for progressive drill-down.
 */
export function formatReviewLLM(data: ReviewData, sessionId: string): string {
    const { threads, stats } = data;

    let output = `=== PR Review Session: ${sessionId} ===\n`;
    output += `PR #${data.prNumber}: ${data.title} | ${data.state} | ${data.owner}/${data.repo}\n`;
    output += `Stats: ${stats.total} threads (${stats.unresolved} unresolved) | HIGH: ${stats.high} | MED: ${stats.medium} | LOW: ${stats.low}\n`;
    output += "\n";

    if (threads.length === 0) {
        output += "No review threads found.\n";
        return output;
    }

    output += "Threads:\n";

    for (const thread of threads) {
        const ref = `t${thread.threadNumber}`;
        const status = thread.status === "resolved" ? "RESOLVED" : "UNRESOLVED";
        const sev = thread.severity.toUpperCase().padEnd(4);
        const fileLine = thread.line ? `${thread.file}:${thread.line}` : thread.file;
        const age = formatRelativeTime(new Date(thread.createdAt), { compact: true });
        const replyCount = thread.replies.length;
        const replyText = replyCount === 0 ? "" : `(${replyCount} ${replyCount === 1 ? "reply" : "replies"})`;

        output += `  ${ref.padEnd(5)} ${status.padEnd(10)} ${sev}  ${fileLine.padEnd(35).slice(0, 35)}  ${thread.title.slice(0, 40).padEnd(40)}  @${thread.author.padEnd(12).slice(0, 12)}  ${age.padEnd(8)}  ${replyText}\n`;
    }

    output += "\n";
    output += `Expand: tools github review expand t1 -s ${sessionId}\n`;
    output += `Respond: tools github review respond t1 "message" -s ${sessionId}\n`;
    output += `Resolve: tools github review resolve t1,t2 -s ${sessionId}\n`;

    return output;
}

/**
 * Format a single thread in full detail (L2 view).
 */
export function formatThreadExpanded(thread: ParsedReviewThread, sessionId: string): string {
    const age = formatRelativeTime(new Date(thread.createdAt), { compact: true });

    let output = `=== Session: ${sessionId} | Thread t${thread.threadNumber} ===\n\n`;
    output += `Thread #${thread.threadNumber}: ${thread.title}\n`;
    output += `Status: ${thread.status.toUpperCase()} | Severity: ${thread.severity.toUpperCase()}\n`;

    const fileLine = thread.startLine && thread.startLine !== thread.line
        ? `${thread.file}:${thread.startLine}-${thread.line}`
        : thread.line ? `${thread.file}:${thread.line}` : thread.file;
    output += `File: ${fileLine} | Author: @${thread.author} | ${age}\n`;
    output += `Thread ID: ${thread.threadId}\n`;
    output += "\n";

    output += `Issue:\n${thread.issue}\n\n`;

    if (thread.diffHunk) {
        output += `Diff Context:\n${thread.diffHunk}\n\n`;
    }

    if (thread.suggestedCode) {
        output += `Suggested Change:\n\`\`\`suggestion\n${thread.suggestedCode}\n\`\`\`\n\n`;
    }

    if (thread.replies.length > 0) {
        output += `Replies (${thread.replies.length}):\n`;
        for (const reply of thread.replies) {
            const replyAge = formatRelativeTime(new Date(reply.createdAt), { compact: true });
            output += `  @${reply.author} (${replyAge}): ${reply.body}\n`;
        }
        output += "\n";
    }

    output += `Respond: tools github review respond t${thread.threadNumber} "message" -s ${sessionId}\n`;
    output += `Resolve: tools github review resolve t${thread.threadNumber} -s ${sessionId}\n`;

    return output;
}
```

**Step 3: Verify**

Run: `tsgo --noEmit | rg "review-output.ts"`
Expected: No errors

---

### Task 2.2: Add --llm and -s Flags + LLM Flow

**Files:**
- Modify: `src/github/commands/review.ts`

**Step 1: Add imports**

Add at top of `review.ts`:
```typescript
import { formatReviewLLM, formatThreadExpanded } from "@app/github/lib/review-output";
import { ReviewSessionManager } from "@app/github/lib/review-session";
import type { ReviewSessionData } from "@app/github/types";
import { formatRelativeTime } from "@app/utils/format";
```

Update existing import from `review-output` to merge with existing imports.

**Step 2: Add --llm and -s options to createReviewCommand()**

In `createReviewCommand()` (line 173), add these options after the existing `.option()` calls (before `.action()`):

```typescript
        .option("--llm", "LLM-optimized output with session (compact refs)", false)
        .option("-s, --session <id>", "Review session ID")
```

**Step 3: Add LLM flow to reviewCommand()**

In `reviewCommand()`, after the `reviewData` object is built (after line 149), add the LLM branch before the JSON output check:

```typescript
    // LLM-optimized output (session-based with refs)
    if (options.llm) {
        const sessionMgr = new ReviewSessionManager();
        const sessionId = options.session || sessionMgr.generateSessionId(prNumber);

        const sessionData: ReviewSessionData = {
            meta: {
                sessionId,
                owner,
                repo,
                prNumber,
                title: prInfo.title,
                state: prInfo.state,
                createdAt: Date.now(),
                stats,
                threadCount: displayThreads.length,
            },
            threads: displayThreads,
            prComments: reviewData.prComments,
        };

        await sessionMgr.createSession(sessionData);
        console.log(formatReviewLLM(reviewData, sessionId));
        return;
    }
```

**Step 4: Verify**

Run: `tsgo --noEmit | rg "review.ts"`

---

### Task 2.3: Add expand Subcommand

**Files:**
- Modify: `src/github/commands/review.ts`

**Step 1: Create expand subcommand function**

Add this function after `reviewCommand()` and before `createReviewCommand()`:

```typescript
async function expandCommand(refs: string, options: { session?: string; repo?: string }): Promise<void> {
    const sessionMgr = new ReviewSessionManager();
    const sessionId = options.session;
    if (!sessionId) {
        throw new Error("Session ID required. Use -s <session-id>");
    }

    const sessionData = await sessionMgr.loadSession(sessionId);
    if (!sessionData) {
        throw new Error(`Session not found or expired: ${sessionId}`);
    }

    const refIds = refs.split(",").map((s) => s.trim()).filter(Boolean);
    const resolved = sessionMgr.resolveRefIds(sessionData, refIds);

    for (const { refId, thread } of resolved) {
        if (!thread) {
            console.error(`Warning: ref ${refId} not found in session`);
            continue;
        }
        console.log(formatThreadExpanded(thread, sessionId));
    }
}
```

**Step 2: Register as subcommand in createReviewCommand()**

After the main `cmd` is created but before `return cmd`, add:

```typescript
    cmd.addCommand(
        new Command("expand")
            .description("Expand thread refs to show full detail")
            .argument("<refs>", "Thread refs (comma-separated, e.g. t1,t3,t5)")
            .option("-s, --session <id>", "Review session ID")
            .option("--repo <owner/repo>", "Repository")
            .action(async (refs, opts) => {
                try {
                    await expandCommand(refs, opts);
                } catch (error) {
                    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
                    process.exit(1);
                }
            })
    );
```

---

### Task 2.4: Add respond Subcommand

**Files:**
- Modify: `src/github/commands/review.ts`

**Step 1: Create respond subcommand function**

```typescript
async function respondCommand(
    refs: string,
    message: string,
    options: { session?: string; resolve?: boolean },
): Promise<void> {
    const sessionMgr = new ReviewSessionManager();
    const sessionId = options.session;
    if (!sessionId) {
        throw new Error("Session ID required. Use -s <session-id>");
    }

    const sessionData = await sessionMgr.loadSession(sessionId);
    if (!sessionData) {
        throw new Error(`Session not found or expired: ${sessionId}`);
    }

    const refIds = refs.split(",").map((s) => s.trim()).filter(Boolean);
    const resolved = sessionMgr.resolveRefIds(sessionData, refIds);
    const threadIds = resolved.map((r) => r.threadId).filter(Boolean);

    if (threadIds.length === 0) {
        throw new Error("No valid thread refs resolved");
    }

    const showProgress = threadIds.length > 1;

    if (options.resolve) {
        const result = await batchReplyAndResolve(threadIds, message, {
            onProgress: showProgress
                ? (done, total) => console.error(chalk.dim(`  [${done}/${total}]`))
                : undefined,
        });
        console.log(chalk.green(`Replied to ${result.replied}, resolved ${result.resolved} thread(s)`));
        if (result.failed.length) {
            console.error(chalk.red(`Failed: ${result.failed.join(", ")}`));
        }
    } else {
        const result = await batchReply(threadIds, message, {
            onProgress: showProgress
                ? (done, total) => console.error(chalk.dim(`  [${done}/${total}]`))
                : undefined,
        });
        console.log(chalk.green(`Replied to ${result.replied} thread(s)`));
        if (result.failed.length) {
            console.error(chalk.red(`Failed: ${result.failed.join(", ")}`));
        }
    }
}
```

**Step 2: Register as subcommand**

```typescript
    cmd.addCommand(
        new Command("respond")
            .description("Reply to review threads by ref ID")
            .argument("<refs>", "Thread refs (comma-separated, e.g. t1,t3)")
            .argument("<message>", "Reply message")
            .option("-s, --session <id>", "Review session ID")
            .option("--resolve", "Also resolve the threads after replying", false)
            .action(async (refs, message, opts) => {
                try {
                    await respondCommand(refs, message, opts);
                } catch (error) {
                    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
                    process.exit(1);
                }
            })
    );
```

---

### Task 2.5: Add resolve Subcommand

**Files:**
- Modify: `src/github/commands/review.ts`

**Step 1: Create resolve subcommand function**

```typescript
async function resolveCommand(
    refs: string,
    options: { session?: string },
): Promise<void> {
    const sessionMgr = new ReviewSessionManager();
    const sessionId = options.session;
    if (!sessionId) {
        throw new Error("Session ID required. Use -s <session-id>");
    }

    const sessionData = await sessionMgr.loadSession(sessionId);
    if (!sessionData) {
        throw new Error(`Session not found or expired: ${sessionId}`);
    }

    const refIds = refs.split(",").map((s) => s.trim()).filter(Boolean);
    const resolved = sessionMgr.resolveRefIds(sessionData, refIds);
    const threadIds = resolved.map((r) => r.threadId).filter(Boolean);

    if (threadIds.length === 0) {
        throw new Error("No valid thread refs resolved");
    }

    const showProgress = threadIds.length > 1;
    const result = await batchResolveThreads(threadIds, {
        onProgress: showProgress
            ? (done, total) => console.error(chalk.dim(`  [${done}/${total}]`))
            : undefined,
    });

    console.log(chalk.green(`Resolved ${result.resolved} thread(s)`));
    if (result.failed.length) {
        console.error(chalk.red(`Failed: ${result.failed.join(", ")}`));
    }
}
```

**Step 2: Register as subcommand**

```typescript
    cmd.addCommand(
        new Command("resolve")
            .description("Resolve review threads by ref ID")
            .argument("<refs>", "Thread refs (comma-separated, e.g. t1,t3,t5)")
            .option("-s, --session <id>", "Review session ID")
            .action(async (refs, opts) => {
                try {
                    await resolveCommand(refs, opts);
                } catch (error) {
                    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
                    process.exit(1);
                }
            })
    );
```

---

### Task 2.6: Add sessions Subcommand

**Files:**
- Modify: `src/github/commands/review.ts`

**Step 1: Create sessions subcommand function**

```typescript
async function sessionsCommand(): Promise<void> {
    const sessionMgr = new ReviewSessionManager();
    const sessions = await sessionMgr.listSessions();

    if (sessions.length === 0) {
        console.log("No review sessions found.");
        return;
    }

    console.log(`Review Sessions (${sessions.length}):\n`);
    for (const s of sessions) {
        const age = formatRelativeTime(new Date(s.createdAt), { compact: true });
        console.log(
            `  ${s.sessionId.padEnd(30)}  PR #${String(s.prNumber).padEnd(6)}  ${s.owner}/${s.repo}  ${String(s.threadCount).padEnd(3)} threads  ${age}`
        );
    }
}
```

**Step 2: Register as subcommand**

```typescript
    cmd.addCommand(
        new Command("sessions")
            .description("List review sessions")
            .action(async () => {
                try {
                    await sessionsCommand();
                } catch (error) {
                    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
                    process.exit(1);
                }
            })
    );
```

---

### Task 2.7: Update Command Description

**Files:**
- Modify: `src/github/commands/review.ts`

Update the `.description()` in `createReviewCommand()` to include the new subcommands and --llm flag in the examples section.

Add these examples:
```
  LLM mode (session-based with refs):
  $ tools github review 137 --llm                                            # Compact L1 summary with refs
  $ tools github review 137 --llm -u -s pr137-session                        # Unresolved only, named session
  $ tools github review expand t1,t3 -s pr137-20260308-143025                # Expand threads to full detail
  $ tools github review respond t1 "Fixed in abc123" --resolve -s pr137-...  # Reply + resolve
  $ tools github review resolve t1,t2,t3 -s pr137-...                        # Resolve threads
  $ tools github review sessions                                              # List review sessions
```

---

### Task 2.8: Verify Plan 2

Run: `tsgo --noEmit | rg "src/github"`
Expected: No new errors

### Task 2.9: Commit Plan 2

```bash
git add src/github/commands/review.ts src/github/lib/review-output.ts src/github/types.ts
git commit -m "feat(github-review): add --llm mode with session refs, expand/respond/resolve subcommands"
```
