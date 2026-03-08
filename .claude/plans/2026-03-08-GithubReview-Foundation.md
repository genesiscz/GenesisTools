# GitHub Review LLM — Plan 1: Foundation (Types + Session Manager)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add session types and ReviewSessionManager for persisting PR review data to disk.

**Architecture:** New types in `types.ts`, `createdAt` preserved in `parseThreads()`, new `ReviewSessionManager` class using `Storage` from `src/utils/storage/storage.ts`.

**Tech Stack:** TypeScript, Bun, Storage utility

---

### Task 1.1: Add Session Types to types.ts

**Files:**
- Modify: `src/github/types.ts:340-399`

**Step 1: Add `createdAt` to `ParsedReviewThread` and replies**

In `src/github/types.ts`, find the `ParsedReviewThread` interface (line 340) and add `createdAt` field. Also update the `replies` array type to include `createdAt`:

```typescript
export interface ParsedReviewThread {
    threadId: string;
    threadNumber: number;
    status: "resolved" | "unresolved";
    severity: "high" | "medium" | "low";
    file: string;
    line: number | null;
    startLine: number | null;
    author: string;
    title: string;
    issue: string;
    diffHunk: string | null;
    suggestedCode: string | null;
    firstCommentId: string;
    createdAt: string;  // ADD THIS
    replies: { author: string; body: string; id: string; createdAt: string }[];  // ADD createdAt
}
```

**Step 2: Add session-related types after `ReviewCommandOptions` (line 399)**

```typescript
export interface ReviewSessionMeta {
    sessionId: string;
    owner: string;
    repo: string;
    prNumber: number;
    title: string;
    state: string;
    createdAt: number;
    stats: ReviewThreadStats;
    threadCount: number;
}

export interface ReviewSessionData {
    meta: ReviewSessionMeta;
    threads: ParsedReviewThread[];
    prComments?: PRLevelComment[];
}
```

**Step 3: Add `llm` and `session` to `ReviewCommandOptions`**

In `src/github/types.ts`, add to the `ReviewCommandOptions` interface (line 386):
```typescript
    llm?: boolean;
    session?: string;
```

**Step 4: Verify types compile**

Run: `tsgo --noEmit | rg "types.ts"`
Expected: No errors from types.ts (may show pre-existing errors elsewhere)

---

### Task 1.2: Add createdAt to parseThreads()

**Files:**
- Modify: `src/github/lib/review-threads.ts:855-883`

**Step 1: Update the parseThreads function**

In `src/github/lib/review-threads.ts`, modify the `parseThreads` function (line 855) to include `createdAt` on both the thread and replies:

Find (line 860-864):
```typescript
            const replies = thread.comments.slice(1).map((c) => ({
                author: c.author,
                body: c.body,
                id: c.id,
            }));
```

Replace with:
```typescript
            const replies = thread.comments.slice(1).map((c) => ({
                author: c.author,
                body: c.body,
                id: c.id,
                createdAt: c.createdAt,
            }));
```

Then in the return object (line 866-881), add `createdAt` after `firstCommentId`:
```typescript
                firstCommentId: firstComment.id,
                createdAt: firstComment.createdAt,
                replies,
```

**Step 2: Verify**

Run: `tsgo --noEmit | rg "review-threads.ts"`
Expected: No errors

---

### Task 1.3: Create ReviewSessionManager

**Files:**
- Create: `src/github/lib/review-session.ts`

**Reuse:** `Storage` class from `src/utils/storage/storage.ts` (methods: `ensureDirs()`, `putCacheFile()`, `getCacheFile()`, `getCacheDir()`)

**Step 1: Create the session manager**

Create `src/github/lib/review-session.ts`:

```typescript
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ParsedReviewThread, ReviewSessionData, ReviewSessionMeta } from "@app/github/types";
import { Storage } from "@app/utils/storage/storage";

const SESSIONS_DIR = "reviews";
const SESSION_TTL = "7 days";

export class ReviewSessionManager {
    private storage: Storage;

    constructor() {
        this.storage = new Storage("github");
    }

    generateSessionId(prNumber: number): string {
        const now = new Date();
        const date = now.toISOString().slice(0, 10).replace(/-/g, "");
        const time = now.toISOString().slice(11, 19).replace(/:/g, "");
        return `pr${prNumber}-${date}-${time}`;
    }

    async createSession(data: ReviewSessionData): Promise<string> {
        const { sessionId } = data.meta;
        await this.storage.putCacheFile(
            `${SESSIONS_DIR}/${sessionId}.json`,
            data,
            SESSION_TTL,
        );
        await this.storage.putCacheFile(
            `${SESSIONS_DIR}/${sessionId}.meta.json`,
            data.meta,
            SESSION_TTL,
        );
        return sessionId;
    }

    async loadSession(sessionId: string): Promise<ReviewSessionData | null> {
        return this.storage.getCacheFile<ReviewSessionData>(
            `${SESSIONS_DIR}/${sessionId}.json`,
            SESSION_TTL,
        );
    }

    async loadSessionMeta(sessionId: string): Promise<ReviewSessionMeta | null> {
        return this.storage.getCacheFile<ReviewSessionMeta>(
            `${SESSIONS_DIR}/${sessionId}.meta.json`,
            SESSION_TTL,
        );
    }

    async listSessions(): Promise<ReviewSessionMeta[]> {
        const dir = join(this.storage.getCacheDir(), SESSIONS_DIR);
        if (!existsSync(dir)) {
            return [];
        }

        const files = readdirSync(dir).filter((f) => f.endsWith(".meta.json"));
        const sessions: ReviewSessionMeta[] = [];

        for (const file of files) {
            const sessionId = file.replace(".meta.json", "");
            const meta = await this.loadSessionMeta(sessionId);
            if (meta) {
                sessions.push(meta);
            }
        }

        return sessions.sort((a, b) => b.createdAt - a.createdAt);
    }

    /**
     * Resolve ref IDs (t1, t3) or raw GraphQL IDs (PRRT_xxx) to thread entries.
     * Returns array of { refId, threadId, thread } for each resolved ref.
     */
    resolveRefIds(
        sessionData: ReviewSessionData,
        refIds: string[],
    ): { refId: string; threadId: string; thread: ParsedReviewThread }[] {
        const results: { refId: string; threadId: string; thread: ParsedReviewThread }[] = [];

        for (const ref of refIds) {
            const match = ref.match(/^t(\d+)$/i);
            if (match) {
                const index = parseInt(match[1], 10) - 1;
                const thread = sessionData.threads[index];
                if (thread) {
                    results.push({ refId: ref, threadId: thread.threadId, thread });
                }
            } else {
                // Treat as raw GraphQL thread ID
                const thread = sessionData.threads.find((t) => t.threadId === ref);
                if (thread) {
                    results.push({ refId: `t${thread.threadNumber}`, threadId: ref, thread });
                } else {
                    results.push({ refId: ref, threadId: ref, thread: undefined as unknown as ParsedReviewThread });
                }
            }
        }

        return results;
    }
}
```

**Step 2: Verify**

Run: `tsgo --noEmit | rg "review-session.ts"`
Expected: No errors

---

### Task 1.4: Verify Plan 1

Run: `tsgo --noEmit | rg "src/github"`
Expected: No new errors introduced

### Task 1.5: Commit Plan 1

```bash
git add src/github/types.ts src/github/lib/review-threads.ts src/github/lib/review-session.ts
git commit -m "feat(github-review): add session types and ReviewSessionManager"
```
