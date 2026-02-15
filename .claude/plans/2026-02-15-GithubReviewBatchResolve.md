# GitHub Review: Batch Resolve & Reply via Comma-Separated Thread IDs

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let `tools github review` resolve/reply to multiple threads at once by accepting comma-separated thread IDs in `--thread-id` (instead of one-by-one).

**Architecture:** Extend `--thread-id` to accept comma-separated values, add batch mutation helpers in `review-threads.ts`, update the command handler to loop over IDs, update skill and command docs.

**Tech Stack:** TypeScript, Commander.js, Octokit GraphQL

---

## Context

The `tools github review` command currently supports single-thread mutations only:
- `--respond "msg" -t <thread-id>` — reply to one thread
- `--resolve-thread -t <thread-id>` — resolve one thread
- Both combined: `--respond "msg" --resolve-thread -t <thread-id>`

**Problem:** After fixing a PR with 14 review threads, you have to run 14 separate commands. This plan adds comma-separated ID support so you can do:

```bash
# Resolve multiple threads
tools github review 175 --resolve-thread -t PRRT_id1,PRRT_id2,PRRT_id3

# Reply to multiple threads with same message
tools github review 175 --respond "Fixed in abc1234" -t PRRT_id1,PRRT_id2

# Reply + resolve multiple threads
tools github review 175 --respond "Fixed" --resolve-thread -t PRRT_id1,PRRT_id2,PRRT_id3
```

### Key Source Files

| File | What | Key Lines |
|------|------|-----------|
| `src/github/commands/review.ts` | Command handler + CLI options | `reviewCommand()` L15-105, `createReviewCommand()` L110-147 |
| `src/github/types.ts` | `ReviewCommandOptions` interface | L373-384 |
| `src/github/lib/review-threads.ts` | `replyToThread()`, `markThreadResolved()` | L259-280, L285-300 |
| `plugins/genesis-tools/skills/github/SKILL.md` | Skill docs (review sections) | L208-252 |
| `plugins/genesis-tools/commands/github-pr.md` | PR review fixer command | Step 6 (L129-150) |

---

## Task 1: Add batch mutation helpers to review-threads.ts

**Files:**
- Modify: `src/github/lib/review-threads.ts`

**Step 1:** Add `batchResolveThreads` function after `markThreadResolved` (around line 300):

```typescript
/**
 * Resolve multiple review threads with progress reporting.
 * Continues on individual failures, collecting failed IDs.
 */
export async function batchResolveThreads(
    threadIds: string[],
    options?: { onProgress?: (done: number, total: number) => void }
): Promise<{ resolved: number; failed: string[] }> {
    let resolved = 0;
    const failed: string[] = [];

    for (const threadId of threadIds) {
        try {
            await markThreadResolved(threadId);
            resolved++;
            options?.onProgress?.(resolved, threadIds.length);
        } catch {
            failed.push(threadId);
        }
    }

    return { resolved, failed };
}
```

**Step 2:** Add `batchReplyAndResolve` function right after:

```typescript
/**
 * Reply to and resolve multiple threads with the same message.
 * If reply succeeds but resolve fails, the reply is still kept.
 */
export async function batchReplyAndResolve(
    threadIds: string[],
    message: string,
    options?: { onProgress?: (done: number, total: number) => void }
): Promise<{ replied: number; resolved: number; failed: string[] }> {
    let replied = 0;
    let resolved = 0;
    const failed: string[] = [];

    for (const threadId of threadIds) {
        try {
            await replyToThread(threadId, message);
            replied++;
            await markThreadResolved(threadId);
            resolved++;
            options?.onProgress?.(resolved, threadIds.length);
        } catch {
            failed.push(threadId);
        }
    }

    return { replied, resolved, failed };
}
```

**Step 3:** Add `batchReply` function for reply-only batch:

```typescript
/**
 * Reply to multiple threads with the same message.
 */
export async function batchReply(
    threadIds: string[],
    message: string,
    options?: { onProgress?: (done: number, total: number) => void }
): Promise<{ replied: number; failed: string[] }> {
    let replied = 0;
    const failed: string[] = [];

    for (const threadId of threadIds) {
        try {
            await replyToThread(threadId, message);
            replied++;
            options?.onProgress?.(replied, threadIds.length);
        } catch {
            failed.push(threadId);
        }
    }

    return { replied, failed };
}
```

**Step 4:** Run `tsgo --noEmit` to verify types compile.

---

## Task 2: Update review command handler for batch operations

**Files:**
- Modify: `src/github/commands/review.ts`

**Step 1:** Update the validation block (around line 31-39). Currently:

```typescript
const resolveThreadOpt = options.resolveThread || options.resolve;
if ((options.respond || resolveThreadOpt) && !options.threadId) {
    throw new Error(
        '--thread-id is required when using --respond or --resolve-thread\n' +
        ...
    );
}
```

No change needed here — `--thread-id` is still required, just now it can be comma-separated.

**Step 2:** Replace the single-thread mutation block (around lines 42-59) with batch-aware logic:

```typescript
// Handle reply/resolve operations
if (options.respond || resolveThreadOpt) {
    const threadIds = options.threadId!.split(",").map((s) => s.trim());

    if (options.respond && resolveThreadOpt) {
        // Reply + resolve
        const result = await batchReplyAndResolve(threadIds, options.respond, {
            onProgress: (done, total) =>
                threadIds.length > 1 && console.error(chalk.dim(`  [${done}/${total}]`)),
        });
        console.log(
            chalk.green(`Replied to ${result.replied}, resolved ${result.resolved} thread(s)`)
        );
        if (result.failed.length) {
            console.error(chalk.red(`Failed: ${result.failed.join(", ")}`));
        }
    } else if (resolveThreadOpt) {
        // Resolve only
        const result = await batchResolveThreads(threadIds, {
            onProgress: (done, total) =>
                threadIds.length > 1 && console.error(chalk.dim(`  [${done}/${total}]`)),
        });
        console.log(chalk.green(`Resolved ${result.resolved} thread(s)`));
        if (result.failed.length) {
            console.error(chalk.red(`Failed: ${result.failed.join(", ")}`));
        }
    } else {
        // Reply only
        const result = await batchReply(threadIds, options.respond!, {
            onProgress: (done, total) =>
                threadIds.length > 1 && console.error(chalk.dim(`  [${done}/${total}]`)),
        });
        console.log(chalk.green(`Replied to ${result.replied} thread(s)`));
        if (result.failed.length) {
            console.error(chalk.red(`Failed: ${result.failed.join(", ")}`));
        }
    }

    return;
}
```

**Step 3:** Add imports at top of file:

```typescript
import {
    // ... existing imports ...
    batchResolveThreads,
    batchReplyAndResolve,
    batchReply,
} from "../lib/review-threads.js";
```

**Step 4:** Update the `--thread-id` option description in `createReviewCommand()` (around line 132):

```typescript
.option("-t, --thread-id <ids>", "Thread ID(s) for reply/resolve (comma-separated for batch)")
```

**Step 5:** Run `tsgo --noEmit` to verify types compile.

---

## Task 3: Update help text in createReviewCommand()

**Files:**
- Modify: `src/github/commands/review.ts` — the `.description()` block

**Step 1:** Add batch examples to the description string. Find the existing examples section and add:

```
  Batch operations (comma-separated thread IDs):
  $ tools github review 137 --resolve-thread -t PRRT_id1,PRRT_id2,PRRT_id3
  $ tools github review 137 --respond "Fixed in abc1234" -t PRRT_id1,PRRT_id2
  $ tools github review 137 --respond "Fixed" --resolve-thread -t PRRT_id1,PRRT_id2,PRRT_id3
```

**Step 2:** Run `tsgo --noEmit` to verify.

---

## Task 4: Update plugin skill docs

**Files:**
- Modify: `plugins/genesis-tools/skills/github/SKILL.md` (lines 208-252)

**Step 1:** In the "Review Threads" section (around line 208), add batch examples after the single-thread ones:

```markdown
### Batch Operations

Reply to or resolve multiple threads at once using comma-separated IDs:

```bash
# Resolve multiple threads
tools github review 137 --resolve-thread -t PRRT_id1,PRRT_id2,PRRT_id3

# Reply to multiple threads with same message
tools github review 137 --respond "Fixed in abc1234" -t PRRT_id1,PRRT_id2

# Reply + resolve multiple threads
tools github review 137 --respond "Fixed" --resolve-thread -t PRRT_id1,PRRT_id2,PRRT_id3
```
```

**Step 2:** In the "Resolving Review Threads" section (around line 232), add batch resolve example:

```markdown
# Batch reply + resolve
tools github review 137 --respond "Fixed in abc1234" --resolve-thread -t PRRT_id1,PRRT_id2,PRRT_id3
```

**Step 3:** Add a cross-reference to the `/github-pr` command at the end of the Review Threads section:

```markdown
> **Full PR review workflow:** For an end-to-end flow (fetch review threads, triage, implement fixes, commit, reply to threads), use the `/github-pr <pr>` command instead of manual `tools github review` calls.
```

---

## Task 5: Update github-pr command docs

**Files:**
- Modify: `plugins/genesis-tools/commands/github-pr.md` (Step 6, around line 129)

**Step 1:** Update Step 6 to show that batch replies are possible. After the existing single-thread examples, add:

```markdown
**Batch operations:** When multiple threads have the same fix/response, use comma-separated IDs:
```bash
tools github review <pr> --respond "Fixed in abc1234 — addressed review feedback." -t <thread-id1>,<thread-id2>,<thread-id3>
```

When the user asks to also resolve threads in batch:
```bash
tools github review <pr> --respond "Fixed in abc1234" --resolve-thread -t <thread-id1>,<thread-id2>,<thread-id3>
```
```

**Step 2:** Add a cross-reference to the github skill near the top of the file (after the Usage section or in a new "Dependencies" note):

```markdown
> **Underlying CLI:** This command uses `tools github review` under the hood. See the `genesis-tools:github` skill for full CLI reference and options.
```

---

## Verification

After all tasks:

```bash
# Type-check
tsgo --noEmit 2>&1 | rg "github"

# Verify single-thread still works (existing behavior)
tools github review <pr> --respond "test" -t <single-thread-id>

# Verify batch resolve (comma-separated)
tools github review <pr> --resolve-thread -t <id1>,<id2>

# Verify batch reply (comma-separated)
tools github review <pr> --respond "Batch test" -t <id1>,<id2>

# Verify batch reply+resolve
tools github review <pr> --respond "Fixed" --resolve-thread -t <id1>,<id2>

# Verify help text shows batch examples
tools github review --help
```
