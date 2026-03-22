# Indexer v3 -- Plan 9: Context Artifacts + Auto-Resume + Lifecycle

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Index non-code project knowledge (DB schemas, API specs, configs) alongside code, auto-resume interrupted indexes on startup, and add infrastructure-aware watcher back-off.

**Architecture:** New `ContextArtifactSource` implementing `IndexerSource` interface. Config file `.genesistoolscontext.json`. Auto-resume in `IndexerManager.load()`. Infrastructure error classification in watcher.

**Tech Stack:** TypeScript/Bun, existing IndexerSource interface, `ignore` npm package for `.genesistoolsignore`

**Branch:** `feat/indexer3` (current)

---

## Task 1: Define `.genesistoolscontext.json` schema + types

**Files:**
- `src/indexer/lib/context-artifacts/types.ts` (new)
- `src/indexer/lib/context-artifacts/config.ts` (new)

**Why:** We need a config file format for users to declare non-code artifacts (DB schemas, API specs, infra configs). Inspired by SocratiCode's `.socraticodecontextartifacts.json` but adapted to our simpler, Qdrant-free architecture.

**Details:**

Create `src/indexer/lib/context-artifacts/types.ts`:

```typescript
/** A context artifact defined in .genesistoolscontext.json */
export interface ContextArtifact {
    /** Unique name for this artifact (e.g. "database-schema", "api-spec") */
    name: string;
    /** Path to the file or directory (relative to project root or absolute) */
    path: string;
    /** Human-readable description explaining what this artifact is */
    description: string;
}

/** Runtime state of an indexed artifact, persisted alongside IndexMeta */
export interface ArtifactIndexState {
    name: string;
    description: string;
    /** Resolved absolute path */
    resolvedPath: string;
    /** SHA-256 content hash (first 16 hex chars) at last index time */
    contentHash: string;
    /** ISO timestamp of last indexing */
    lastIndexedAt: string;
    /** Number of chunks stored */
    chunksIndexed: number;
}

/** Shape of the .genesistoolscontext.json config file */
export interface ContextConfig {
    artifacts?: ContextArtifact[];
}
```

Create `src/indexer/lib/context-artifacts/config.ts`:

```typescript
import fsp from "node:fs/promises";
import path from "node:path";
import type { ContextArtifact, ContextConfig } from "./types";

export const CONFIG_FILENAME = ".genesistoolscontext.json";

/**
 * Load and validate .genesistoolscontext.json from a project root.
 * Returns null if the file doesn't exist. Throws on parse/validation errors.
 */
export async function loadContextConfig(projectPath: string): Promise<ContextConfig | null> {
    const configPath = path.join(path.resolve(projectPath), CONFIG_FILENAME);

    try {
        await fsp.access(configPath);
    } catch {
        return null;
    }

    const raw = await fsp.readFile(configPath, "utf-8");
    let parsed: unknown;

    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw new Error(
            `${CONFIG_FILENAME} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
        );
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${CONFIG_FILENAME} must be a JSON object`);
    }

    const config = parsed as Record<string, unknown>;

    if (config.artifacts !== undefined) {
        validateArtifacts(config.artifacts);
    }

    return config as ContextConfig;
}

function validateArtifacts(artifacts: unknown): asserts artifacts is ContextArtifact[] {
    if (!Array.isArray(artifacts)) {
        throw new Error(`${CONFIG_FILENAME}: "artifacts" must be an array`);
    }

    const names = new Set<string>();

    for (let i = 0; i < artifacts.length; i++) {
        const a = artifacts[i];

        if (typeof a !== "object" || a === null || Array.isArray(a)) {
            throw new Error(`${CONFIG_FILENAME}: artifacts[${i}] must be an object`);
        }

        const artifact = a as Record<string, unknown>;

        if (typeof artifact.name !== "string" || !artifact.name.trim()) {
            throw new Error(`${CONFIG_FILENAME}: artifacts[${i}].name must be a non-empty string`);
        }

        if (typeof artifact.path !== "string" || !artifact.path.trim()) {
            throw new Error(`${CONFIG_FILENAME}: artifacts[${i}].path must be a non-empty string`);
        }

        if (typeof artifact.description !== "string" || !artifact.description.trim()) {
            throw new Error(`${CONFIG_FILENAME}: artifacts[${i}].description must be a non-empty string`);
        }

        const normalized = artifact.name.trim().toLowerCase();

        if (names.has(normalized)) {
            throw new Error(`${CONFIG_FILENAME}: duplicate artifact name "${artifact.name}"`);
        }

        names.add(normalized);
    }
}
```

**Tests:** `src/indexer/lib/context-artifacts/config.test.ts` -- test loadContextConfig with valid config, missing file (returns null), invalid JSON, missing required fields, duplicate names.

**Commit:** `feat(indexer): define .genesistoolscontext.json schema and config loader`

---

## Task 2: Create `ContextArtifactSource` implementing `IndexerSource`

**Files:**
- `src/indexer/lib/context-artifacts/context-artifact-source.ts` (new)
- `src/indexer/lib/context-artifacts/index.ts` (new)
- `src/indexer/lib/sources/index.ts` (update export)

**Why:** ContextArtifactSource bridges the context config to the indexer pipeline. It implements `IndexerSource` so the existing `Indexer` class can chunk and embed artifacts without any changes to the core sync pipeline.

**Details:**

Create `src/indexer/lib/context-artifacts/context-artifact-source.ts`:

The source reads `.genesistoolscontext.json`, loads each artifact's content (file or directory), and exposes it through `scan()` / `detectChanges()`.

Key behaviors:
- `scan()`: For each artifact in config, read file content (or concatenate directory contents like SC does, with `# -- filename --` headers). Return one `SourceEntry` per artifact with `id = "context::<name>"`, `path = artifact.path`, `content = loaded text`.
- For directory artifacts: recursively read all text files, skip binary/unreadable, sort deterministically, concatenate with headers. Skip `node_modules`, `.git`.
- `hashEntry()`: SHA-256 of content, truncated to 16 hex chars (matching SC's approach).
- `detectChanges()`: Use `defaultDetectChanges` from `source.ts` -- the existing change detection works perfectly since we hash content.
- `estimateTotal()`: Return count of artifacts from config.
- Store the config path as constructor argument so the source knows where to look.

```typescript
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import {
    type DetectChangesOptions,
    defaultDetectChanges,
    type IndexerSource,
    type ScanOptions,
    type SourceChanges,
    type SourceEntry,
} from "../sources/source";
import { loadContextConfig } from "./config";
import type { ContextArtifact } from "./types";

export class ContextArtifactSource implements IndexerSource {
    private projectPath: string;

    constructor(projectPath: string) {
        this.projectPath = path.resolve(projectPath);
    }

    async scan(opts?: ScanOptions): Promise<SourceEntry[]> {
        const config = await loadContextConfig(this.projectPath);

        if (!config?.artifacts?.length) {
            return [];
        }

        const entries: SourceEntry[] = [];
        let count = 0;

        for (const artifact of config.artifacts) {
            if (opts?.limit && count >= opts.limit) {
                break;
            }

            const content = await this.readArtifactContent(artifact);
            const entry: SourceEntry = {
                id: `context::${artifact.name}`,
                content,
                path: artifact.path,
                metadata: {
                    artifactName: artifact.name,
                    artifactDescription: artifact.description,
                    type: "context-artifact",
                },
            };

            entries.push(entry);
            count++;

            if (opts?.onProgress) {
                opts.onProgress(count, config.artifacts.length);
            }
        }

        if (opts?.onBatch && entries.length > 0) {
            await opts.onBatch(entries);
        }

        return entries;
    }

    detectChanges(opts: DetectChangesOptions): SourceChanges {
        return defaultDetectChanges(opts, this.hashEntry.bind(this));
    }

    hashEntry(entry: SourceEntry): string {
        return createHash("sha256").update(entry.content).digest("hex").slice(0, 16);
    }

    async estimateTotal(): Promise<number> {
        const config = await loadContextConfig(this.projectPath);
        return config?.artifacts?.length ?? 0;
    }

    // -- Private helpers --

    private async readArtifactContent(artifact: ContextArtifact): Promise<string> {
        const resolved = path.isAbsolute(artifact.path)
            ? artifact.path
            : path.resolve(this.projectPath, artifact.path);

        const stat = await fsp.stat(resolved);

        if (stat.isFile()) {
            return fsp.readFile(resolved, "utf-8");
        }

        if (stat.isDirectory()) {
            return this.readDirectoryContent(resolved);
        }

        throw new Error(
            `Artifact "${artifact.name}": path is neither file nor directory: ${resolved}`
        );
    }

    private async readDirectoryContent(dirPath: string): Promise<string> {
        const { glob } = await import("glob");
        const files = await glob("**/*", {
            cwd: dirPath,
            nodir: true,
            dot: false,
            ignore: ["**/node_modules/**", "**/.git/**"],
        });

        files.sort();

        const parts: string[] = [];

        for (const file of files) {
            const filePath = path.join(dirPath, file);

            try {
                const content = await fsp.readFile(filePath, "utf-8");
                parts.push(`# -- ${file} --\n${content}`);
            } catch {
                // Skip unreadable files (binary, permissions)
            }
        }

        if (parts.length === 0) {
            throw new Error(`Artifact directory contains no readable files: ${dirPath}`);
        }

        return parts.join("\n\n");
    }
}
```

Create `src/indexer/lib/context-artifacts/index.ts` to re-export:

```typescript
export { ContextArtifactSource } from "./context-artifact-source";
export { loadContextConfig, CONFIG_FILENAME } from "./config";
export type { ContextArtifact, ArtifactIndexState, ContextConfig } from "./types";
```

**Tests:** `src/indexer/lib/context-artifacts/context-artifact-source.test.ts` -- test scan with single file artifact, directory artifact, empty config, change detection (added/modified/unchanged/deleted), hashEntry consistency.

**Commit:** `feat(indexer): add ContextArtifactSource implementing IndexerSource`

---

## Task 3: Integrate into IndexerManager -- auto-detect `.genesistoolscontext.json`

**Files:**
- `src/indexer/lib/manager.ts` (update)
- `src/indexer/lib/indexer.ts` (update source resolution in `Indexer.create()`)

**Why:** When a user indexes a directory that contains `.genesistoolscontext.json`, context artifacts should be indexed alongside the code automatically. This is done by creating a companion context index.

**Design decision:** Use a **separate internal index** approach rather than mixing artifacts into the code index. This keeps the code index clean and allows independent staleness detection. The artifacts index is named `<code-index-name>__context` and is auto-created/synced alongside the main index.

**Details:**

In `IndexerManager.addIndex()`:
- After creating the main index, check if `config.baseDir` contains `.genesistoolscontext.json`.
- If so, auto-create a companion context index with:
  - `name: "${config.name}__context"`
  - `baseDir: config.baseDir`
  - `type: "files"` (context artifacts are text)
  - `source: new ContextArtifactSource(config.baseDir)`
  - `chunking: "auto"` (line-based chunking works for SQL, YAML, Markdown, etc.)
  - Same embedding config as the parent index
- Store the relationship in the manager config so `removeIndex` also removes the companion.

In `IndexerManager.syncAll()`:
- Context indexes are synced alongside their parent.

In `IndexerManager.removeIndex()`:
- If removing an index that has a `__context` companion, remove both.

In `IndexerManager.listIndexes()`:
- Companion context indexes are included in the list but can be identified by the `__context` suffix.

In `Indexer.create()` (source resolution, around line 107-121):
- No changes needed -- it already respects `config.source` at line 109. The manager passes `ContextArtifactSource` as `config.source`.

**Tests:** Unit test: create index on a dir with `.genesistoolscontext.json`, verify companion index is created, verify remove cleans up both.

**Commit:** `feat(indexer): auto-detect .genesistoolscontext.json and index context artifacts`

---

## Task 4: Add `tools indexer context` CLI command

**Files:**
- `src/indexer/commands/context.ts` (new)
- `src/indexer/index.ts` (register new command)

**Why:** Users need a CLI to manage context artifacts: list what's configured, add new artifacts, remove artifacts, and trigger re-indexing.

**Details:**

Subcommands:
1. `tools indexer context list [index-name]` -- Show configured artifacts and their index status.
2. `tools indexer context add <index-name> --name <name> --path <path> --description <desc>` -- Add an artifact to `.genesistoolscontext.json` in the index's baseDir. Creates the file if it doesn't exist.
3. `tools indexer context remove <index-name> --name <name>` -- Remove an artifact from the config file.
4. `tools indexer context sync [index-name]` -- Force re-index of context artifacts.

Implementation pattern follows existing commands (use `@clack/prompts`, `commander`, `picocolors`).

For `context list`:
- Load the manager, find the index config to get `baseDir`.
- Load `.genesistoolscontext.json` from `baseDir`.
- If a companion `__context` index exists, show per-artifact staleness by comparing current content hash vs stored path hashes.
- Display table: Name | Path | Description | Status (indexed/stale/new).

For `context add`:
- Read or create `.genesistoolscontext.json` in the index's `baseDir`.
- Validate the artifact path exists.
- Append to the `artifacts` array, write back.
- Optionally trigger sync of the companion context index.

For `context remove`:
- Remove from the config file.
- If companion index exists, trigger sync (which will detect the deletion via change detection).

For `context sync`:
- Find or create the companion `__context` index, run sync.

Register in `src/indexer/index.ts`:
```typescript
import { registerContextCommand } from "./commands/context";
// ...
registerContextCommand(program);
```

**Tests:** No automated tests for CLI commands (consistent with existing command files). Manual testing.

**Commit:** `feat(indexer): add tools indexer context CLI for artifact management`

---

## Task 5: Auto-resume interrupted indexes on `IndexerManager.load()`

**Files:**
- `src/indexer/lib/manager.ts` (update `load()` and add private field + getter)

**Why:** When the indexer process is killed during a sync (Ctrl+C, crash, OOM), the `indexingStatus` is left as `"in-progress"`. On next `load()`, we should detect this and expose it to callers. This is inspired by SC's `autoResumeIndexedProjects()` but adapted to our simpler architecture.

**Details:**

Current `IndexerManager.load()`:
```typescript
static async load(): Promise<IndexerManager> {
    const storage = new Storage("indexer");
    await storage.ensureDirs();
    const manager = new IndexerManager(storage);
    return manager;
}
```

Updated -- add auto-resume detection (non-blocking, just populates a list):

```typescript
private _interruptedOnLoad: Array<{ name: string; meta: IndexMeta }> = [];

static async load(): Promise<IndexerManager> {
    const storage = new Storage("indexer");
    await storage.ensureDirs();
    const manager = new IndexerManager(storage);
    manager._interruptedOnLoad = manager.getInterruptedIndexes();
    return manager;
}

/** Indexes that were interrupted when the manager loaded. Empty after first access. */
get interruptedOnLoad(): Array<{ name: string; meta: IndexMeta }> {
    const result = this._interruptedOnLoad;
    this._interruptedOnLoad = [];
    return result;
}
```

The `getInterruptedIndexes()` method already exists (lines 175-180). We call it at load time and expose the result.

**Caller-side handling** (in CLI commands that use the manager):

In `sync.ts` and `watch.ts`:
- After `IndexerManager.load()`, check `manager.interruptedOnLoad`.
- If non-empty, log a warning: "Detected N interrupted index(es): X, Y. Resuming..."
- Automatically call `manager.resumeIndex(name, callbacks)` for each.

This is a lightweight approach: the manager detects, the commands decide what to do. No background async magic.

**Tests:** `src/indexer/lib/auto-resume.test.ts` -- verify `interruptedOnLoad` returns indexes with `in-progress`/`cancelled` status, verify it's empty after first access.

**Commit:** `feat(indexer): auto-detect interrupted indexes on manager load`

---

## Task 6: Infrastructure-aware watcher back-off

**Files:**
- `src/utils/fs/watcher.ts` (update)
- `src/indexer/lib/indexer.ts` (update watcher error handling)

**Why:** When the watcher's callback sync fails due to transient infrastructure errors (ECONNREFUSED from Qdrant, DNS timeouts, network blips), the current circuit breaker increments `consecutiveErrors` toward the `maxErrors` limit (10), then kills the watcher permanently. Infrastructure errors should instead pause and retry, not count toward the circuit breaker.

**Details:**

Add a new exported utility function to classify errors:

In `src/utils/fs/watcher.ts`:
```typescript
/** Classify whether an error is a transient infrastructure issue */
export function isTransientError(err: unknown): boolean {
    if (!(err instanceof Error)) {
        return false;
    }

    const msg = err.message.toLowerCase();
    const code = (err as NodeJS.ErrnoException).code;

    // Network/infra errors by error code
    if (code === "ECONNREFUSED" || code === "ECONNRESET" ||
        code === "ENOTFOUND" || code === "ETIMEDOUT" ||
        code === "EPIPE" || code === "EAI_AGAIN") {
        return true;
    }

    // Common transient patterns in error messages
    if (msg.includes("econnrefused") || msg.includes("dns") ||
        msg.includes("timeout") || msg.includes("network") ||
        msg.includes("connection reset") || msg.includes("socket hang up")) {
        return true;
    }

    return false;
}
```

Update `WatcherOptions` to add:
```typescript
/** Pause duration for transient infrastructure errors (ms). Default: 30000 */
transientBackoffMs?: number;
/** Callback when a transient error causes back-off */
onTransientError?: (err: Error, backoffMs: number) => void;
```

Update the `flushEvents` function in `createWatcher`:
- In the catch block, check `isTransientError(err)`.
- If transient: call `onTransientError` if provided, schedule a retry after `transientBackoffMs` (default 30s), do NOT increment `consecutiveErrors`.
- If not transient: increment `consecutiveErrors` as before.

In `src/indexer/lib/indexer.ts`, update `startWatch()` (around line 283):
- Pass `onTransientError` callback that emits a `sync:error` event with a descriptive message like "Transient error, retrying in 30s: <message>".

**Tests:** `src/utils/fs/watcher.test.ts` (new) -- test `isTransientError` classification for known error codes (ECONNREFUSED, ETIMEDOUT, ENOTFOUND) and messages. Test non-transient errors (TypeError, generic Error) return false.

**Commit:** `feat(indexer): infrastructure-aware watcher back-off for transient errors`

---

## Task 7: Add `.genesistoolsignore` support

**Files:**
- `src/indexer/lib/sources/file-source.ts` (update)

**Why:** Users need a project-level ignore file (like `.gitignore` but for the indexer) to exclude files/dirs that aren't in `.gitignore` but shouldn't be indexed. SC has `.socraticodeignore`; we need `.genesistoolsignore`.

**Details:**

Install the `ignore` npm package:
```bash
bun add ignore
```

Update `FileSource` constructor and scan/filter logic:

1. In constructor, check for `.genesistoolsignore` in `baseDir`.
2. If it exists, read it and create an `Ignore` instance from the `ignore` package.
3. In both `walkDirectory()` and after `getGitTrackedFiles()`, filter out paths that match the ignore rules.
4. The ignore filter applies AFTER `.gitignore` (when `respectGitIgnore` is enabled), adding additional exclusions.

```typescript
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ignore, { type Ignore } from "ignore";

// In the class:
private ignoreFilter: Ignore | null = null;

constructor(opts: FileSourceOptions) {
    this.opts = opts;
    this.absBaseDir = resolve(opts.baseDir);
    this.ignoreFilter = this.loadIgnoreFile();
}

private loadIgnoreFile(): Ignore | null {
    const ignorePath = join(this.absBaseDir, ".genesistoolsignore");

    try {
        const content = readFileSync(ignorePath, "utf-8");
        return ignore().add(content);
    } catch {
        return null;
    }
}

private isIgnoredByFilter(absolutePath: string): boolean {
    if (!this.ignoreFilter) {
        return false;
    }

    const rel = relative(this.absBaseDir, absolutePath);
    return this.ignoreFilter.ignores(rel);
}
```

Then in `scan()`, after existing `ignoredPaths` filter, add:
```typescript
if (this.ignoreFilter) {
    filePaths = filePaths.filter((f) => !this.isIgnoredByFilter(f));
}
```

Apply the same filter in `estimateTotal()`.

**Tests:** Add tests to `src/indexer/lib/sources/file-source.test.ts`:
- Create a `.genesistoolsignore` with patterns, verify matching files are excluded from scan.
- Test glob patterns (e.g. `*.log`, `docs/`).
- Test that it works alongside `ignoredPaths` option (both filters applied).

**Commit:** `feat(indexer): add .genesistoolsignore support for project-level ignore rules`

---

## Task 8: Tests for all new features

**Files:**
- `src/indexer/lib/context-artifacts/config.test.ts` (new -- if not created in Task 1)
- `src/indexer/lib/context-artifacts/context-artifact-source.test.ts` (new -- if not created in Task 2)
- `src/utils/fs/watcher.test.ts` (new -- if not created in Task 6)
- `src/indexer/lib/auto-resume.test.ts` (new)

**Why:** Ensure all new features have test coverage using the existing `bun:test` patterns.

**Details:**

### config.test.ts
```typescript
import { describe, expect, it, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadContextConfig } from "./config";

describe("loadContextConfig", () => {
    let tmpDir: string;

    afterEach(() => {
        if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns null when config file does not exist", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "ctx-"));
        const result = await loadContextConfig(tmpDir);
        expect(result).toBeNull();
    });

    it("parses valid config", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "ctx-"));
        writeFileSync(
            join(tmpDir, ".genesistoolscontext.json"),
            JSON.stringify({
                artifacts: [{ name: "schema", path: "db/schema.sql", description: "DB schema" }],
            })
        );
        const result = await loadContextConfig(tmpDir);
        expect(result?.artifacts).toHaveLength(1);
        expect(result!.artifacts![0].name).toBe("schema");
    });

    it("throws on invalid JSON", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "ctx-"));
        writeFileSync(join(tmpDir, ".genesistoolscontext.json"), "not json{");
        await expect(loadContextConfig(tmpDir)).rejects.toThrow("not valid JSON");
    });

    it("throws on missing required fields", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "ctx-"));
        writeFileSync(
            join(tmpDir, ".genesistoolscontext.json"),
            JSON.stringify({ artifacts: [{ name: "x" }] })
        );
        await expect(loadContextConfig(tmpDir)).rejects.toThrow("path must be a non-empty string");
    });

    it("throws on duplicate artifact names", async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "ctx-"));
        writeFileSync(
            join(tmpDir, ".genesistoolscontext.json"),
            JSON.stringify({
                artifacts: [
                    { name: "schema", path: "a.sql", description: "First" },
                    { name: "Schema", path: "b.sql", description: "Duplicate" },
                ],
            })
        );
        await expect(loadContextConfig(tmpDir)).rejects.toThrow("duplicate artifact name");
    });
});
```

### context-artifact-source.test.ts
- Test `scan()` with a file artifact (write a temp .sql file, verify SourceEntry content).
- Test `scan()` with a directory artifact (write multiple files, verify concatenation with `# --` headers).
- Test `hashEntry()` returns consistent hash for same content.
- Test `detectChanges()` identifies added/modified/deleted artifacts.
- Test empty config returns empty entries from scan().

### watcher.test.ts
- Test `isTransientError()` returns true for ECONNREFUSED, ETIMEDOUT, ENOTFOUND error codes.
- Test `isTransientError()` returns true for message-based detection ("connection reset", "timeout").
- Test `isTransientError()` returns false for non-transient errors (TypeError, generic Error without network keywords).
- Test `isTransientError()` returns false for non-Error values (strings, numbers).

### auto-resume.test.ts
- Test that the `getInterruptedIndexes` filter logic (extracted, same pattern as `status.test.ts`) returns indexes with `in-progress`/`cancelled` status.
- Test that `completed`/`idle`/`undefined` status indexes are not included.
- Test empty index list returns empty.

Run all tests:
```bash
bun test src/indexer/lib/context-artifacts/ src/utils/fs/watcher.test.ts src/indexer/lib/auto-resume.test.ts
```

**Commit:** `test(indexer): add tests for context artifacts, watcher back-off, and auto-resume`

---

## Task 9: Simplify -- review ALL files for reuse, quality, efficiency

**Files:** All files created/modified in Tasks 1-8.

**Why:** Final quality pass to ensure DRY code, consistent patterns, proper types, and no regressions.

**Checklist:**

1. **DRY review:**
   - Is `readArtifactContent` / `readDirectoryContent` in `ContextArtifactSource` similar enough to any existing util to extract? Check `src/utils/fs/` for an existing "read directory as concatenated text" helper. If the logic is artifact-specific, leave it in the source.
   - Is the config validation in `config.ts` following a reusable pattern? Could use Zod if already a dependency (check), otherwise manual validation is fine and consistent with the codebase.
   - Are the ignore file loading patterns in `FileSource` consistent with how SC loads `.socraticodeignore`?

2. **Type safety:**
   - No `as any` -- verify all casts use proper interfaces.
   - No inline type casts like `as Array<{...}>`.
   - Proper return types on all exported functions.

3. **Code style (per CLAUDE.md):**
   - No one-line `if` statements -- always block form with braces.
   - Empty line before `if` (unless preceded by a variable used in the `if`).
   - Empty line after `}` (unless followed by `else`/`catch`/`}`).
   - No file-path comments at top of files.
   - No obvious/restating comments.
   - 3+ params use object form, 1-2 required params use positional.

4. **Error handling:**
   - All new async operations have proper try/catch.
   - Error messages are descriptive and actionable.
   - Transient vs permanent error classification is correct and comprehensive.

5. **Performance:**
   - `ContextArtifactSource.scan()` loads config only once per scan call (not per artifact).
   - Directory artifact reading uses sorted deterministic ordering.
   - Ignore filter in `FileSource` is loaded once in constructor, not per-file.

6. **Consistency with existing code:**
   - New source follows exact same patterns as `FileSource`, `MailSource`, `TelegramSource`.
   - New command follows exact same patterns as `add.ts`, `sync.ts`, `watch.ts`.
   - Test patterns match existing tests (tmpdir setup, afterEach cleanup, `bun:test` imports).

7. **Exports:**
   - `src/indexer/lib/context-artifacts/index.ts` exports all public types and classes.
   - No circular imports between context-artifacts and sources modules.

8. **Run lint and type check:**
   ```bash
   bunx biome check src/indexer/lib/context-artifacts/ src/utils/fs/watcher.ts
   tsgo --noEmit | rg "context-artifacts|watcher"
   ```

9. **Run all indexer tests to verify no regressions:**
   ```bash
   bun test src/indexer/
   ```

**Commit:** `refactor(indexer): simplify and clean up Plan 9 implementation`
