# Debugging Master Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an LLM debugging toolkit — instrumentation snippets + token-efficient CLI log reader with sessions, refs, JMESPath, and guided UX.

**Architecture:** Copy-paste instrumentation snippets (TS/PHP) write JSONL to `~/.genesis-tools/debugging-master/sessions/`. CLI reader parses JSONL with 3-level output (L1 compact → L2 schema → L3 full), reference system for large values, JMESPath queries. Optional HTTP server mode for browser/inline debugging. All commands use `--session` with fuzzy matching, default to most recent.

**Tech Stack:** Bun, Commander, @clack/prompts, @jmespath-community/jmespath, chalk. Zero deps for snippets.

**Design doc:** `docs/plans/2026-02-19-debugging-master-design.md`

---

## Phase 1: Foundation

### Task 1: Install JMESPath dependency

**Step 1: Install**

```bash
bun add @jmespath-community/jmespath
```

**Step 2: Verify import works**

```bash
bun -e "import { search } from '@jmespath-community/jmespath'; console.log(search({a:[{b:1},{b:2}]}, 'a[*].b'))"
```

Expected: `[1, 2]`

**Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: add jmespath dependency for debugging-master"
```

---

### Task 2: Types

**Files:**
- Create: `src/debugging-master/types.ts`

**Step 1: Write types**

```typescript
/** Log entry levels */
export type LogLevel =
  | "dump"
  | "info"
  | "warn"
  | "error"
  | "timer-start"
  | "timer-end"
  | "checkpoint"
  | "assert"
  | "snapshot"
  | "trace"
  | "raw";

/** A single log entry in the JSONL file */
export interface LogEntry {
  level: LogLevel;
  label?: string;
  msg?: string;
  data?: unknown;
  vars?: Record<string, unknown>;
  stack?: string;
  passed?: boolean;
  ctx?: unknown;
  durationMs?: number;
  ts: number;
  file?: string;
  line?: number;
  h?: string; // hypothesis tag
}

/** Indexed entry with computed fields for display */
export interface IndexedLogEntry extends LogEntry {
  index: number;
  refId?: string; // assigned ref ID if value was large
}

/** Timer pair (matched start + end) */
export interface TimerPair {
  label: string;
  startTs: number;
  endTs: number;
  durationMs: number;
  startIndex: number;
  endIndex: number;
}

/** Session summary stats */
export interface SessionStats {
  entryCount: number;
  levelCounts: Record<string, number>;
  timerPairs: TimerPair[];
  avgTimerMs: number;
  assertsPassed: number;
  assertsFailed: number;
  startTime: number;
  endTime: number;
  spanMs: number;
  files: string[];
}

/** Project config entry */
export interface ProjectConfig {
  snippetPath: string;
  language: "typescript" | "php";
}

/** Global debugging-master config */
export interface DebugMasterConfig {
  projects: Record<string, ProjectConfig>;
  recentSession?: string;
}

/** Session metadata (stored alongside JSONL) */
export interface SessionMeta {
  name: string;
  projectPath: string;
  createdAt: number;
  lastActivityAt: number;
  serve?: boolean;
  port?: number;
}

/** Output format options */
export type OutputFormat = "ai" | "json" | "md";

/** Global CLI options available to all commands */
export interface GlobalOptions {
  session?: string;
  format: OutputFormat;
  pretty?: boolean;
  verbose?: boolean;
}
```

**Step 2: Commit**

```bash
git add src/debugging-master/types.ts
git commit -m "feat(debugging-master): add type definitions"
```

---

### Task 3: Extract shared reference system from har-analyzer

**Files:**
- Create: `src/utils/references.ts`
- Modify: `src/har-analyzer/core/ref-store.ts` (update to import from shared util)

The har-analyzer has a `RefStoreManager` in `src/har-analyzer/core/ref-store.ts`. Extract the core ref logic (threshold, preview generation, format/expand) into a shared utility.

**Step 1: Create shared references utility**

Read `src/har-analyzer/core/ref-store.ts` fully. Extract into `src/utils/references.ts`:

```typescript
import { Storage } from "@app/utils/storage/storage";
import { formatBytes } from "@app/utils/format";

export interface RefEntry {
  preview: string;
  size: number;
  shown: boolean;
}

export interface RefStore {
  refs: Record<string, RefEntry>;
}

export const REF_THRESHOLD = 200;
export const PREVIEW_LENGTH = 80;

/**
 * Generate a smart preview of a value, truncating at natural breaks.
 */
export function generatePreview(value: string): string {
  if (value.length <= PREVIEW_LENGTH) return value;
  let cutoff = PREVIEW_LENGTH;
  const breakChars = [" ", ",", "]", "}", ")"];
  for (let i = cutoff - 1; i >= Math.floor(cutoff * 0.5); i--) {
    if (breakChars.includes(value[i])) {
      cutoff = i + 1;
      break;
    }
  }
  return `${value.slice(0, cutoff)}...`;
}

/**
 * Format a value with ref system. Returns formatted string.
 * - Values < REF_THRESHOLD: returned as-is
 * - First show: full value + ref tag
 * - Subsequent: compact ref + preview + size
 */
export function formatValueWithRef(
  value: string,
  refId: string,
  refs: RefStore,
  options?: { full?: boolean },
): string {
  if (options?.full) return value;
  if (value.length < REF_THRESHOLD) return value;

  const existing = refs.refs[refId];
  if (existing?.shown) {
    return `[ref:${refId}] ${existing.preview} (${formatBytes(value.length)})`;
  }

  const preview = generatePreview(value);
  refs.refs[refId] = { preview, size: value.length, shown: true };
  return `[ref:${refId}] ${value}`;
}

/**
 * Manages ref persistence for a session. Wraps Storage.
 */
export class RefStoreManager {
  private storage: Storage;
  private sessionId: string;
  private refs: RefStore | null = null;

  constructor(toolName: string, sessionId: string) {
    this.storage = new Storage(toolName);
    this.sessionId = sessionId;
  }

  async load(): Promise<RefStore> {
    if (this.refs) return this.refs;
    const cached = await this.storage.getCacheFile<RefStore>(
      `refs/${this.sessionId}.json`,
      "1 day",
    );
    this.refs = cached ?? { refs: {} };
    return this.refs;
  }

  async save(): Promise<void> {
    if (!this.refs) return;
    await this.storage.putCacheFile(
      `refs/${this.sessionId}.json`,
      this.refs,
      "1 day",
    );
  }

  async formatValue(value: string, refId: string, options?: { full?: boolean }): Promise<string> {
    const store = await this.load();
    return formatValueWithRef(value, refId, store, options);
  }
}
```

**Step 2: Update har-analyzer to import from shared util**

Modify `src/har-analyzer/core/ref-store.ts` to re-export from the shared util or delegate to it. Keep the har-analyzer's public API unchanged — it should still export `RefStoreManager` but backed by the shared code.

Check how har-analyzer currently instantiates: `new RefStoreManager(sessionHash)`. The shared version takes `(toolName, sessionId)`. Create a thin wrapper:

```typescript
import { RefStoreManager as SharedRefStoreManager } from "@app/utils/references";

export class RefStoreManager extends SharedRefStoreManager {
  constructor(sessionHash: string) {
    super("har-analyzer", sessionHash);
  }
}
```

**Step 3: Verify har-analyzer still works**

```bash
tools har-analyzer --help
```

Should show help without errors.

**Step 4: Commit**

```bash
git add src/utils/references.ts src/har-analyzer/core/ref-store.ts
git commit -m "refactor: extract shared reference system from har-analyzer"
```

---

### Task 4: Fuzzy session matching utility

**Files:**
- Modify: `src/utils/string.ts` (add `fuzzyMatch` function)

**Step 1: Add fuzzy match to string utils**

Append to `src/utils/string.ts`:

```typescript
/**
 * Simple fuzzy match: checks if all characters of `query` appear
 * in `target` in order (case-insensitive). Returns match score
 * (lower = better, -1 = no match).
 */
export function fuzzyMatch(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  // Exact match or prefix match = best score
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  if (t.includes(q)) return 2;

  // Subsequence match
  let qi = 0;
  let gaps = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
    } else if (qi > 0) {
      gaps++;
    }
  }
  if (qi < q.length) return -1; // not all chars matched
  return 3 + gaps;
}

/**
 * Find the best fuzzy match from a list of candidates.
 * Returns null if no match found.
 */
export function fuzzyFind(query: string, candidates: string[]): string | null {
  let bestScore = Infinity;
  let bestMatch: string | null = null;
  for (const c of candidates) {
    const score = fuzzyMatch(query, c);
    if (score >= 0 && score < bestScore) {
      bestScore = score;
      bestMatch = c;
    }
  }
  return bestMatch;
}
```

**Step 2: Verify**

```bash
bun -e "
import { fuzzyMatch, fuzzyFind } from './src/utils/string';
console.log(fuzzyMatch('fix-au', 'fix-auth-bug'));     // should be 2 (contains)
console.log(fuzzyFind('fix-au', ['fix-auth-bug', 'perf-issue', 'fix-auth-login'])); // fix-auth-bug
"
```

**Step 3: Commit**

```bash
git add src/utils/string.ts
git commit -m "feat(utils): add fuzzy matching to string utils"
```

---

### Task 5: Config manager

**Files:**
- Create: `src/debugging-master/core/config-manager.ts`

**Step 1: Write config manager**

```typescript
import { Storage } from "@app/utils/storage/storage";
import type { DebugMasterConfig, ProjectConfig } from "@app/debugging-master/types";

const CONFIG_FILE = "config.json";

export class ConfigManager {
  private storage: Storage;
  private config: DebugMasterConfig | null = null;

  constructor() {
    this.storage = new Storage("debugging-master");
  }

  async load(): Promise<DebugMasterConfig> {
    if (this.config) return this.config;
    await this.storage.ensureDirs();
    const cached = await this.storage.getCacheFile<DebugMasterConfig>(CONFIG_FILE, "1 year");
    this.config = cached ?? { projects: {} };
    return this.config;
  }

  async save(): Promise<void> {
    if (!this.config) return;
    await this.storage.putCacheFile(CONFIG_FILE, this.config, "1 year");
  }

  async getProject(projectPath: string): Promise<ProjectConfig | null> {
    const config = await this.load();
    return config.projects[projectPath] ?? null;
  }

  async setProject(projectPath: string, project: ProjectConfig): Promise<void> {
    const config = await this.load();
    config.projects[projectPath] = project;
    await this.save();
  }

  async getRecentSession(): Promise<string | null> {
    const config = await this.load();
    return config.recentSession ?? null;
  }

  async setRecentSession(name: string): Promise<void> {
    const config = await this.load();
    config.recentSession = name;
    await this.save();
  }

  getStorage(): Storage {
    return this.storage;
  }

  getSessionsDir(): string {
    return `${this.storage.getBaseDir()}/sessions`;
  }
}
```

**Step 2: Commit**

```bash
git add src/debugging-master/core/config-manager.ts
git commit -m "feat(debugging-master): add config manager"
```

---

### Task 6: Session manager

**Files:**
- Create: `src/debugging-master/core/session-manager.ts`

Manages session lifecycle: create, resolve (with fuzzy matching), list, read JSONL.

**Step 1: Write session manager**

```typescript
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { ConfigManager } from "./config-manager";
import { fuzzyFind } from "@app/utils/string";
import { suggestCommand } from "@app/utils/cli/executor";
import type { SessionMeta, LogEntry } from "@app/debugging-master/types";

const TOOL_NAME = "tools debugging-master";
const ACTIVE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

export class SessionManager {
  private config: ConfigManager;

  constructor(config?: ConfigManager) {
    this.config = config ?? new ConfigManager();
  }

  getConfig(): ConfigManager {
    return this.config;
  }

  /** Get the sessions directory, ensure it exists */
  async getSessionsDir(): Promise<string> {
    const dir = this.config.getSessionsDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Create a new session */
  async createSession(name: string, projectPath: string, options?: { serve?: boolean; port?: number }): Promise<string> {
    const dir = await this.getSessionsDir();
    const jsonlPath = join(dir, `${name}.jsonl`);
    const metaPath = join(dir, `${name}.meta.json`);

    // Create empty JSONL file
    await Bun.write(jsonlPath, "");

    // Write session metadata
    const meta: SessionMeta = {
      name,
      projectPath,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      serve: options?.serve,
      port: options?.port,
    };
    await Bun.write(metaPath, JSON.stringify(meta, null, 2));

    // Update recent session
    await this.config.setRecentSession(name);

    return jsonlPath;
  }

  /** Resolve a session name (fuzzy match + recent fallback) */
  async resolveSession(sessionFlag?: string): Promise<string> {
    const sessions = await this.listSessionNames();

    if (sessionFlag) {
      // Exact match first
      if (sessions.includes(sessionFlag)) {
        await this.config.setRecentSession(sessionFlag);
        return sessionFlag;
      }
      // Fuzzy match
      const match = fuzzyFind(sessionFlag, sessions);
      if (match) {
        await this.config.setRecentSession(match);
        return match;
      }
      throw new Error(
        `Session "${sessionFlag}" not found.\n` +
        `Available sessions: ${sessions.join(", ") || "none"}\n` +
        `Tip: ${suggestCommand(TOOL_NAME, { add: ["start", `--session ${sessionFlag}`] })}`
      );
    }

    // No session specified — try recent
    const recent = await this.config.getRecentSession();
    if (recent && sessions.includes(recent)) {
      const meta = await this.getSessionMeta(recent);
      if (meta && Date.now() - meta.lastActivityAt < ACTIVE_THRESHOLD_MS) {
        return recent;
      }
    }

    // Check for active sessions
    const active = await this.getActiveSessions();
    if (active.length === 1) return active[0].name;
    if (active.length > 1) {
      const names = active.map((s) => s.name);
      const suggestions = names
        .map((n) => `  ${suggestCommand(TOOL_NAME, { add: [`--session ${n}`] })}`)
        .join("\n");
      throw new Error(
        `Multiple active sessions. Specify one:\n${suggestions}`
      );
    }

    throw new Error(
      `No active sessions.\n` +
      `Tip: Start one with: ${TOOL_NAME} start --session <name>`
    );
  }

  /** List all session names (from .jsonl files) */
  async listSessionNames(): Promise<string[]> {
    const dir = await this.getSessionsDir();
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => basename(f, ".jsonl"));
    } catch {
      return [];
    }
  }

  /** Get sessions active within the last hour */
  async getActiveSessions(): Promise<SessionMeta[]> {
    const names = await this.listSessionNames();
    const active: SessionMeta[] = [];
    for (const name of names) {
      const meta = await this.getSessionMeta(name);
      if (meta && Date.now() - meta.lastActivityAt < ACTIVE_THRESHOLD_MS) {
        active.push(meta);
      }
    }
    return active;
  }

  /** Get session metadata */
  async getSessionMeta(name: string): Promise<SessionMeta | null> {
    const dir = await this.getSessionsDir();
    const metaPath = join(dir, `${name}.meta.json`);
    try {
      return await Bun.file(metaPath).json();
    } catch {
      return null;
    }
  }

  /** Touch session last activity */
  async touchSession(name: string): Promise<void> {
    const meta = await this.getSessionMeta(name);
    if (!meta) return;
    meta.lastActivityAt = Date.now();
    const dir = await this.getSessionsDir();
    await Bun.write(join(dir, `${name}.meta.json`), JSON.stringify(meta, null, 2));
  }

  /** Read all log entries from a session JSONL */
  async readEntries(name: string): Promise<LogEntry[]> {
    const dir = await this.getSessionsDir();
    const jsonlPath = join(dir, `${name}.jsonl`);
    try {
      const content = await Bun.file(jsonlPath).text();
      if (!content.trim()) return [];
      return content
        .trim()
        .split("\n")
        .map((line, i) => {
          try {
            return JSON.parse(line) as LogEntry;
          } catch {
            return { level: "raw" as const, data: line, ts: Date.now() } satisfies LogEntry;
          }
        });
    } catch {
      return [];
    }
  }

  /** Get path to session JSONL file */
  async getSessionPath(name: string): Promise<string> {
    const dir = await this.getSessionsDir();
    return join(dir, `${name}.jsonl`);
  }
}
```

**Step 2: Verify module resolves**

```bash
bun -e "import { SessionManager } from './src/debugging-master/core/session-manager'; console.log('ok')"
```

**Step 3: Commit**

```bash
git add src/debugging-master/core/session-manager.ts
git commit -m "feat(debugging-master): add session manager with fuzzy resolution"
```

---

## Phase 2: Instrumentation Snippets

### Task 7: TypeScript/JS instrumentation snippet

**Files:**
- Create: `src/utils/debugging-master/llm-log.ts`

This is the self-contained file that gets copied into target projects. **Zero imports from GenesisTools** — it must work standalone.

**Step 1: Write the snippet**

```typescript
/**
 * LLM Debug Logger — self-contained instrumentation for AI-assisted debugging.
 * This file is copied into your project by `tools debugging-master start`.
 * Zero dependencies. Writes JSONL to ~/.genesis-tools/debugging-master/sessions/.
 *
 * Usage:
 *   import { dbg } from './llm-log';
 *   dbg.session('my-session');
 *   dbg.dump('data', myObject);
 *   dbg.checkpoint('after-auth');
 */
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

type Opts = { h?: string };

const SESSIONS_DIR = join(homedir(), ".genesis-tools", "debugging-master", "sessions");

let currentSession = "default";
let sessionPath = "";
const timers: Record<string, number> = {};

function ensureDir(): void {
  if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
}

function getCallerLocation(): { file: string; line: number } {
  const err = new Error();
  const stack = err.stack?.split("\n");
  // Skip: Error, write(), the calling method, => find the user's call site
  const frame = stack?.[4] ?? stack?.[3] ?? "";
  const match = frame.match(/(?:at\s+)?(?:.*?\s+\()?(.+?):(\d+):\d+\)?$/);
  if (match) return { file: match[1], line: Number(match[2]) };
  return { file: "unknown", line: 0 };
}

function write(entry: Record<string, unknown>): void {
  if (!sessionPath) {
    ensureDir();
    sessionPath = join(SESSIONS_DIR, `${currentSession}.jsonl`);
  }
  const loc = getCallerLocation();
  const line = JSON.stringify({ ...entry, ts: Date.now(), file: loc.file, line: loc.line });
  appendFileSync(sessionPath, line + "\n");
}

export const dbg = {
  /** Set the session name. Call once at the top of your entry point. */
  session(name: string): void {
    currentSession = name;
    sessionPath = "";
  },

  /** Capture a full data dump. */
  dump(label: string, data: unknown, opts?: Opts): void {
    write({ level: "dump", label, data, ...opts });
  },

  /** Log an informational message. */
  info(msg: string, data?: unknown, opts?: Opts): void {
    write({ level: "info", msg, data, ...opts });
  },

  /** Log a warning. */
  warn(msg: string, data?: unknown, opts?: Opts): void {
    write({ level: "warn", msg, data, ...opts });
  },

  /** Log an error with optional Error object for stack capture. */
  error(msg: string, err?: Error | unknown, opts?: Opts): void {
    const stack = err instanceof Error ? err.stack : undefined;
    const data = err instanceof Error ? { message: err.message } : err;
    write({ level: "error", msg, stack, data, ...opts });
  },

  /** Start a timer. */
  timerStart(label: string): void {
    timers[label] = Date.now();
    write({ level: "timer-start", label });
  },

  /** End a timer. Computes duration from matching timerStart. */
  timerEnd(label: string): void {
    const start = timers[label];
    const durationMs = start ? Date.now() - start : -1;
    delete timers[label];
    write({ level: "timer-end", label, durationMs });
  },

  /** Mark a point in execution flow. */
  checkpoint(label: string): void {
    write({ level: "checkpoint", label });
  },

  /** Conditional log — only writes if condition is false (assertion failed). Always records result. */
  assert(condition: boolean, label: string, ctx?: unknown): void {
    write({ level: "assert", label, passed: condition, ctx });
  },

  /** Capture multiple variables at once. Pass an object: dbg.snapshot('state', { a, b, c }) */
  snapshot(label: string, vars: Record<string, unknown>, opts?: Opts): void {
    write({ level: "snapshot", label, vars, ...opts });
  },

  /** Trace execution flow with optional data. */
  trace(label: string, data?: unknown, opts?: Opts): void {
    write({ level: "trace", label, data, ...opts });
  },
};
```

**Step 2: Test it locally**

```bash
bun -e "
import { dbg } from './src/utils/debugging-master/llm-log';
dbg.session('test-snippet');
dbg.info('hello from test');
dbg.dump('testData', { a: 1, b: [2, 3] });
dbg.timerStart('op');
dbg.timerEnd('op');
dbg.checkpoint('done');
"
cat ~/.genesis-tools/debugging-master/sessions/test-snippet.jsonl | head -5
```

Expected: 5 JSONL lines with correct levels, labels, timestamps, and file/line info.

**Step 3: Clean up test session**

```bash
rm ~/.genesis-tools/debugging-master/sessions/test-snippet.jsonl
```

**Step 4: Commit**

```bash
git add src/utils/debugging-master/llm-log.ts
git commit -m "feat(debugging-master): add TypeScript instrumentation snippet"
```

---

### Task 8: PHP instrumentation snippet

**Files:**
- Create: `src/utils/debugging-master/llm-log.php`

Same concept as the TS snippet but for PHP. Static class `LlmLog`.

**Step 1: Write the PHP snippet**

```php
<?php
/**
 * LLM Debug Logger — self-contained instrumentation for AI-assisted debugging.
 * This file is copied into your project by `tools debugging-master start`.
 * Zero dependencies. Writes JSONL to ~/.genesis-tools/debugging-master/sessions/.
 *
 * Usage:
 *   require_once __DIR__ . '/llm-log.php';
 *   LlmLog::session('my-session');
 *   LlmLog::dump('data', $myObject);
 *   LlmLog::checkpoint('after-auth');
 */

class LlmLog
{
    private static string $currentSession = 'default';
    private static string $sessionPath = '';
    /** @var array<string, float> */
    private static array $timers = [];
    private static string $sessionsDir = '';

    private static function getSessionsDir(): string
    {
        if (!self::$sessionsDir) {
            $home = getenv('HOME') ?: getenv('USERPROFILE') ?: '/tmp';
            self::$sessionsDir = $home . '/.genesis-tools/debugging-master/sessions';
        }
        if (!is_dir(self::$sessionsDir)) {
            mkdir(self::$sessionsDir, 0755, true);
        }
        return self::$sessionsDir;
    }

    private static function getCallerLocation(): array
    {
        $trace = debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS, 3);
        $caller = $trace[1] ?? $trace[0] ?? [];
        return [
            'file' => $caller['file'] ?? 'unknown',
            'line' => $caller['line'] ?? 0,
        ];
    }

    private static function write(array $entry): void
    {
        if (!self::$sessionPath) {
            self::$sessionPath = self::getSessionsDir() . '/' . self::$currentSession . '.jsonl';
        }
        $loc = self::getCallerLocation();
        $entry['ts'] = (int)(microtime(true) * 1000);
        $entry['file'] = $loc['file'];
        $entry['line'] = $loc['line'];
        file_put_contents(self::$sessionPath, json_encode($entry) . "\n", FILE_APPEND | LOCK_EX);
    }

    public static function session(string $name): void
    {
        self::$currentSession = $name;
        self::$sessionPath = '';
    }

    public static function dump(string $label, mixed $data, ?string $h = null): void
    {
        $entry = ['level' => 'dump', 'label' => $label, 'data' => $data];
        if ($h !== null) $entry['h'] = $h;
        self::write($entry);
    }

    public static function info(string $msg, mixed $data = null, ?string $h = null): void
    {
        $entry = ['level' => 'info', 'msg' => $msg];
        if ($data !== null) $entry['data'] = $data;
        if ($h !== null) $entry['h'] = $h;
        self::write($entry);
    }

    public static function warn(string $msg, mixed $data = null, ?string $h = null): void
    {
        $entry = ['level' => 'warn', 'msg' => $msg];
        if ($data !== null) $entry['data'] = $data;
        if ($h !== null) $entry['h'] = $h;
        self::write($entry);
    }

    public static function error(string $msg, ?\Throwable $err = null, ?string $h = null): void
    {
        $entry = ['level' => 'error', 'msg' => $msg];
        if ($err !== null) {
            $entry['stack'] = $err->getTraceAsString();
            $entry['data'] = ['message' => $err->getMessage(), 'code' => $err->getCode()];
        }
        if ($h !== null) $entry['h'] = $h;
        self::write($entry);
    }

    public static function timerStart(string $label): void
    {
        self::$timers[$label] = microtime(true) * 1000;
        self::write(['level' => 'timer-start', 'label' => $label]);
    }

    public static function timerEnd(string $label): void
    {
        $start = self::$timers[$label] ?? null;
        $durationMs = $start !== null ? round(microtime(true) * 1000 - $start) : -1;
        unset(self::$timers[$label]);
        self::write(['level' => 'timer-end', 'label' => $label, 'durationMs' => $durationMs]);
    }

    public static function checkpoint(string $label): void
    {
        self::write(['level' => 'checkpoint', 'label' => $label]);
    }

    public static function assert(bool $condition, string $label, mixed $ctx = null): void
    {
        $entry = ['level' => 'assert', 'label' => $label, 'passed' => $condition];
        if ($ctx !== null) $entry['ctx'] = $ctx;
        self::write($entry);
    }

    public static function snapshot(string $label, array $vars, ?string $h = null): void
    {
        $entry = ['level' => 'snapshot', 'label' => $label, 'vars' => $vars];
        if ($h !== null) $entry['h'] = $h;
        self::write($entry);
    }

    public static function trace(string $label, mixed $data = null, ?string $h = null): void
    {
        $entry = ['level' => 'trace', 'label' => $label];
        if ($data !== null) $entry['data'] = $data;
        if ($h !== null) $entry['h'] = $h;
        self::write($entry);
    }
}
```

**Step 2: Commit**

```bash
git add src/utils/debugging-master/llm-log.php
git commit -m "feat(debugging-master): add PHP instrumentation snippet"
```

---

## Phase 3: Core Engine

### Task 9: Log parser

**Files:**
- Create: `src/debugging-master/core/log-parser.ts`

Reads JSONL, filters by level/hypothesis/last-N, computes stats and timer pairs.

**Step 1: Write log parser**

```typescript
import type { LogEntry, IndexedLogEntry, SessionStats, TimerPair, LogLevel } from "@app/debugging-master/types";

/**
 * Parse raw LogEntry[] into indexed entries with computed fields.
 */
export function indexEntries(entries: LogEntry[]): IndexedLogEntry[] {
  return entries.map((e, i) => ({ ...e, index: i + 1 }));
}

/**
 * Filter entries by level(s). Always includes "raw" entries.
 */
export function filterByLevel(entries: IndexedLogEntry[], levels: string[]): IndexedLogEntry[] {
  const levelSet = new Set<string>(levels);
  levelSet.add("raw"); // always include raw
  return entries.filter((e) => levelSet.has(e.level));
}

/**
 * Filter entries by hypothesis tag.
 */
export function filterByHypothesis(entries: IndexedLogEntry[], h: string): IndexedLogEntry[] {
  return entries.filter((e) => e.h === h || e.level === "raw");
}

/**
 * Return last N entries.
 */
export function lastN(entries: IndexedLogEntry[], n: number): IndexedLogEntry[] {
  return entries.slice(-n);
}

/**
 * Compute timer pairs from start/end entries.
 */
export function computeTimerPairs(entries: IndexedLogEntry[]): TimerPair[] {
  const starts: Record<string, { ts: number; index: number }> = {};
  const pairs: TimerPair[] = [];

  for (const e of entries) {
    if (e.level === "timer-start" && e.label) {
      starts[e.label] = { ts: e.ts, index: e.index };
    } else if (e.level === "timer-end" && e.label) {
      const start = starts[e.label];
      if (start) {
        pairs.push({
          label: e.label,
          startTs: start.ts,
          endTs: e.ts,
          durationMs: e.durationMs ?? e.ts - start.ts,
          startIndex: start.index,
          endIndex: e.index,
        });
        delete starts[e.label];
      }
    }
  }
  return pairs;
}

/**
 * Compute session summary stats.
 */
export function computeStats(entries: IndexedLogEntry[]): SessionStats {
  const levelCounts: Record<string, number> = {};
  let assertsPassed = 0;
  let assertsFailed = 0;
  const files = new Set<string>();

  for (const e of entries) {
    levelCounts[e.level] = (levelCounts[e.level] ?? 0) + 1;
    if (e.level === "assert") {
      if (e.passed) assertsPassed++;
      else assertsFailed++;
    }
    if (e.file) files.add(e.file);
  }

  const timerPairs = computeTimerPairs(entries);
  const avgTimerMs =
    timerPairs.length > 0
      ? timerPairs.reduce((sum, p) => sum + p.durationMs, 0) / timerPairs.length
      : 0;

  const timestamps = entries.filter((e) => e.ts).map((e) => e.ts);
  const startTime = Math.min(...timestamps);
  const endTime = Math.max(...timestamps);

  return {
    entryCount: entries.length,
    levelCounts,
    timerPairs,
    avgTimerMs,
    assertsPassed,
    assertsFailed,
    startTime: Number.isFinite(startTime) ? startTime : 0,
    endTime: Number.isFinite(endTime) ? endTime : 0,
    spanMs: Number.isFinite(endTime - startTime) ? endTime - startTime : 0,
    files: [...files],
  };
}

/**
 * For timer-level filter: merge start+end into single "timer" display entries.
 */
export function mergeTimerEntries(entries: IndexedLogEntry[]): IndexedLogEntry[] {
  const pairs = computeTimerPairs(entries);
  const endIndices = new Set(pairs.map((p) => p.endIndex));
  const startToEnd = new Map(pairs.map((p) => [p.startIndex, p]));

  const result: IndexedLogEntry[] = [];
  for (const e of entries) {
    if (endIndices.has(e.index)) continue; // skip end entries
    if (startToEnd.has(e.index)) {
      const pair = startToEnd.get(e.index)!;
      result.push({
        ...e,
        level: "timer-end" as LogLevel, // display as completed timer
        durationMs: pair.durationMs,
      });
    } else if (e.level !== "timer-start" && e.level !== "timer-end") {
      result.push(e);
    }
  }
  return result;
}
```

**Step 2: Commit**

```bash
git add src/debugging-master/core/log-parser.ts
git commit -m "feat(debugging-master): add log parser with filtering and stats"
```

---

### Task 10: Formatter

**Files:**
- Create: `src/debugging-master/core/formatter.ts`

Handles L1 output, summary, file headers, `suggestCommand()` tips, and `--format` modes.

**Step 1: Write formatter**

```typescript
import chalk from "chalk";
import { formatDuration, formatBytes } from "@app/utils/format";
import { suggestCommand } from "@app/utils/cli/executor";
import { formatSchema } from "@app/utils/json-schema";
import type { IndexedLogEntry, SessionStats, OutputFormat } from "@app/debugging-master/types";

const TOOL = "tools debugging-master";

/**
 * Format a single entry as a compact L1 line.
 */
export function formatEntryLine(entry: IndexedLogEntry, pretty: boolean): string {
  const idx = `#${entry.index}`.padStart(4);
  const time = new Date(entry.ts).toLocaleTimeString("en-GB", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
  const level = entry.level.padEnd(11);
  const label = entry.label ?? entry.msg ?? "";

  let suffix = "";
  if (entry.refId) {
    suffix = `[ref:${entry.refId}] ${formatBytes(JSON.stringify(entry.data ?? entry.vars ?? entry.stack ?? "").length)}`;
  }
  if (entry.level === "timer-end" && entry.durationMs != null) {
    suffix = formatDuration(entry.durationMs, "ms");
  }
  if (entry.level === "assert") {
    suffix = entry.passed ? "PASS" : "FAIL";
  }

  const line = `  ${idx}  ${time}  ${level} ${label}`;
  if (!suffix) return line;
  return `${line.padEnd(60)} ${suffix}`;
}

/**
 * Format the summary section.
 */
export function formatSummary(stats: SessionStats): string {
  const parts: string[] = [];
  const lc = stats.levelCounts;

  const levelOrder = ["dump", "info", "warn", "error", "checkpoint", "trace", "snapshot", "assert", "raw"];
  for (const level of levelOrder) {
    const count = lc[level];
    if (!count) continue;
    let text = `${count} ${level}`;
    if (level === "assert") {
      text += ` (${stats.assertsFailed} failed)`;
    }
    parts.push(text);
  }

  if (stats.timerPairs.length > 0) {
    parts.push(
      `${stats.timerPairs.length} timer-pair (avg ${formatDuration(stats.avgTimerMs, "ms")})`
    );
  }

  return `Summary:\n  ${parts.join("  ")}`;
}

/**
 * Format full L1 output with timeline-preserving file headers.
 */
export function formatL1(
  sessionName: string,
  entries: IndexedLogEntry[],
  stats: SessionStats,
  pretty: boolean,
): string {
  const lines: string[] = [];

  // Header
  lines.push(
    `Session: ${sessionName} (${stats.entryCount} entries, ${formatDuration(stats.spanMs, "ms")} span)`
  );
  lines.push("");
  lines.push(formatSummary(stats));
  lines.push("");

  // Entries with file headers on change
  let currentFile = "";
  for (const entry of entries) {
    const file = entry.file ?? "unknown";
    if (file !== currentFile) {
      currentFile = file;
      lines.push(`File: ${file}`);
    }
    lines.push(formatEntryLine(entry, pretty));
  }

  return lines.join("\n");
}

/**
 * Generate the tip line for the end of output.
 */
export function formatTip(entries: IndexedLogEntry[]): string {
  // Find first ref'd entry to suggest expand
  const refEntry = entries.find((e) => e.refId);
  if (refEntry) {
    return `\nTip: Expand a ref → ${TOOL} expand ${refEntry.refId}`;
  }
  return "";
}

/**
 * Wrap output in the requested format.
 */
export function wrapOutput(content: string, format: OutputFormat, tip?: string): string {
  switch (format) {
    case "json":
      return JSON.stringify({ output: content });
    case "md":
      return content + (tip ?? "");
    case "ai":
    default:
      return content + (tip ?? "");
  }
}
```

**Step 2: Commit**

```bash
git add src/debugging-master/core/formatter.ts
git commit -m "feat(debugging-master): add formatter with L1 output and tips"
```

---

### Task 11: HTTP ingest server

**Files:**
- Create: `src/debugging-master/core/http-server.ts`

Simple Bun HTTP server: `POST /log/<session>` appends to JSONL, resilient to bad input.

**Step 1: Write HTTP server**

```typescript
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { LogEntry } from "@app/debugging-master/types";

const SESSIONS_DIR = join(homedir(), ".genesis-tools", "debugging-master", "sessions");

function ensureDir(): void {
  if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
}

/**
 * Parse and normalize an incoming log entry. Never throws.
 */
function normalizeEntry(body: string): LogEntry {
  try {
    const parsed = JSON.parse(body);
    // Fill missing defaults
    return {
      level: parsed.level ?? "info",
      ts: parsed.ts ?? Date.now(),
      ...parsed,
    } as LogEntry;
  } catch {
    // Invalid JSON — wrap as raw
    return {
      level: "raw",
      data: body,
      ts: Date.now(),
    };
  }
}

/**
 * Start the HTTP ingest server.
 */
export function startServer(port: number = 7243): { server: ReturnType<typeof Bun.serve>; port: number } {
  ensureDir();

  const server = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);

      // Health check
      if (req.method === "GET" && url.pathname === "/health") {
        return new Response(JSON.stringify({ status: "ok", uptime: process.uptime() }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Log ingestion: POST /log/<session-name>
      if (req.method === "POST" && url.pathname.startsWith("/log/")) {
        const sessionName = url.pathname.slice(5); // strip "/log/"
        if (!sessionName) {
          return new Response("Missing session name", { status: 400 });
        }

        return req.text().then((body) => {
          const entry = normalizeEntry(body);
          const path = join(SESSIONS_DIR, `${sessionName}.jsonl`);
          appendFileSync(path, JSON.stringify(entry) + "\n");
          return new Response("ok", { status: 200 });
        });
      }

      // Clear session: DELETE /log/<session-name>
      if (req.method === "DELETE" && url.pathname.startsWith("/log/")) {
        const sessionName = url.pathname.slice(5);
        const path = join(SESSIONS_DIR, `${sessionName}.jsonl`);
        try {
          Bun.write(path, "");
          return new Response("cleared", { status: 200 });
        } catch {
          return new Response("session not found", { status: 404 });
        }
      }

      return new Response("not found", { status: 404 });
    },
  });

  return { server, port: server.port };
}
```

**Step 2: Quick test**

```bash
# Start server in background
bun -e "import { startServer } from './src/debugging-master/core/http-server'; const {port} = startServer(); console.log('listening on', port);" &
SERVER_PID=$!
sleep 1

# Send a log entry
curl -s -X POST http://127.0.0.1:7243/log/test-http \
  -H 'Content-Type: application/json' \
  -d '{"level":"dump","label":"testData","data":{"a":1}}'

# Send invalid JSON (should be saved as raw)
curl -s -X POST http://127.0.0.1:7243/log/test-http \
  -d 'this is not json'

# Check
cat ~/.genesis-tools/debugging-master/sessions/test-http.jsonl

# Cleanup
kill $SERVER_PID
rm ~/.genesis-tools/debugging-master/sessions/test-http.jsonl
```

Expected: 2 JSONL lines — one dump entry, one raw entry.

**Step 3: Commit**

```bash
git add src/debugging-master/core/http-server.ts
git commit -m "feat(debugging-master): add HTTP ingest server"
```

---

## Phase 4: CLI Commands

### Task 12: CLI entry point

**Files:**
- Create: `src/debugging-master/index.ts`

**Step 1: Write entry point with global options**

```typescript
import { Command } from "commander";
import { registerStartCommand } from "./commands/start";
import { registerGetCommand } from "./commands/get";
import { registerExpandCommand } from "./commands/expand";
import { registerSnippetCommand } from "./commands/snippet";
import { registerSessionsCommand } from "./commands/sessions";
import { registerTailCommand } from "./commands/tail";
import { registerCleanupCommand } from "./commands/cleanup";
import { registerDiffCommand } from "./commands/diff";

const program = new Command();

program
  .name("debugging-master")
  .description("LLM debugging toolkit — instrumentation + token-efficient log reader")
  .option("--session <name>", "Session name (fuzzy-matched)")
  .option("--format <type>", "Output format: ai (default), json, md", "ai")
  .option("--pretty", "Enhanced human-readable output (colors, box drawing)")
  .option("-v, --verbose", "Verbose logging");

registerStartCommand(program);
registerGetCommand(program);
registerExpandCommand(program);
registerSnippetCommand(program);
registerSessionsCommand(program);
registerTailCommand(program);
registerCleanupCommand(program);
registerDiffCommand(program);

program.parse();
```

**Step 2: Verify it registers as a tool**

```bash
tools debugging-master --help
```

Expected: Shows help with all subcommands and global options.

**Step 3: Commit**

```bash
git add src/debugging-master/index.ts
git commit -m "feat(debugging-master): add CLI entry point"
```

---

### Task 13: `start` command

**Files:**
- Create: `src/debugging-master/commands/start.ts`

**Step 1: Write start command**

Handles:
- Config lookup (TTY vs non-TTY path selection)
- Copy snippet to project
- Create session
- Optionally start HTTP server

Key behaviors:
- First run: detect project structure, suggest paths via Clack (TTY) or error+suggestCommand (non-TTY)
- Always overwrite snippet (ensure latest version)
- Auto-detect language from project files if not specified
- Start HTTP server if `--serve` is passed

Reference patterns: `src/har-analyzer/commands/show.ts` for command registration, `@clack/prompts` for TTY prompts.

Implementation must:
1. Import `@clack/prompts` for TTY path selection
2. Check project for `src/`, `app/`, `lib/` directories to suggest paths
3. Detect language: check for `tsconfig.json` → typescript, `composer.json` → php
4. Copy appropriate snippet (`llm-log.ts` or `llm-log.php`) to configured path
5. Create session via SessionManager
6. If `--serve`: start HTTP server (keep process alive)
7. Output session info including import path + `suggestCommand()` for next step

The snippet source lives at the GenesisTools install path. Use `import.meta.dir` to resolve relative to the current file, then navigate to `../../utils/debugging-master/llm-log.ts`.

**Step 2: Test manually**

```bash
# In a test directory
cd /tmp && mkdir test-project && cd test-project && mkdir src
tools debugging-master start --session test1 --path src
# Should: copy llm-log.ts to /tmp/test-project/src/, create session, show instructions
ls src/llm-log.ts
cat ~/.genesis-tools/debugging-master/sessions/test1.meta.json
```

**Step 3: Commit**

```bash
git add src/debugging-master/commands/start.ts
git commit -m "feat(debugging-master): add start command"
```

---

### Task 14: `get` command

**Files:**
- Create: `src/debugging-master/commands/get.ts`

**Step 1: Write get command**

Handles:
- Resolve session (fuzzy)
- Read + index entries
- Apply filters: `-l dump,error`, `--last 5`, `--h H1`
- Special handling for `-l timer` (merge timer pairs)
- Assign ref IDs to large entries
- Compute stats
- Format as L1 with timeline-preserving file headers
- Append tip with `suggestCommand()`
- Wrap in requested format (`--format ai|json|md`)

Key: when assigning ref IDs, use `d<n>` for dumps, `e<n>` for errors, `s<n>` for snapshots, `t<n>` for traces (where n = entry index). Store ref via `RefStoreManager`.

```bash
tools debugging-master get                     # Recent session, all entries
tools debugging-master get -l dump             # Filter dumps
tools debugging-master get -l dump,error       # Multiple levels
tools debugging-master get --last 5            # Last 5 entries
tools debugging-master get --h H1              # Hypothesis filter
```

**Step 2: Test manually**

```bash
# Use the snippet from Task 7's test to generate some log data, then:
tools debugging-master get --session test-snippet
```

**Step 3: Commit**

```bash
git add src/debugging-master/commands/get.ts
git commit -m "feat(debugging-master): add get command with filtering and L1 output"
```

---

### Task 15: `expand` command

**Files:**
- Create: `src/debugging-master/commands/expand.ts`

**Step 1: Write expand command**

Handles:
- Parse ref ID (e.g., `d2` → find entry #2's dump data)
- Default to schema view (`formatSchema(data, 'skeleton')`)
- `--schema <mode>` for skeleton/typescript/schema
- `--full` for complete data (L3)
- `--query <jmes>` for JMESPath projection
- `suggestCommand()` tip at the end (suggest `--full` or `--query`)

```bash
tools debugging-master expand d2                          # Schema skeleton (default)
tools debugging-master expand d2 --schema typescript      # TS interface
tools debugging-master expand d2 --full                   # Full data
tools debugging-master expand d2 --query 'items[*].name'  # JMESPath
```

JMESPath usage:
```typescript
import { search } from "@jmespath-community/jmespath";
const result = search(data, jmesExpression);
```

**Step 2: Test manually**

After generating test data with a large dump:

```bash
tools debugging-master expand d2
tools debugging-master expand d2 --query 'a'
```

**Step 3: Commit**

```bash
git add src/debugging-master/commands/expand.ts
git commit -m "feat(debugging-master): add expand command with schema/JMESPath"
```

---

### Task 16: `snippet` command

**Files:**
- Create: `src/debugging-master/commands/snippet.ts`

**Step 1: Write snippet command**

Generates ready-to-paste instrumentation code. Auto-detects language from project config, overridable with `--language`.

```bash
tools debugging-master snippet dump userData
tools debugging-master snippet dump userData --http
tools debugging-master snippet checkpoint after-auth
tools debugging-master snippet dump userData --language php
tools debugging-master snippet dump userData --language php --http
```

For each combination, output the complete `// #region @dbg` ... `// #endregion @dbg` block.

For PHP HTTP mode: check for `composer.json` with `guzzlehttp/guzzle` to decide between Guzzle and `file_get_contents`.

The snippet includes the current session name (from config) in the generated code.

**Step 2: Test**

```bash
tools debugging-master snippet dump myData
tools debugging-master snippet dump myData --http
tools debugging-master snippet dump myData --language php --http
```

**Step 3: Commit**

```bash
git add src/debugging-master/commands/snippet.ts
git commit -m "feat(debugging-master): add snippet generator command"
```

---

### Task 17: `sessions` command

**Files:**
- Create: `src/debugging-master/commands/sessions.ts`

**Step 1: Write sessions command**

Lists all sessions with metadata: name, entry count, time span, project path, last activity, active indicator.

Use `formatTable` from `src/utils/table.ts` for aligned columns.

```bash
tools debugging-master sessions
```

Output:
```
Sessions:
  Name            Entries  Span     Project                    Last Activity
  fix-auth-bug    23       4.2s     /Users/.../my-app          2 min ago  *active*
  perf-issue      8        12.1s    /Users/.../my-app          3 hours ago
```

**Step 2: Commit**

```bash
git add src/debugging-master/commands/sessions.ts
git commit -m "feat(debugging-master): add sessions list command"
```

---

### Task 18: `tail` command

**Files:**
- Create: `src/debugging-master/commands/tail.ts`

**Step 1: Write tail command**

Live-tails a session's JSONL file using `Bun.file().stream()` or `fs.watch` + periodic read.

Supports:
- `--pretty` for colored output (default when TTY)
- `-l dump,error` for level filtering during tail
- Streams new entries as they appear

Implementation approach: use `fs.watch` on the JSONL file, read new bytes since last position, parse lines, format and print.

```bash
tools debugging-master tail                    # Recent session
tools debugging-master tail --session fix-au   # Fuzzy match
tools debugging-master tail --pretty           # Human colors
tools debugging-master tail -l dump,error      # Filter while tailing
```

**Step 2: Test manually**

```bash
# Terminal 1: start tail
tools debugging-master tail --session test-snippet --pretty

# Terminal 2: generate entries
bun -e "
import { dbg } from './src/utils/debugging-master/llm-log';
dbg.session('test-snippet');
dbg.info('live entry');
dbg.dump('liveData', {x: 1});
"
```

Expected: entries appear in terminal 1 in real-time.

**Step 3: Commit**

```bash
git add src/debugging-master/commands/tail.ts
git commit -m "feat(debugging-master): add tail command with live streaming"
```

---

### Task 19: `cleanup` command

**Files:**
- Create: `src/debugging-master/commands/cleanup.ts`

This is the most complex command. Implementation order:

**Step 1: Write block scanner**

Function that finds all `// #region @dbg` ... `// #endregion @dbg` blocks across project files. Uses `Glob` pattern to scan `.ts`, `.tsx`, `.js`, `.jsx`, `.php` files. Returns map of `{filePath: blockRanges[]}`.

**Step 2: Write block remover**

Function that removes identified blocks from files. Reads file, removes lines within block ranges (including the region markers), writes back.

**Step 3: Write git diff checker**

After block removal, for each modified file:
1. Run `git diff <file>` using `Executor`
2. Parse the diff — check if it's **only** whitespace/blank-line changes
3. If only formatting artifacts: flag as repairable
4. Use `DiffUtil.formatDiffOutput()` to show the diff

**Step 4: Write log archival**

Move session JSONL to `/tmp/<datetime>-llmlog-<session>.jsonl`. Show the temp path. Suggest `--keep-logs <path>` to move to permanent location.

**Step 5: Wire up cleanup command**

```bash
tools debugging-master cleanup                         # Remove blocks, archive logs
tools debugging-master cleanup --repair-formatting     # Also checkout formatting-only diffs
tools debugging-master cleanup --keep-logs             # Prompt for permanent log location
tools debugging-master cleanup --keep-logs ./debug-logs/  # Non-TTY: specify path
```

Output:
```
Removed 12 blocks from 4 files.

2 files have minor formatting diffs:
  src/api.ts:
  ```diff
  -
  -
   const handler = async () => {
  ```
  src/auth.ts:
  ```diff
  -
   export function login() {
  ```

Tip: Fix formatting → tools debugging-master cleanup --repair-formatting

Logs archived to: /tmp/2026-02-19T14-32-00-llmlog-fix-auth-bug.jsonl
Tip: Keep logs → tools debugging-master cleanup --keep-logs ./debug-logs/
```

**Step 6: Commit**

```bash
git add src/debugging-master/commands/cleanup.ts
git commit -m "feat(debugging-master): add cleanup command with auto-track removal"
```

---

### Task 20: `diff` command

**Files:**
- Create: `src/debugging-master/commands/diff.ts`

**Step 1: Write diff command**

Compares two sessions by matching labels/checkpoints.

```bash
tools debugging-master diff --session sess1 --against sess2
tools debugging-master diff --session sess1 --against sess2 -l checkpoint
```

Algorithm:
1. Read entries from both sessions
2. Group entries by label (for dumps, checkpoints, traces) or by level
3. Match entries between sessions by label
4. For matching entries: show data differences (use `DiffUtil.showDiff()` on JSON.stringify'd data)
5. For unmatched entries: show as "only in session X"
6. For timer pairs: show timing comparison (sess1: 340ms vs sess2: 120ms)

Output:
```
Comparing: sess1 (23 entries) vs sess2 (20 entries)

Matching checkpoints:
  after-auth       sess1: #4 14:32:05  sess2: #3 14:32:01  (4s earlier)
  before-commit    sess1: #12          sess2: missing

Matching dumps:
  userData         Both present, data differs:
    - sess1: {role: "admin", ...}
    + sess2: {role: "user", ...}

Timer comparison:
  db-query         sess1: 340ms  sess2: 120ms  (-65%)

Only in sess1: 3 entries (2 trace, 1 warn)
Only in sess2: 0 entries
```

**Step 2: Test with two sessions**

Generate two sessions with overlapping labels but different data, then run diff.

**Step 3: Commit**

```bash
git add src/debugging-master/commands/diff.ts
git commit -m "feat(debugging-master): add diff command for session comparison"
```

---

## Phase 5: Skill

### Task 21: Write the SKILL.md

**Files:**
- Create: `.claude/skills/debugging-master/SKILL.md`

**Step 1: Write the skill**

The skill teaches the LLM:
1. When to use debugging-master (runtime bugs, performance issues, execution flow questions)
2. Setup: `tools debugging-master start --session <name>`
3. How to instrument code (import snippet, add `// #region @dbg` blocks)
4. How to read logs (`get`, `expand`, `--query`)
5. Workflow examples (all recommendations):
   - Hypothesis-driven (complex bugs)
   - Quick instrumentation (simple bugs)
   - Performance profiling (timers)
   - Execution flow tracing (checkpoints)
6. JMESPath reference section with syntax examples
7. Token efficiency tips
8. Cleanup checklist
9. PHP-specific notes
10. HTTP mode instructions for browser debugging

Structure the skill with clear sections. Include a `## Quick Reference` at the top with the most common commands. Include a `## JMESPath Reference` section that the LLM reads when it needs complex path queries.

Key instruction in skill: "Always use `expand` (defaults to schema) before `expand --full` to check the structure first. Use `--query` with JMESPath projections to minimize token usage."

**Step 2: Commit**

```bash
git add .claude/skills/debugging-master/SKILL.md
git commit -m "feat(debugging-master): add SKILL.md for LLM workflow guidance"
```

---

## Phase 6: Integration & Polish

### Task 22: End-to-end test

**Step 1: Full workflow test**

Run through the complete debugging workflow manually:

```bash
# 1. Start a session in a test project
cd /tmp && mkdir -p e2e-test/src && cd e2e-test
tools debugging-master start --session e2e-test --path src

# 2. Check snippet was copied
ls src/llm-log.ts

# 3. Create a test file that uses the snippet
cat > src/test.ts << 'EOF'
// #region @dbg
import { dbg } from './llm-log';
// #endregion @dbg

const data = { users: [{ id: 1, name: "Alice", role: "admin" }, { id: 2, name: "Bob", role: "user" }] };

// #region @dbg
dbg.session('e2e-test');
dbg.dump('userData', data);
dbg.timerStart('processing');
dbg.checkpoint('before-process');
dbg.info('processing started', { count: data.users.length });
dbg.timerEnd('processing');
dbg.checkpoint('after-process');
dbg.assert(data.users.length > 0, 'has-users', { count: data.users.length });
// #endregion @dbg
EOF

# 4. Run it
bun run src/test.ts

# 5. Read logs
tools debugging-master get
tools debugging-master get -l dump
tools debugging-master get --last 3

# 6. Expand a ref
tools debugging-master expand d1
tools debugging-master expand d1 --schema typescript
tools debugging-master expand d1 --query 'users[*].{id: id, name: name}'
tools debugging-master expand d1 --full

# 7. Generate a snippet
tools debugging-master snippet dump newData

# 8. List sessions
tools debugging-master sessions

# 9. Cleanup
tools debugging-master cleanup

# 10. Verify cleanup removed blocks
cat src/test.ts  # Should have no @dbg blocks
```

**Step 2: Fix any issues found**

**Step 3: Final commit**

```bash
git add -A
git commit -m "feat(debugging-master): complete implementation with e2e verification"
```

---

### Task 23: HTTP mode end-to-end test

**Step 1: Test HTTP server mode**

```bash
cd /tmp/e2e-test

# Start with server
tools debugging-master start --session http-test --serve &
SERVER_PID=$!
sleep 1

# Send entries via curl
curl -s -X POST http://127.0.0.1:7243/log/http-test \
  -H 'Content-Type: application/json' \
  -d '{"level":"dump","label":"apiResponse","data":{"status":200,"body":{"items":[1,2,3]}}}'

curl -s -X POST http://127.0.0.1:7243/log/http-test \
  -d 'not valid json at all'

# Read logs
tools debugging-master get --session http-test

# Should show 1 dump + 1 raw entry
kill $SERVER_PID
```

**Step 2: Commit if fixes needed**

---

## Task Dependency Summary

```
Phase 1: Foundation
  Task 1 (jmespath) → independent
  Task 2 (types) → independent
  Task 3 (shared refs) → independent
  Task 4 (fuzzy match) → independent
  Task 5 (config mgr) → depends on Task 2
  Task 6 (session mgr) → depends on Tasks 2, 4, 5

Phase 2: Snippets
  Task 7 (llm-log.ts) → independent
  Task 8 (llm-log.php) → independent

Phase 3: Core Engine
  Task 9 (log parser) → depends on Task 2
  Task 10 (formatter) → depends on Tasks 2, 3, 9
  Task 11 (http server) → depends on Task 2

Phase 4: CLI Commands
  Task 12 (entry point) → depends on all commands (stubs ok)
  Task 13 (start) → depends on Tasks 5, 6, 7, 8
  Task 14 (get) → depends on Tasks 3, 6, 9, 10
  Task 15 (expand) → depends on Tasks 1, 3, 6, 9, 10
  Task 16 (snippet) → depends on Task 5
  Task 17 (sessions) → depends on Task 6
  Task 18 (tail) → depends on Tasks 6, 9, 10
  Task 19 (cleanup) → depends on Tasks 5, 6
  Task 20 (diff) → depends on Tasks 6, 9, 10

Phase 5: Skill
  Task 21 (SKILL.md) → depends on all commands being done

Phase 6: Integration
  Tasks 22-23 → depend on everything
```
