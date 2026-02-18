# DarwinKit Utils — Tools Integration Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Integrate the `src/utils/macos/` darwinkit NLP utilities into existing GenesisTools tools, adding semantic search, sentiment analysis, language detection, and NER capabilities where they provide genuine user value.

**Architecture:** Each integration imports from `@app/utils/macos` — no new deps. All integrations follow the graceful degradation pattern: if `darwinkit` is not installed, the tool falls back to its existing behavior with a warning. Semantic features are optional (`--no-semantic`, `--semantic` flags as appropriate per tool).

**Tech Stack:** TypeScript, Bun, `@app/utils/macos` (already built), Commander.js — no new npm deps.

**Prerequisites:** `src/utils/macos/` must exist (built by `2026-02-17-DarwinKitUtils.md` plan).

---

## Tool Priority Tiers

| Tier | Tools | Reason |
|------|-------|--------|
| **1 — Implement Now** | claude-history, claude-resume | User-requested; rich text corpus; clear UX win |
| **2 — High Value** | git-last-commits-diff, har-analyzer, github | Process large text collections, search is central |
| **3 — Medium Value** | azure-devops, ask, collect-files-for-ai | Text processing but more specialized |
| **4 — Low Priority** | npm-package-diff, git-rebranch, files-to-prompt | Niche gains |

---

## Task 1: `claude-history` — Semantic Conversation Search

**Current behavior:** `tools claude-history search <query>` uses ripgrep text search across JSONL files.
**Enhancement:** Add semantic re-ranking so results are ordered by relevance to the query, not just keyword frequency. Add `--semantic` flag (off by default — this is a search tool, not like mail).

**Files:**
- Read: `src/claude-history/index.ts` — understand current search flow
- Read: `src/claude-history/lib.ts` — understand `searchConversations()` return shape
- Modify: `src/claude-history/index.ts` — add `--semantic` option to `search` command

**Step 1: Understand the current search result shape**

```bash
grep -n "SearchResult\|searchConversations\|formatResults" src/claude-history/index.ts | head -20
grep -n "SearchResult" src/claude-history/types.ts
```

`SearchResult` from `./types` has: `{ sessionId, projectPath, messages, metadata }` where `messages` is an array of matching message content strings.

**Step 2: Add `--semantic` option to the search command**

In `src/claude-history/index.ts`, find the `.command("search <query>")` block and add:

```typescript
.option("--semantic", "Re-rank results by semantic similarity to query (requires darwinkit)")
.option("--max-distance <n>", "Max semantic distance 0–2 (default: 1.5)", "1.5")
```

Add to the options type:
```typescript
semantic?: boolean;
maxDistance?: string;
```

**Step 3: Add semantic re-ranking after the existing search**

After `const results = await searchConversations(...)`, add:

```typescript
if (options.semantic && results.length > 0) {
    try {
        const { rankBySimilarity, closeDarwinKit } = await import("@app/utils/macos");
        // Build a text representation from each result's matching messages
        const items = results.map(r => ({
            ...r,
            text: r.messages.slice(0, 3).join(" ").slice(0, 500), // first 3 matching msgs
        }));
        const ranked = await rankBySimilarity(query, items, {
            maxDistance: parseFloat(options.maxDistance ?? "1.5"),
            language: "en",
        });
        results.length = 0;
        results.push(...ranked.map(r => r.item));
        closeDarwinKit();
    } catch (err) {
        console.warn(`Semantic ranking unavailable: ${err instanceof Error ? err.message : err}`);
    }
}
```

**Step 4: Test**

```bash
tools claude-history search "typescript refactor" --limit 5
# → existing keyword results

tools claude-history search "typescript refactor" --semantic --limit 5
# → same results, semantically re-ranked
```

**Step 5: Commit**

```bash
git add src/claude-history/index.ts
git commit -m "feat(claude-history): add --semantic option for semantic result re-ranking"
```

---

## Task 2: `claude-history` — Language-Grouped Session Stats

**Enhancement:** Add a `stats --by-language` mode that groups conversations by detected language, useful for multilingual users who work in multiple languages.

**Files:**
- Modify: `src/claude-history/index.ts` — add `--by-language` to `stats` subcommand

**Step 1: Find the stats subcommand**

```bash
grep -n "stats\|command.*stat" src/claude-history/index.ts | head -10
```

**Step 2: Add `--by-language` option**

```typescript
.option("--by-language", "Group session count by detected language (requires darwinkit)")
```

**Step 3: Implement language grouping**

```typescript
if (options.byLanguage) {
    const { groupByLanguage, closeDarwinKit } = await import("@app/utils/macos");

    // Take sample of first user messages from each session
    const items = sessions.slice(0, 200).map(s => ({
        id: s.sessionId,
        text: s.firstUserMessage?.slice(0, 200) ?? "",
    })).filter(i => i.text.length > 20);

    const groups = await groupByLanguage(items, { minConfidence: 0.8 });
    closeDarwinKit();

    console.log("\nSessions by language:\n");
    for (const [lang, sessions] of Object.entries(groups).sort((a, b) => b[1].length - a[1].length)) {
        console.log(`  ${lang.padEnd(12)} ${sessions.length} sessions`);
    }
    return;
}
```

**Step 4: Commit**

```bash
git add src/claude-history/index.ts
git commit -m "feat(claude-history): add --by-language grouping to stats"
```

---

## Task 3: `claude-resume` — Semantic Session Selection

**Current behavior:** `tools claude-resume` shows a list of recent sessions with keyword search via `@inquirer/prompts` `search()` — filters by session name/title only.

**Enhancement:** When the user types a description of what they want (e.g., "the session where I was debugging TypeScript types"), use semantic similarity to rank sessions by relevance instead of just substring matching.

**Files:**
- Read: `src/claude-resume/index.ts` (full file)
- Modify: `src/claude-resume/index.ts` — wrap the session listing with semantic ranking when a query is provided via `--query` flag

**Step 1: Read the full claude-resume/index.ts**

```bash
wc -l src/claude-resume/index.ts
# Understand the session display and selection flow
```

**Step 2: Add `--query` option**

```typescript
program
    .option("--query <description>", "Find sessions semantically matching this description (requires darwinkit)")
```

**Step 3: Implement semantic session selection**

When `--query` is provided, fetch all recent sessions and rank them:

```typescript
if (options.query) {
    const sessions = await getSessionListing({ limit: 100 });

    try {
        const { rankBySimilarity, closeDarwinKit } = await import("@app/utils/macos");
        const items = sessions.map(s => ({
            ...s,
            text: [s.name, s.summary, s.firstPrompt, s.branch].filter(Boolean).join(" "),
        }));
        const ranked = await rankBySimilarity(options.query, items, {
            maxDistance: 1.2,
            maxResults: 10,
        });
        closeDarwinKit();

        if (ranked.length === 0) {
            p.log.warn("No semantically similar sessions found.");
            return;
        }

        // Show top matches for user to pick from
        const chosen = await p.select({
            message: `Top sessions matching "${options.query}":`,
            options: ranked.map(r => ({
                value: r.item.sessionId,
                label: r.item.name || r.item.firstPrompt?.slice(0, 60) || "(unnamed)",
                hint: `score: ${(1 - r.score / 2).toFixed(2)} · ${r.item.branch || ""}`,
            })),
        });

        if (!p.isCancel(chosen)) {
            // Resume the chosen session
            await resumeSession(chosen);
        }
    } catch (err) {
        p.log.warn(`Semantic search failed (is darwinkit installed?): ${err}`);
        // Fall through to normal listing
    }
    return;
}
```

**Step 4: Test**

```bash
tools claude-resume --query "TypeScript debugging session"
# → shows semantically ranked sessions, user picks one, session resumes
```

**Step 5: Commit**

```bash
git add src/claude-resume/index.ts
git commit -m "feat(claude-resume): add --query option for semantic session discovery"
```

---

## Task 4: `git-last-commits-diff` — Semantic Commit Grouping

**Current behavior:** Shows commits and their diffs, filtered by file/author.
**Enhancement:** Add `--semantic-group` mode that clusters similar commits together using cosine distance, making it easy to see "all the auth-related changes" grouped together.

**Files:**
- Read: `src/git-last-commits-diff/index.ts`
- Modify: `src/git-last-commits-diff/index.ts`

**Step 1: Add `--semantic-group` option**

```typescript
.option("--semantic-group", "Group commits by semantic similarity of commit messages (requires darwinkit)")
```

**Step 2: Implement clustering**

After fetching the commit list, add:

```typescript
if (options.semanticGroup && commits.length > 1) {
    const { textDistance, closeDarwinKit } = await import("@app/utils/macos");

    // Build similarity matrix
    const groups: Array<typeof commits> = [];
    const assigned = new Set<number>();
    const THRESHOLD = 0.5;

    for (let i = 0; i < commits.length; i++) {
        if (assigned.has(i)) continue;
        const group = [commits[i]];
        assigned.add(i);

        for (let j = i + 1; j < commits.length; j++) {
            if (assigned.has(j)) continue;
            const { distance } = await textDistance(commits[i].message, commits[j].message, "en", "sentence");
            if (distance < THRESHOLD) {
                group.push(commits[j]);
                assigned.add(j);
            }
        }
        groups.push(group);
    }
    closeDarwinKit();

    // Print grouped output
    for (const group of groups) {
        if (group.length > 1) {
            console.log(chalk.bold(`\n── Related commits (${group.length}) ──`));
        }
        for (const commit of group) {
            printCommit(commit);
        }
    }
    return;
}
```

**Step 3: Commit**

```bash
git add src/git-last-commits-diff/index.ts
git commit -m "feat(git-last-commits-diff): add --semantic-group for commit clustering"
```

---

## Task 5: `har-analyzer` — Semantic Entry Deduplication

**Current behavior:** HAR analyzer creates a reference system to avoid repeating similar entries, but uses string/URL matching.
**Enhancement:** Use semantic similarity on response body content to detect truly similar API entries, improving the reference system quality.

**Files:**
- Read: `src/har-analyzer/core/` directory structure
- Modify: the reference-building logic in the analyzer

**Step 1: Explore har-analyzer structure**

```bash
find src/har-analyzer -name "*.ts" | head -20
grep -rn "reference\|dedup\|similar" src/har-analyzer/ | head -20
```

**Step 2: Add semantic deduplication option**

In the main CLI, add:

```typescript
.option("--semantic-dedup", "Use semantic similarity for entry deduplication (requires darwinkit)")
```

**Step 3: Use `rankBySimilarity` on response content**

In the reference-building pass, before adding a new reference:

```typescript
if (options.semanticDedup && existingRefs.length > 0) {
    const { areSimilar, closeDarwinKit } = await import("@app/utils/macos");
    const newContent = entry.response.content?.text?.slice(0, 500) ?? entry.request.url;

    for (const ref of existingRefs) {
        const similar = await areSimilar(newContent, ref.content, 0.4);
        if (similar) {
            // Mark as duplicate of ref
            entry.refId = ref.id;
            break;
        }
    }
    closeDarwinKit();
}
```

**Step 4: Commit**

```bash
git add src/har-analyzer/
git commit -m "feat(har-analyzer): add --semantic-dedup for content-aware entry deduplication"
```

---

## Task 6: `github` — Issue/PR Semantic Search

**Current behavior:** `tools github search <query>` uses GitHub's API text search.
**Enhancement:** After fetching issues/PRs, add client-side semantic re-ranking of results to surface the most semantically relevant items first.

**Files:**
- Read: `src/github/index.ts`
- Modify: `src/github/index.ts` — add `--semantic` to search subcommand

**Step 1: Find the search command**

```bash
grep -n "search\|command.*search" src/github/index.ts | head -10
```

**Step 2: Add `--semantic` flag**

After GitHub API returns results, pipe through `rankBySimilarity`:

```typescript
.option("--semantic", "Re-rank results by semantic similarity to query (requires darwinkit)")
```

**Step 3: Add re-ranking**

```typescript
if (options.semantic && results.length > 0) {
    const { rankBySimilarity, closeDarwinKit } = await import("@app/utils/macos");
    const items = results.map(r => ({
        ...r,
        text: `${r.title} ${r.body?.slice(0, 200) ?? ""}`,
    }));
    const ranked = await rankBySimilarity(query, items, { maxDistance: 1.5 });
    closeDarwinKit();
    results.length = 0;
    results.push(...ranked.map(r => r.item));
}
```

**Step 4: Commit**

```bash
git add src/github/index.ts
git commit -m "feat(github): add --semantic re-ranking for issue/PR search results"
```

---

## Task 7: `azure-devops` — Work Item NLP Enrichment

**Current behavior:** Work items fetched and displayed as-is.
**Enhancement:** Add `--sentiment` flag to `workitems` subcommand that shows sentiment of work item descriptions (useful for detecting frustration in bug reports), and `--lang` to detect language of descriptions for international teams.

**Files:**
- Read: `src/azure-devops/index.ts`
- Modify: `src/azure-devops/index.ts`

**Step 1: Add `--sentiment` option**

```typescript
.option("--sentiment", "Show sentiment analysis of work item descriptions (requires darwinkit)")
```

**Step 2: Batch sentiment analysis**

```typescript
if (options.sentiment && workItems.length > 0) {
    const { batchSentiment, closeDarwinKit } = await import("@app/utils/macos");
    const items = workItems
        .filter(wi => wi.fields?.["System.Description"])
        .map(wi => ({
            id: String(wi.id),
            text: (wi.fields["System.Description"] as string).replace(/<[^>]+>/g, "").slice(0, 500),
        }));

    const sentiments = await batchSentiment(items, { concurrency: 3 });
    closeDarwinKit();

    // Attach sentiment to work items for display
    const sentimentMap = new Map(sentiments.map(s => [s.id, s]));
    for (const wi of workItems) {
        const s = sentimentMap.get(String(wi.id));
        if (s) wi._sentiment = s;
    }
}
```

**Step 3: Commit**

```bash
git add src/azure-devops/index.ts
git commit -m "feat(azure-devops): add --sentiment analysis for work item descriptions"
```

---

## Task 8: `ask` — Semantic Prompt Deduplication

**Current behavior:** Stores conversation history, no duplicate detection.
**Enhancement:** Before sending a prompt, check if a semantically similar prompt was asked recently and warn/skip if `--dedup` is on. Useful in batch/automation scenarios.

**Files:**
- Read: `src/ask/index.ts`
- Modify: `src/ask/index.ts`

**Step 1: Add `--dedup-threshold <n>` option**

```typescript
.option("--dedup-threshold <n>", "Warn if recent prompt is semantically similar (0–2, default: disabled)")
```

**Step 2: Check against last N prompts**

```typescript
if (options.dedupThreshold) {
    const { textDistance, closeDarwinKit } = await import("@app/utils/macos");
    const threshold = parseFloat(options.dedupThreshold);
    const recentPrompts = getLastNPrompts(5); // from conversation history

    for (const recent of recentPrompts) {
        const { distance } = await textDistance(userInput, recent, "en", "sentence");
        if (distance < threshold) {
            console.warn(`⚠️  Similar prompt sent recently (distance: ${distance.toFixed(2)}). Use --force to proceed.`);
            if (!options.force) process.exit(0);
            break;
        }
    }
    closeDarwinKit();
}
```

**Step 3: Commit**

```bash
git add src/ask/index.ts
git commit -m "feat(ask): add --dedup-threshold for semantic prompt deduplication warning"
```

---

## Task 9: `collect-files-for-ai` — Semantic File Relevance Filtering

**Current behavior:** Collects recently changed files from git into timestamped folders.
**Enhancement:** Add `--context <description>` option that uses semantic similarity to filter/rank files by relevance to what you're working on. Only include files semantically relevant to the task description.

**Files:**
- Read: `src/collect-files-for-ai/index.ts`
- Modify: `src/collect-files-for-ai/index.ts`

**Step 1: Add `--context` option**

```typescript
.option("--context <description>", "Filter files by semantic relevance to this task description (requires darwinkit)")
.option("--context-threshold <n>", "Max distance to include (0–2, default: 1.0)", "1.0")
```

**Step 2: Rank files by content relevance**

```typescript
if (options.context && files.length > 0) {
    const { rankBySimilarity, closeDarwinKit } = await import("@app/utils/macos");

    // Read first 200 chars of each file as "text"
    const items = await Promise.all(files.map(async f => ({
        path: f,
        text: (await Bun.file(f).text().catch(() => "")).slice(0, 200),
    })));

    const ranked = await rankBySimilarity(options.context, items.filter(i => i.text), {
        maxDistance: parseFloat(options.contextThreshold ?? "1.0"),
    });
    closeDarwinKit();

    files = ranked.map(r => r.item.path);
    console.log(`Filtered to ${files.length} semantically relevant files.`);
}
```

**Step 3: Commit**

```bash
git add src/collect-files-for-ai/index.ts
git commit -m "feat(collect-files-for-ai): add --context for semantic file relevance filtering"
```

---

## Task 10: `npm-package-diff` — Breaking Change NLP Detection

**Current behavior:** Shows file diffs between npm package versions.
**Enhancement:** Run NLP on changelog/README content to auto-detect breaking changes and API removals via NER + keyword classification.

**Files:**
- Read: `src/npm-package-diff/index.ts`
- Modify: `src/npm-package-diff/index.ts`

**Step 1: Add `--nlp-analysis` option**

```typescript
.option("--nlp-analysis", "Run NLP on changelog to detect breaking changes (requires darwinkit)")
```

**Step 2: Analyze changelog sentiment + entities**

```typescript
if (options.nlpAnalysis && changelog) {
    const { analyzeSentiment, extractEntities, closeDarwinKit } = await import("@app/utils/macos");

    const sentiment = await analyzeSentiment(changelog.slice(0, 1000));
    const entities = await extractEntities(changelog.slice(0, 2000));
    closeDarwinKit();

    // Detect breaking change keywords via simple heuristic
    const hasBreaking = /breaking|removed?|deprecated|migration required/i.test(changelog);

    console.log(`\nChangelog Analysis:`);
    console.log(`  Tone: ${sentiment.label} (${sentiment.score.toFixed(2)})`);
    if (hasBreaking) console.log(`  ⚠️  Possible breaking changes detected`);
    if (entities.length > 0) {
        console.log(`  Mentioned entities: ${entities.map(e => e.text).join(", ")}`);
    }
}
```

**Step 3: Commit**

```bash
git add src/npm-package-diff/index.ts
git commit -m "feat(npm-package-diff): add --nlp-analysis for changelog sentiment and breaking change detection"
```

---

## Graceful Degradation Pattern (All Tasks)

Every integration must follow this pattern to work without darwinkit installed:

```typescript
// Pattern: lazy import + try/catch + always close
if (options.semantic) {
    try {
        const { rankBySimilarity, closeDarwinKit } = await import("@app/utils/macos");
        // ... do NLP work ...
        closeDarwinKit();
    } catch (err) {
        // darwinkit not installed, or subprocess failed
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("darwinkit") || msg.includes("spawn") || msg.includes("ENOENT")) {
            console.warn("Semantic ranking unavailable (install darwinkit: brew install darwinkit)");
        } else {
            console.warn(`Semantic ranking failed: ${msg}`);
        }
        // Fall through — original results unchanged
    }
}
```

---

## Testing Each Integration

Since GenesisTools has no test suite, verify each integration manually:

```bash
# 1. Without darwinkit (should degrade gracefully)
which darwinkit && brew unlink darwinkit
tools claude-history search "test" --semantic
# → "Semantic ranking unavailable (install darwinkit: ...)"

brew link darwinkit

# 2. With darwinkit installed
tools claude-history search "typescript types" --semantic --limit 5
# → results shown, semantically ranked

tools claude-resume --query "the session where I was building the macos tool"
# → shows semantically matching sessions

tools git-last-commits-diff --semantic-group --commits 20
# → commits grouped by topic similarity
```

---

## Summary: What Each Tool Gains

| Tool | Feature Added | Flag | Value |
|------|--------------|------|-------|
| `claude-history search` | Semantic re-ranking | `--semantic` | Find related conversations, not just keyword matches |
| `claude-history stats` | Language grouping | `--by-language` | Multilingual workspace awareness |
| `claude-resume` | Semantic session discovery | `--query <desc>` | "Find the session where I was debugging X" |
| `git-last-commits-diff` | Commit clustering | `--semantic-group` | Group related changes automatically |
| `har-analyzer` | Content deduplication | `--semantic-dedup` | Better reference system |
| `github` | Issue/PR re-ranking | `--semantic` | Surface most relevant results first |
| `azure-devops` | Work item sentiment | `--sentiment` | Detect frustration/urgency in bug reports |
| `ask` | Prompt deduplication | `--dedup-threshold` | Avoid sending duplicate queries |
| `collect-files-for-ai` | Context-aware filtering | `--context <desc>` | Include only relevant files for task |
| `npm-package-diff` | Changelog NLP | `--nlp-analysis` | Auto-detect breaking changes |
