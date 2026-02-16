# Automation Framework - General Tasks Extension Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> **Prerequisite:** The base automation framework (2026-02-16-Automate.md) must be implemented first.

**Goal:** Extend the base `src/automate/` framework with HTTP, file, git, transform, notification, parallel, and loop step handlers via a plugin registry, plus credential management and example presets.

**Architecture:** Each new step type (http, file, git, json, text, array, notify, parallel, forEach) registers itself into a handler registry so the engine never needs modification. The engine resolves handlers by action prefix (e.g. `http.get` resolves the `http` handler). Credentials are stored as JSON files with 0600 permissions at `~/.genesis-tools/automate/credentials/`.

**Tech Stack:** TypeScript, Bun runtime, native `fetch` (HTTP), `createGit()` from `src/utils/git/` (git), `glob` (file globbing), `clipboardy` (clipboard), `jsonpath` (JSON queries), `concurrentMap` from `src/utils/async` (bounded concurrency)

---

### Task 1: Step Handler Registry **[MVP]**

**Files:**
- Create: `src/automate/lib/registry.ts`
- Modify: `src/automate/lib/engine.ts`

**Step 1: Write the registry**

Create `src/automate/lib/registry.ts`:

```typescript
import type { StepResult } from "./types";

/**
 * Context passed to each step handler during execution.
 * Provides access to previous step results, variables, env, and expression evaluation.
 */
export interface StepContext {
  /** Results of all previously executed steps, keyed by step ID */
  steps: Record<string, StepResult>;
  /** Global preset variables (resolved) */
  variables: Record<string, unknown>;
  /** Environment variables */
  env: Record<string, string | undefined>;
  /** Evaluate a single expression string against the current context */
  evaluate: (expr: string) => unknown;
  /** Resolve all {{ }} placeholders in a template string */
  interpolate: (template: string) => string;
  /** Structured logger */
  log: (level: "info" | "warn" | "error" | "debug", message: string) => void;
}

/** A step handler executes a step definition and returns a result */
export type StepHandler = (
  step: StepDefinition,
  ctx: StepContext,
) => Promise<StepResult>;

// Re-export for convenience so handlers can import from one place
import type { StepDefinition } from "./types";
export type { StepDefinition };

/** Internal registry: action prefix -> handler */
const handlers = new Map<string, StepHandler>();

/**
 * Register a step handler for a given action prefix.
 *
 * @example
 *   registerStepHandler("http", httpHandler)   // matches http.get, http.post, ...
 *   registerStepHandler("parallel", handler)   // matches exactly "parallel"
 */
export function registerStepHandler(prefix: string, handler: StepHandler): void {
  handlers.set(prefix, handler);
}

/**
 * Resolve the handler for a given step action.
 * Tries exact match first, then prefix match (substring before first dot).
 */
export function resolveStepHandler(action: string): StepHandler | undefined {
  if (handlers.has(action)) return handlers.get(action);

  const dotIndex = action.indexOf(".");
  if (dotIndex > 0) {
    const prefix = action.substring(0, dotIndex);
    return handlers.get(prefix);
  }

  return undefined;
}

/** List all registered handler prefixes (for help/validation) */
export function getRegisteredActions(): string[] {
  return Array.from(handlers.keys()).sort();
}
```

**Step 2: Wire registry into engine**

In `src/automate/lib/engine.ts`, replace the hardcoded step dispatch with:

```typescript
// At the top of engine.ts, add import:
import { resolveStepHandler, getRegisteredActions } from "./registry";

// In the step execution section, replace the action dispatch with:
const handler = resolveStepHandler(step.action);
if (!handler) {
  throw new Error(
    `Unknown step action: "${step.action}". Registered: ${getRegisteredActions().join(", ")}`,
  );
}
return handler(step, ctx);
```

**Step 3: Verify**

Run: `tsgo --noEmit 2>&1 | rg "automate"`

Expected: No type errors in `src/automate/lib/registry.ts`

**Step 4: Commit**

```bash
git add src/automate/lib/registry.ts src/automate/lib/engine.ts
git commit -m "feat(automate): add step handler registry with prefix-based resolution"
```

---

### Task 2: Extended Type Definitions **[MVP]**

**Files:**
- Modify: `src/automate/lib/types.ts`

**Step 1: Add action types and param interfaces to types.ts**

Append to the existing `src/automate/lib/types.ts`:

```typescript
// ---------------------------------------------------------------------------
// Step Action Types (for type-safe action strings)
// ---------------------------------------------------------------------------

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";
export type FileAction = "read" | "write" | "copy" | "move" | "delete" | "glob" | "template";
export type GitAction = "status" | "commit" | "branch" | "diff" | "log";
export type JsonAction = "parse" | "stringify" | "query";
export type TextAction = "regex" | "template" | "split" | "join";
export type ArrayAction = "filter" | "map" | "sort" | "flatten";
export type NotifyAction = "desktop" | "clipboard" | "sound";

// ---------------------------------------------------------------------------
// Step Params per Action Type
// ---------------------------------------------------------------------------

export interface HttpStepParams {
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  credential?: string;
  timeout?: number;
  validateStatus?: string;
}

export interface FileStepParams {
  path?: string;
  content?: string;
  source?: string;
  destination?: string;
  pattern?: string;
  cwd?: string;
  templatePath?: string;
  variables?: Record<string, string>;
  encoding?: "utf-8" | "base64";
}

export interface GitStepParams {
  cwd?: string;
  message?: string;
  files?: string[];
  branch?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface JsonStepParams {
  input?: string;
  query?: string;
  indent?: number;
}

export interface TextStepParams {
  input?: string;
  pattern?: string;
  replacement?: string;
  flags?: string;
  template?: string;
  separator?: string;
}

export interface ArrayStepParams {
  input?: string;
  expression?: string;
  key?: string;
  order?: "asc" | "desc";
  initial?: unknown;
}

export interface NotifyStepParams {
  title?: string;
  message?: string;
  content?: string;
  sound?: string;
}

export interface ParallelStepParams {
  steps: string[];
  onError?: "stop" | "continue";
}

export interface ForEachStepParams {
  items: string;
  step: StepDefinition;
  concurrency?: number;
  as?: string;
  indexAs?: string;
}

export interface WhileStepParams {
  condition: string;
  step: StepDefinition;
  maxIterations?: number;
}

// ---------------------------------------------------------------------------
// Extended Step Definition (union params)
// ---------------------------------------------------------------------------

export interface StepDefinition {
  id: string;
  name: string;
  action: string;
  params?: HttpStepParams | FileStepParams | GitStepParams
    | JsonStepParams | TextStepParams | ArrayStepParams
    | NotifyStepParams | ParallelStepParams | ForEachStepParams
    | WhileStepParams | Record<string, unknown>;
  condition?: string;
  onError?: "stop" | "continue" | "retry";
  retryCount?: number;
  retryDelay?: number;
  timeout?: number;
  output?: string;
}

// ---------------------------------------------------------------------------
// Credential Types
// ---------------------------------------------------------------------------

export type CredentialType = "bearer" | "basic" | "apikey" | "custom";

export interface StoredCredential {
  name: string;
  type: CredentialType;
  token?: string;
  username?: string;
  password?: string;
  headerName?: string;
  key?: string;
  headers?: Record<string, string>;
}
```

**NOTE:** If `StepDefinition` already exists in the base plan's `types.ts`, merge the fields (add `params` union, `retryCount`, `retryDelay`, `timeout`). If `StepResult` already exists, keep it as-is; it should already have `id`, `status`, `output`, `error`, `durationMs` (or `duration`). Adapt field names to match whatever the base plan used.

**Step 2: Verify**

Run: `tsgo --noEmit 2>&1 | rg "automate"`

Expected: No type errors

**Step 3: Commit**

```bash
git add src/automate/lib/types.ts
git commit -m "feat(automate): add extended type definitions for all step handlers"
```

---

### Task 3: Credential System **[MVP]**

**Files:**
- Create: `src/automate/lib/credentials.ts`

**Step 1: Write the credential manager**

Create `src/automate/lib/credentials.ts`:

```typescript
import { existsSync, mkdirSync, chmodSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import logger from "@app/logger";
import type { StoredCredential } from "./types";

const CREDENTIALS_DIR = join(homedir(), ".genesis-tools", "automate", "credentials");

/** Ensure credentials directory exists with restrictive permissions */
function ensureDir(): void {
  if (!existsSync(CREDENTIALS_DIR)) {
    mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Save a credential to disk.
 * File permissions are set to 0600 (owner read/write only).
 */
export async function saveCredential(credential: StoredCredential): Promise<void> {
  ensureDir();
  const filePath = join(CREDENTIALS_DIR, `${credential.name}.json`);
  await Bun.write(filePath, JSON.stringify(credential, null, 2));
  chmodSync(filePath, 0o600);
  logger.debug(`Credential saved: ${credential.name}`);
}

/**
 * Load a credential by name.
 * Returns null if not found.
 */
export async function loadCredential(name: string): Promise<StoredCredential | null> {
  const filePath = join(CREDENTIALS_DIR, `${name}.json`);
  if (!existsSync(filePath)) return null;

  try {
    const content = await Bun.file(filePath).text();
    return JSON.parse(content) as StoredCredential;
  } catch (error) {
    logger.error(`Failed to load credential "${name}": ${error}`);
    return null;
  }
}

/** List all stored credential names */
export function listCredentials(): string[] {
  ensureDir();
  return readdirSync(CREDENTIALS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

/** Delete a credential by name */
export function deleteCredential(name: string): boolean {
  const filePath = join(CREDENTIALS_DIR, `${name}.json`);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  logger.debug(`Credential deleted: ${name}`);
  return true;
}

/**
 * Resolve credential values by expanding {{ env.X }} expressions.
 * Called at runtime just before use -- credentials on disk keep expressions intact.
 */
export function resolveCredentialValues(
  credential: StoredCredential,
  interpolate: (s: string) => string,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(credential)) {
    if (typeof value === "string") {
      resolved[key] = interpolate(value);
    } else if (typeof value === "object" && value !== null) {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        obj[k] = typeof v === "string" ? interpolate(v) : v;
      }
      resolved[key] = obj;
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

/**
 * Resolve a credential reference to HTTP headers for use in fetch requests.
 *
 * Supports credential types: bearer, basic, apikey, custom.
 * The credential can be inline (from preset) or loaded from disk (via $ref).
 */
export function resolveCredentialHeaders(
  credential: StoredCredential,
  interpolate: (s: string) => string,
): Record<string, string> {
  const resolved = resolveCredentialValues(credential, interpolate);
  const type = resolved.type as string;

  switch (type) {
    case "bearer": {
      const token = String(resolved.token ?? "");
      return { Authorization: `Bearer ${token}` };
    }
    case "basic": {
      const username = String(resolved.username ?? "");
      const password = String(resolved.password ?? "");
      const encoded = Buffer.from(`${username}:${password}`).toString("base64");
      return { Authorization: `Basic ${encoded}` };
    }
    case "apikey": {
      const headerName = String(resolved.headerName ?? "X-API-Key");
      const key = String(resolved.key ?? "");
      return { [headerName]: key };
    }
    case "custom": {
      const headers: Record<string, string> = {};
      if (resolved.headers && typeof resolved.headers === "object") {
        for (const [k, v] of Object.entries(resolved.headers as Record<string, string>)) {
          headers[k] = String(v);
        }
      }
      return headers;
    }
    default:
      return {};
  }
}
```

**Step 2: Verify**

Run: `tsgo --noEmit 2>&1 | rg "automate"`

Expected: No type errors

**Step 3: Commit**

```bash
git add src/automate/lib/credentials.ts
git commit -m "feat(automate): add credential storage with 0600 permissions and env expansion"
```

---

### Task 4: Shared `makeResult` Helper **[MVP]**

**Files:**
- Create: `src/automate/lib/steps/helpers.ts`

All step handlers need to build `StepResult` objects. Factor this out once.

**Step 1: Write the helper**

Create `src/automate/lib/steps/helpers.ts`:

```typescript
import type { StepResult } from "../types";

/**
 * Build a StepResult with timing. Used by all step handlers.
 * Adjust field names if the base plan uses `duration` instead of `durationMs`, etc.
 */
export function makeResult(
  id: string,
  status: "success" | "failure" | "skipped",
  output: unknown,
  startMs: number,
  startedAt: string,
  error?: string,
): StepResult {
  return {
    id,
    status,
    output,
    error,
    duration: performance.now() - startMs,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
```

**NOTE:** The base plan's `StepResult` uses `duration` (not `durationMs`). If it uses `durationMs`, rename accordingly. Also add `startedAt` and `finishedAt` fields to `StepResult` in `types.ts` if they are not already there.

**Step 2: Verify**

Run: `tsgo --noEmit 2>&1 | rg "automate"`

Expected: No type errors

**Step 3: Commit**

```bash
git add src/automate/lib/steps/helpers.ts
git commit -m "feat(automate): add shared makeResult helper for step handlers"
```

---

### Task 5: HTTP Step Handler **[MVP]**

**Files:**
- Create: `src/automate/lib/steps/http.ts`

Uses native `fetch` (Bun built-in). No new dependencies.

**Step 1: Write the handler**

Create `src/automate/lib/steps/http.ts`:

```typescript
import { registerStepHandler } from "../registry";
import type { StepContext, StepDefinition } from "../registry";
import type { HttpStepParams, StoredCredential } from "../types";
import { loadCredential, resolveCredentialHeaders } from "../credentials";
import { makeResult } from "./helpers";

async function httpHandler(step: StepDefinition, ctx: StepContext): Promise<import("../types").StepResult> {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const params = step.params as HttpStepParams;

  if (!params?.url) {
    return makeResult(step.id, "failure", null, start, startedAt, `http step "${step.id}" requires params.url`);
  }

  const method = step.action.split(".")[1]?.toUpperCase() ?? "GET";
  const url = new URL(ctx.interpolate(params.url));

  // Query params
  if (params.query) {
    for (const [key, value] of Object.entries(params.query)) {
      url.searchParams.set(key, ctx.interpolate(value));
    }
  }

  // Headers
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // Credential headers
  if (params.credential) {
    const credName = ctx.interpolate(params.credential);
    // Try loading from disk first, then check preset-level credentials
    const stored = await loadCredential(credName);
    if (stored) {
      Object.assign(headers, resolveCredentialHeaders(stored, ctx.interpolate));
    } else {
      // Try to resolve from preset credentials via context
      const presetCred = ctx.evaluate(`credentials.${credName}`) as StoredCredential | undefined;
      if (presetCred) {
        Object.assign(headers, resolveCredentialHeaders(presetCred, ctx.interpolate));
      } else {
        ctx.log("warn", `Credential "${credName}" not found on disk or in preset`);
      }
    }
  }

  // Custom headers (override defaults)
  if (params.headers) {
    for (const [key, value] of Object.entries(params.headers)) {
      headers[key] = ctx.interpolate(value);
    }
  }

  // Body
  let body: string | undefined;
  if (params.body && method !== "GET" && method !== "HEAD") {
    if (typeof params.body === "string") {
      body = ctx.interpolate(params.body);
    } else {
      body = JSON.stringify(params.body, (_key, value) => {
        if (typeof value === "string" && value.includes("{{")) {
          return ctx.evaluate(value);
        }
        return value;
      });
    }
  }

  const timeout = params.timeout ?? 30_000;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url.toString(), {
      method,
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timer);

    // Parse response body
    const contentType = response.headers.get("content-type") ?? "";
    let responseBody: unknown;
    if (contentType.includes("application/json")) {
      responseBody = await response.json();
    } else {
      responseBody = await response.text();
    }

    // Validate status
    const statusOk = params.validateStatus
      ? Boolean(ctx.evaluate(params.validateStatus.replace(/\bstatus\b/g, String(response.status))))
      : response.ok;

    const output = {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: responseBody,
    };

    if (!statusOk) {
      return makeResult(step.id, "failure", output, start, startedAt, `HTTP ${response.status} ${response.statusText}`);
    }

    return makeResult(step.id, "success", output, start, startedAt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return makeResult(step.id, "failure", null, start, startedAt, message);
  }
}

registerStepHandler("http", httpHandler);
```

**Step 2: Verify**

Run: `tsgo --noEmit 2>&1 | rg "automate"`

Expected: No type errors

**Step 3: Commit**

```bash
git add src/automate/lib/steps/http.ts
git commit -m "feat(automate): add HTTP step handler with native fetch and credential support"
```

---

### Task 6: File Step Handler **[MVP]**

**Files:**
- Create: `src/automate/lib/steps/file.ts`

Uses Bun file APIs and `glob` (already in deps).

**Step 1: Write the handler**

Create `src/automate/lib/steps/file.ts`:

```typescript
import { existsSync, mkdirSync, unlinkSync, renameSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { glob } from "glob";
import { registerStepHandler } from "../registry";
import type { StepContext, StepDefinition } from "../registry";
import type { FileStepParams, StepResult } from "../types";
import { makeResult } from "./helpers";

async function fileHandler(step: StepDefinition, ctx: StepContext): Promise<StepResult> {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const params = step.params as FileStepParams;
  const subAction = step.action.split(".")[1];

  try {
    switch (subAction) {
      case "read": {
        const filePath = resolve(ctx.interpolate(params.path!));
        if (!existsSync(filePath)) {
          return makeResult(step.id, "failure", null, start, startedAt, `File not found: ${filePath}`);
        }
        const content = await Bun.file(filePath).text();
        return makeResult(step.id, "success", { path: filePath, content, size: content.length }, start, startedAt);
      }

      case "write": {
        const filePath = resolve(ctx.interpolate(params.path!));
        const content = ctx.interpolate(params.content ?? "");
        const dir = dirname(filePath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        await Bun.write(filePath, content);
        return makeResult(step.id, "success", { path: filePath, size: content.length }, start, startedAt);
      }

      case "copy": {
        const source = resolve(ctx.interpolate(params.source!));
        const destination = resolve(ctx.interpolate(params.destination!));
        if (!existsSync(source)) {
          return makeResult(step.id, "failure", null, start, startedAt, `Source not found: ${source}`);
        }
        const destDir = dirname(destination);
        if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
        copyFileSync(source, destination);
        return makeResult(step.id, "success", { source, destination }, start, startedAt);
      }

      case "move": {
        const source = resolve(ctx.interpolate(params.source!));
        const destination = resolve(ctx.interpolate(params.destination!));
        if (!existsSync(source)) {
          return makeResult(step.id, "failure", null, start, startedAt, `Source not found: ${source}`);
        }
        const destDir = dirname(destination);
        if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
        renameSync(source, destination);
        return makeResult(step.id, "success", { source, destination }, start, startedAt);
      }

      case "delete": {
        const filePath = resolve(ctx.interpolate(params.path!));
        const existed = existsSync(filePath);
        if (existed) unlinkSync(filePath);
        return makeResult(step.id, "success", { path: filePath, existed }, start, startedAt);
      }

      case "glob": {
        const pattern = ctx.interpolate(params.pattern!);
        const cwd = params.cwd ? resolve(ctx.interpolate(params.cwd)) : process.cwd();
        const files = await glob(pattern, { absolute: true, nodir: true, cwd });
        return makeResult(step.id, "success", { pattern, cwd, files, count: files.length }, start, startedAt);
      }

      case "template": {
        let templateContent: string;
        if (params.templatePath) {
          const tplPath = resolve(ctx.interpolate(params.templatePath));
          if (!existsSync(tplPath)) {
            return makeResult(step.id, "failure", null, start, startedAt, `Template not found: ${tplPath}`);
          }
          templateContent = await Bun.file(tplPath).text();
        } else {
          templateContent = params.content ?? "";
        }

        // Apply explicit variables first
        let rendered = templateContent;
        if (params.variables) {
          for (const [key, value] of Object.entries(params.variables)) {
            const resolvedValue = ctx.interpolate(value);
            rendered = rendered.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "g"), resolvedValue);
          }
        }
        // Then run through the main expression interpolator
        rendered = ctx.interpolate(rendered);

        // Write to file if path specified, otherwise return rendered content
        if (params.path) {
          const outPath = resolve(ctx.interpolate(params.path));
          const dir = dirname(outPath);
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          await Bun.write(outPath, rendered);
          return makeResult(step.id, "success", { path: outPath, content: rendered }, start, startedAt);
        }

        return makeResult(step.id, "success", { content: rendered }, start, startedAt);
      }

      default:
        return makeResult(step.id, "failure", null, start, startedAt, `Unknown file action: ${subAction}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return makeResult(step.id, "failure", null, start, startedAt, message);
  }
}

registerStepHandler("file", fileHandler);
```

**Step 2: Verify**

Run: `tsgo --noEmit 2>&1 | rg "automate"`

Expected: No type errors

**Step 3: Commit**

```bash
git add src/automate/lib/steps/file.ts
git commit -m "feat(automate): add file step handler (read/write/copy/move/delete/glob/template)"
```

---

### Task 7: Git Step Handler **[MVP]**

**Files:**
- Create: `src/automate/lib/steps/git.ts`

Thin wrappers around the existing `createGit()` utility from `src/utils/git/core.ts`.

**Step 1: Write the handler**

Create `src/automate/lib/steps/git.ts`:

```typescript
import { createGit } from "@app/utils/git/core";
import { registerStepHandler } from "../registry";
import type { StepContext, StepDefinition } from "../registry";
import type { GitStepParams, StepResult } from "../types";
import { makeResult } from "./helpers";

async function gitHandler(step: StepDefinition, ctx: StepContext): Promise<StepResult> {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const params = (step.params ?? {}) as GitStepParams;
  const subAction = step.action.split(".")[1];
  const cwd = params.cwd ? ctx.interpolate(params.cwd) : process.cwd();
  const git = createGit({ cwd });

  try {
    switch (subAction) {
      case "status": {
        const hasChanges = await git.hasUncommittedChanges();
        const branch = await git.getCurrentBranch();
        const result = await git.executor.exec(["status", "--porcelain"]);
        const files = result.stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => ({
            status: line.substring(0, 2).trim(),
            path: line.substring(3),
          }));
        return makeResult(step.id, "success", { branch, hasChanges, files }, start, startedAt);
      }

      case "commit": {
        const message = ctx.interpolate(params.message ?? "Automated commit");
        const files = params.files?.map((f) => ctx.interpolate(f));

        if (files && files.length > 0) {
          await git.executor.execOrThrow(["add", ...files]);
        } else {
          await git.executor.execOrThrow(["add", "-A"]);
        }

        const result = await git.executor.exec(["commit", "-m", message]);
        if (!result.success) {
          if (result.stdout.includes("nothing to commit")) {
            return makeResult(step.id, "success", { committed: false, message: "Nothing to commit" }, start, startedAt);
          }
          return makeResult(step.id, "failure", null, start, startedAt, result.stderr);
        }

        const sha = await git.getShortSha("HEAD");
        return makeResult(step.id, "success", { committed: true, sha, message }, start, startedAt);
      }

      case "branch": {
        const branchName = ctx.interpolate(params.branch!);
        const from = params.from ? ctx.interpolate(params.from) : undefined;
        await git.createBranch(branchName, from);
        return makeResult(step.id, "success", { branch: branchName }, start, startedAt);
      }

      case "diff": {
        const from = params.from ? ctx.interpolate(params.from) : "HEAD~1";
        const to = params.to ? ctx.interpolate(params.to) : "HEAD";
        const result = await git.executor.exec(["diff", `${from}..${to}`]);
        return makeResult(step.id, "success", { from, to, diff: result.stdout }, start, startedAt);
      }

      case "log": {
        const limit = params.limit ?? 10;
        const from = params.from ? ctx.interpolate(params.from) : undefined;
        const to = params.to ? ctx.interpolate(params.to) : "HEAD";

        const logArgs = from
          ? ["log", "--oneline", `${from}..${to}`, `-${limit}`]
          : ["log", "--oneline", `-${limit}`];

        const result = await git.executor.exec(logArgs);
        const commits = result.stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const spaceIdx = line.indexOf(" ");
            return {
              sha: line.substring(0, spaceIdx),
              message: line.substring(spaceIdx + 1),
            };
          });
        return makeResult(step.id, "success", { commits, count: commits.length }, start, startedAt);
      }

      default:
        return makeResult(step.id, "failure", null, start, startedAt, `Unknown git action: ${subAction}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return makeResult(step.id, "failure", null, start, startedAt, message);
  }
}

registerStepHandler("git", gitHandler);
```

**Step 2: Verify**

Run: `tsgo --noEmit 2>&1 | rg "automate"`

Expected: No type errors

**Step 3: Commit**

```bash
git add src/automate/lib/steps/git.ts
git commit -m "feat(automate): add git step handler wrapping existing createGit() utilities"
```

---

### Task 8: Transform Step Handlers (JSON, Text, Array) **[MVP]**

**Files:**
- Create: `src/automate/lib/steps/transform.ts`

Uses `jsonpath` (already in deps) for JSON queries.

**Step 1: Write the handler**

Create `src/automate/lib/steps/transform.ts`:

```typescript
import jsonpath from "jsonpath";
import { registerStepHandler } from "../registry";
import type { StepContext, StepDefinition } from "../registry";
import type { ArrayStepParams, JsonStepParams, StepResult, TextStepParams } from "../types";
import { makeResult } from "./helpers";

// --- JSON Handler ---

async function jsonHandler(step: StepDefinition, ctx: StepContext): Promise<StepResult> {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const params = step.params as JsonStepParams;
  const subAction = step.action.split(".")[1];

  try {
    switch (subAction) {
      case "parse": {
        const input = ctx.interpolate(params.input!);
        const parsed = JSON.parse(input);
        return makeResult(step.id, "success", parsed, start, startedAt);
      }

      case "stringify": {
        const input = ctx.evaluate(params.input!);
        const indent = params.indent ?? 2;
        const result = JSON.stringify(input, null, indent);
        return makeResult(step.id, "success", result, start, startedAt);
      }

      case "query": {
        const input = ctx.evaluate(params.input!);
        const query = ctx.interpolate(params.query!);
        const result = jsonpath.query(input, query);
        return makeResult(step.id, "success", result, start, startedAt);
      }

      default:
        return makeResult(step.id, "failure", null, start, startedAt, `Unknown json action: ${subAction}`);
    }
  } catch (error) {
    return makeResult(step.id, "failure", null, start, startedAt, error instanceof Error ? error.message : String(error));
  }
}

// --- Text Handler ---

async function textHandler(step: StepDefinition, ctx: StepContext): Promise<StepResult> {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const params = step.params as TextStepParams;
  const subAction = step.action.split(".")[1];

  try {
    switch (subAction) {
      case "regex": {
        const input = String(ctx.evaluate(params.input!) ?? "");
        const pattern = ctx.interpolate(params.pattern!);
        const flags = params.flags ?? "g";
        const regex = new RegExp(pattern, flags);

        if (params.replacement !== undefined) {
          const result = input.replace(regex, ctx.interpolate(params.replacement));
          return makeResult(step.id, "success", { result, matchCount: (input.match(regex) ?? []).length }, start, startedAt);
        }

        const globalFlags = flags.includes("g") ? flags : `${flags}g`;
        const matches = Array.from(input.matchAll(new RegExp(pattern, globalFlags))).map((m) => ({
          match: m[0],
          groups: m.groups ?? {},
          index: m.index,
        }));
        return makeResult(step.id, "success", { matches, count: matches.length }, start, startedAt);
      }

      case "template": {
        const template = ctx.interpolate(params.template!);
        return makeResult(step.id, "success", template, start, startedAt);
      }

      case "split": {
        const input = String(ctx.evaluate(params.input!) ?? "");
        const separator = ctx.interpolate(params.separator ?? "\n");
        return makeResult(step.id, "success", input.split(separator), start, startedAt);
      }

      case "join": {
        const input = ctx.evaluate(params.input!) as string[];
        const separator = ctx.interpolate(params.separator ?? "\n");
        return makeResult(step.id, "success", input.join(separator), start, startedAt);
      }

      default:
        return makeResult(step.id, "failure", null, start, startedAt, `Unknown text action: ${subAction}`);
    }
  } catch (error) {
    return makeResult(step.id, "failure", null, start, startedAt, error instanceof Error ? error.message : String(error));
  }
}

// --- Array Handler ---

async function arrayHandler(step: StepDefinition, ctx: StepContext): Promise<StepResult> {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const params = step.params as ArrayStepParams;
  const subAction = step.action.split(".")[1];

  try {
    const input = ctx.evaluate(params.input!) as unknown[];
    if (!Array.isArray(input)) {
      return makeResult(step.id, "failure", null, start, startedAt, "Input is not an array");
    }

    switch (subAction) {
      case "filter": {
        const expression = params.expression!;
        const result = input.filter((item, index) =>
          Boolean(
            ctx.evaluate(
              expression.replace(/\bitem\b/g, JSON.stringify(item)).replace(/\bindex\b/g, String(index)),
            ),
          ),
        );
        return makeResult(step.id, "success", result, start, startedAt);
      }

      case "map": {
        const expression = params.expression!;
        const result = input.map((item, index) =>
          ctx.evaluate(
            expression.replace(/\bitem\b/g, JSON.stringify(item)).replace(/\bindex\b/g, String(index)),
          ),
        );
        return makeResult(step.id, "success", result, start, startedAt);
      }

      case "sort": {
        const key = params.key;
        const order = params.order ?? "asc";
        const sorted = [...input].sort((a, b) => {
          const va = key ? (a as Record<string, unknown>)[key] : a;
          const vb = key ? (b as Record<string, unknown>)[key] : b;
          const cmp = va < vb ? -1 : va > vb ? 1 : 0;
          return order === "asc" ? cmp : -cmp;
        });
        return makeResult(step.id, "success", sorted, start, startedAt);
      }

      case "flatten": {
        const result = input.flat(Infinity);
        return makeResult(step.id, "success", result, start, startedAt);
      }

      default:
        return makeResult(step.id, "failure", null, start, startedAt, `Unknown array action: ${subAction}`);
    }
  } catch (error) {
    return makeResult(step.id, "failure", null, start, startedAt, error instanceof Error ? error.message : String(error));
  }
}

// --- Register all ---

registerStepHandler("json", jsonHandler);
registerStepHandler("text", textHandler);
registerStepHandler("array", arrayHandler);
```

**Step 2: Verify**

Run: `tsgo --noEmit 2>&1 | rg "automate"`

Expected: No type errors

**Step 3: Commit**

```bash
git add src/automate/lib/steps/transform.ts
git commit -m "feat(automate): add json/text/array transform step handlers"
```

---

### Task 9: Notification Step Handler **[MVP]**

**Files:**
- Create: `src/automate/lib/steps/notify.ts`

Uses `clipboardy` (already in deps) and macOS `osascript`/`afplay` for desktop notifications and sounds.

**Step 1: Write the handler**

Create `src/automate/lib/steps/notify.ts`:

```typescript
import clipboardy from "clipboardy";
import { registerStepHandler } from "../registry";
import type { StepContext, StepDefinition } from "../registry";
import type { NotifyStepParams, StepResult } from "../types";
import { makeResult } from "./helpers";

async function notifyHandler(step: StepDefinition, ctx: StepContext): Promise<StepResult> {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const params = step.params as NotifyStepParams;
  const subAction = step.action.split(".")[1];

  try {
    switch (subAction) {
      case "desktop": {
        const title = ctx.interpolate(params.title ?? "GenesisTools Automate");
        const message = ctx.interpolate(params.message ?? "");
        const escapedTitle = title.replace(/"/g, '\\"');
        const escapedMsg = message.replace(/"/g, '\\"');
        const proc = Bun.spawn({
          cmd: [
            "osascript",
            "-e",
            `display notification "${escapedMsg}" with title "${escapedTitle}"`,
          ],
          stdio: ["ignore", "pipe", "pipe"],
        });
        await proc.exited;
        return makeResult(step.id, "success", { title, message }, start, startedAt);
      }

      case "clipboard": {
        const content = ctx.interpolate(params.content ?? params.message ?? "");
        await clipboardy.write(content);
        return makeResult(step.id, "success", { copied: true, length: content.length }, start, startedAt);
      }

      case "sound": {
        const sound = params.sound ?? "Glass";
        const soundPath = `/System/Library/Sounds/${sound}.aiff`;
        const proc = Bun.spawn({
          cmd: ["afplay", soundPath],
          stdio: ["ignore", "pipe", "pipe"],
        });
        await proc.exited;
        return makeResult(step.id, "success", { sound }, start, startedAt);
      }

      default:
        return makeResult(step.id, "failure", null, start, startedAt, `Unknown notify action: ${subAction}`);
    }
  } catch (error) {
    return makeResult(step.id, "failure", null, start, startedAt, error instanceof Error ? error.message : String(error));
  }
}

registerStepHandler("notify", notifyHandler);
```

**macOS system sounds available for `notify.sound`:** Basso, Blow, Bottle, Frog, Funk, Glass, Hero, Morse, Ping, Pop, Purr, Sosumi, Submarine, Tink

**Step 2: Verify**

Run: `tsgo --noEmit 2>&1 | rg "automate"`

Expected: No type errors

**Step 3: Commit**

```bash
git add src/automate/lib/steps/notify.ts
git commit -m "feat(automate): add notification step handler (desktop/clipboard/sound)"
```

---

### Task 10: Parallel Execution Handler **[MVP]**

**Files:**
- Create: `src/automate/lib/steps/parallel.ts`

Uses `Promise.all` (fail-fast) or `Promise.allSettled` (best-effort) depending on `onError`.

**Step 1: Write the handler**

Create `src/automate/lib/steps/parallel.ts`:

```typescript
import { registerStepHandler, resolveStepHandler } from "../registry";
import type { StepContext, StepDefinition } from "../registry";
import type { ParallelStepParams, StepResult } from "../types";
import { makeResult } from "./helpers";

async function parallelHandler(step: StepDefinition, ctx: StepContext): Promise<StepResult> {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const params = step.params as ParallelStepParams;
  const onError = params.onError ?? "stop";

  if (!params.steps || params.steps.length === 0) {
    return makeResult(step.id, "failure", null, start, startedAt, "Parallel step has no child step IDs");
  }

  // Look up child step definitions from the full preset
  // The engine must inject __allSteps into the context
  const allSteps = ctx.evaluate("__allSteps") as StepDefinition[] | undefined;
  if (!allSteps) {
    return makeResult(step.id, "failure", null, start, startedAt, "Engine did not inject __allSteps into context");
  }

  const childSteps = params.steps.map((id) => {
    const found = allSteps.find((s) => s.id === id);
    if (!found) throw new Error(`Parallel step "${step.id}" references unknown step ID: "${id}"`);
    return found;
  });

  const executeChild = async (childStep: StepDefinition): Promise<StepResult> => {
    const handler = resolveStepHandler(childStep.action);
    if (!handler) {
      return makeResult(childStep.id, "failure", null, start, startedAt, `Unknown action: ${childStep.action}`);
    }
    return handler(childStep, ctx);
  };

  const output: Record<string, StepResult> = {};
  let failureCount = 0;

  if (onError === "stop") {
    try {
      const results = await Promise.all(childSteps.map(executeChild));
      for (const result of results) {
        output[result.id] = result;
        ctx.steps[result.id] = result;
        if (result.status === "failure") failureCount++;
      }
    } catch (error) {
      return makeResult(step.id, "failure", output, start, startedAt, error instanceof Error ? error.message : String(error));
    }
  } else {
    const settled = await Promise.allSettled(childSteps.map(executeChild));
    for (const entry of settled) {
      if (entry.status === "fulfilled") {
        output[entry.value.id] = entry.value;
        ctx.steps[entry.value.id] = entry.value;
        if (entry.value.status === "failure") failureCount++;
      } else {
        failureCount++;
      }
    }
  }

  const status = failureCount === 0 ? "success" : "failure";
  const error = failureCount > 0 ? `${failureCount}/${childSteps.length} parallel steps failed` : undefined;
  return makeResult(step.id, status, output, start, startedAt, error);
}

registerStepHandler("parallel", parallelHandler);
```

**Engine integration required:** The engine must:
1. Inject `__allSteps` into context so parallel can look up step definitions by ID.
2. Before the step loop, collect all step IDs referenced by `parallel` steps and skip them in the main sequential loop (they run inside the parallel handler).

Add this to `engine.ts` before the step execution loop:

```typescript
// Inject __allSteps for parallel handler
const originalEvaluate = ctx.evaluate;
ctx.evaluate = (expr: string) => {
  if (expr === "__allSteps") return preset.steps;
  return originalEvaluate(expr);
};

// Collect parallel child IDs to skip in main loop
const parallelChildIds = new Set<string>();
for (const s of preset.steps) {
  if (s.action === "parallel" && s.params) {
    const pParams = s.params as ParallelStepParams;
    if (pParams.steps) {
      for (const childId of pParams.steps) {
        parallelChildIds.add(childId);
      }
    }
  }
}

// In the step loop, add at the top:
// if (parallelChildIds.has(step.id)) continue;
```

**Step 2: Verify**

Run: `tsgo --noEmit 2>&1 | rg "automate"`

Expected: No type errors

**Step 3: Commit**

```bash
git add src/automate/lib/steps/parallel.ts src/automate/lib/engine.ts
git commit -m "feat(automate): add parallel step handler with Promise.all/allSettled"
```

---

### Task 11: Loop (forEach / while) Handler **[MVP]**

**Files:**
- Create: `src/automate/lib/steps/loop.ts`

Supports sequential and parallel forEach with bounded concurrency via `Promise.allSettled`.

**Step 1: Write the handler**

Create `src/automate/lib/steps/loop.ts`:

```typescript
import { registerStepHandler, resolveStepHandler } from "../registry";
import type { StepContext, StepDefinition } from "../registry";
import type { ForEachStepParams, StepResult, WhileStepParams } from "../types";
import { makeResult } from "./helpers";

// --- forEach ---

async function forEachHandler(step: StepDefinition, ctx: StepContext): Promise<StepResult> {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const params = step.params as ForEachStepParams;

  const items = ctx.evaluate(params.items) as unknown[];
  if (!Array.isArray(items)) {
    return makeResult(step.id, "failure", null, start, startedAt, `forEach items did not resolve to an array: ${params.items}`);
  }

  const itemVar = params.as ?? "item";
  const indexVar = params.indexAs ?? "index";
  const concurrency = params.concurrency ?? 1;
  const childStep = params.step;
  const handler = resolveStepHandler(childStep.action);

  if (!handler) {
    return makeResult(step.id, "failure", null, start, startedAt, `Unknown action in forEach body: ${childStep.action}`);
  }

  const results: StepResult[] = [];

  const processItem = async (item: unknown, index: number): Promise<StepResult> => {
    // Create a child context with item/index injected
    const childCtx: StepContext = {
      ...ctx,
      evaluate: (expr: string) => {
        if (expr === itemVar) return item;
        if (expr === indexVar) return index;
        if (expr.startsWith(`${itemVar}.`)) {
          const path = expr.substring(itemVar.length + 1);
          return path.split(".").reduce<unknown>((obj, key) => {
            return obj && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined;
          }, item);
        }
        return ctx.evaluate(expr);
      },
      interpolate: (template: string) => {
        // Replace {{ item }}, {{ item.prop }}, {{ index }} first, then delegate
        let result = template.replace(/\{\{\s*item(?:\.[\w.]+)?\s*\}\}/g, (match) => {
          const expr = match.replace(/\{\{\s*|\s*\}\}/g, "");
          const val = childCtx.evaluate(expr);
          return typeof val === "string" ? val : JSON.stringify(val);
        });
        result = result.replace(/\{\{\s*index\s*\}\}/g, String(index));
        return ctx.interpolate(result);
      },
    };

    const iterationStep: StepDefinition = {
      ...childStep,
      id: `${step.id}[${index}]`,
    };

    return handler(iterationStep, childCtx);
  };

  if (concurrency <= 1) {
    // Sequential
    for (let i = 0; i < items.length; i++) {
      const result = await processItem(items[i], i);
      results.push(result);
      ctx.steps[`${step.id}[${i}]`] = result;
    }
  } else {
    // Parallel with bounded concurrency
    for (let i = 0; i < items.length; i += concurrency) {
      const batch = items.slice(i, i + concurrency);
      const batchResults = await Promise.allSettled(
        batch.map((item, batchIdx) => processItem(item, i + batchIdx)),
      );
      for (const [batchIdx, entry] of batchResults.entries()) {
        const globalIdx = i + batchIdx;
        if (entry.status === "fulfilled") {
          results.push(entry.value);
          ctx.steps[`${step.id}[${globalIdx}]`] = entry.value;
        } else {
          const failResult = makeResult(
            `${step.id}[${globalIdx}]`,
            "failure",
            null,
            start,
            startedAt,
            entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
          );
          results.push(failResult);
          ctx.steps[`${step.id}[${globalIdx}]`] = failResult;
        }
      }
    }
  }

  const failureCount = results.filter((r) => r.status === "failure").length;
  const outputs = results.map((r) => r.output);

  return makeResult(
    step.id,
    failureCount === 0 ? "success" : "failure",
    { results: outputs, count: items.length, failures: failureCount },
    start,
    startedAt,
    failureCount > 0 ? `${failureCount}/${items.length} iterations failed` : undefined,
  );
}

// --- while ---

async function whileHandler(step: StepDefinition, ctx: StepContext): Promise<StepResult> {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const params = step.params as WhileStepParams;
  const maxIterations = params.maxIterations ?? 100;
  const childStep = params.step;
  const handler = resolveStepHandler(childStep.action);

  if (!handler) {
    return makeResult(step.id, "failure", null, start, startedAt, `Unknown action in while body: ${childStep.action}`);
  }

  const results: StepResult[] = [];
  let iteration = 0;

  while (iteration < maxIterations) {
    const conditionResult = ctx.evaluate(params.condition);
    if (!conditionResult) break;

    const iterationStep: StepDefinition = {
      ...childStep,
      id: `${step.id}[${iteration}]`,
    };

    const result = await handler(iterationStep, ctx);
    results.push(result);
    ctx.steps[`${step.id}[${iteration}]`] = result;

    if (result.status === "failure" && step.onError !== "continue") break;

    iteration++;
  }

  const failureCount = results.filter((r) => r.status === "failure").length;

  return makeResult(
    step.id,
    failureCount === 0 ? "success" : "failure",
    { results: results.map((r) => r.output), iterations: iteration, failures: failureCount },
    start,
    startedAt,
    iteration >= maxIterations
      ? `Hit max iterations (${maxIterations})`
      : failureCount > 0
        ? `${failureCount} iterations failed`
        : undefined,
  );
}

registerStepHandler("forEach", forEachHandler);
registerStepHandler("while", whileHandler);
```

**Step 2: Verify**

Run: `tsgo --noEmit 2>&1 | rg "automate"`

Expected: No type errors

**Step 3: Commit**

```bash
git add src/automate/lib/steps/loop.ts
git commit -m "feat(automate): add forEach/while loop handlers with bounded concurrency"
```

---

### Task 12: Handler Auto-Registration **[MVP]**

**Files:**
- Create: `src/automate/lib/steps/index.ts`
- Modify: `src/automate/lib/engine.ts`

Import all step handlers from a single barrel file so the engine just needs one import to register everything.

**Step 1: Write the barrel file**

Create `src/automate/lib/steps/index.ts`:

```typescript
/**
 * Import all step handler modules to trigger their registerStepHandler() calls.
 * The engine imports this file once at startup.
 */
import "./http";
import "./file";
import "./git";
import "./transform";
import "./notify";
import "./parallel";
import "./loop";
```

**Step 2: Add import to engine**

At the top of `src/automate/lib/engine.ts`, add:

```typescript
// Register all step handlers
import "./steps/index";
```

**Step 3: Verify**

Run: `tsgo --noEmit 2>&1 | rg "automate"`

Expected: No type errors

**Step 4: Commit**

```bash
git add src/automate/lib/steps/index.ts src/automate/lib/engine.ts
git commit -m "feat(automate): add step handler barrel file for auto-registration"
```

---

### Task 13: Example Preset -- Weekly Git Summary **[Nice-to-have]**

**Files:**
- Create: `src/automate/presets/weekly-git-summary.json`

**Step 1: Write the preset**

Create `src/automate/presets/weekly-git-summary.json`:

```json
{
  "$schema": "genesis-tools-preset-v1",
  "name": "Weekly Git Summary",
  "description": "Get recent commits, format as markdown, copy to clipboard",
  "trigger": { "type": "manual" },
  "steps": [
    {
      "id": "log",
      "name": "Get recent commits",
      "action": "git.log",
      "params": {
        "limit": 50
      }
    },
    {
      "id": "format",
      "name": "Format as markdown",
      "action": "text.template",
      "params": {
        "template": "# Weekly Git Summary\n\nCommits: {{ steps.log.output.count }}\n\n{{ steps.log.output.commits }}"
      }
    },
    {
      "id": "copy",
      "name": "Copy to clipboard",
      "action": "notify.clipboard",
      "params": {
        "content": "{{ steps.format.output }}"
      }
    },
    {
      "id": "done",
      "name": "Show notification",
      "action": "notify.desktop",
      "params": {
        "title": "Git Summary",
        "message": "{{ steps.log.output.count }} commits copied to clipboard"
      }
    }
  ]
}
```

**Step 2: Verify**

Run: `cat src/automate/presets/weekly-git-summary.json | tools json`

Expected: Valid JSON output

**Step 3: Commit**

```bash
git add src/automate/presets/weekly-git-summary.json
git commit -m "feat(automate): add weekly git summary example preset"
```

---

### Task 14: Example Preset -- API Health Check **[Nice-to-have]**

**Files:**
- Create: `src/automate/presets/api-health-check.json`

**Step 1: Write the preset**

Create `src/automate/presets/api-health-check.json`:

```json
{
  "$schema": "genesis-tools-preset-v1",
  "name": "API Health Check",
  "description": "Check multiple API endpoints and notify on results",
  "trigger": { "type": "manual" },
  "vars": {
    "endpoints": {
      "type": "string",
      "description": "Comma-separated list of URLs to check",
      "default": "https://httpstat.us/200,https://httpstat.us/500"
    }
  },
  "steps": [
    {
      "id": "split-urls",
      "name": "Parse endpoint list",
      "action": "text.split",
      "params": {
        "input": "{{ vars.endpoints }}",
        "separator": ","
      }
    },
    {
      "id": "check-all",
      "name": "Check all endpoints",
      "action": "forEach",
      "params": {
        "items": "{{ steps.split-urls.output }}",
        "concurrency": 5,
        "step": {
          "id": "check",
          "name": "Check endpoint",
          "action": "http.get",
          "params": {
            "url": "{{ item }}",
            "timeout": 10000
          }
        }
      }
    },
    {
      "id": "notify",
      "name": "Report results",
      "action": "notify.desktop",
      "params": {
        "title": "API Health Check",
        "message": "Checked {{ steps.check-all.output.count }} endpoints, {{ steps.check-all.output.failures }} failures"
      }
    }
  ]
}
```

**Step 2: Verify**

Run: `cat src/automate/presets/api-health-check.json | tools json`

Expected: Valid JSON output

**Step 3: Commit**

```bash
git add src/automate/presets/api-health-check.json
git commit -m "feat(automate): add API health check example preset"
```

---

### Task 15: Example Preset -- Project Backup **[Nice-to-have]**

**Files:**
- Create: `src/automate/presets/project-backup.json`

**Step 1: Write the preset**

Create `src/automate/presets/project-backup.json`:

```json
{
  "$schema": "genesis-tools-preset-v1",
  "name": "Project Backup",
  "description": "Glob important files and copy to a backup directory",
  "trigger": { "type": "manual" },
  "vars": {
    "sourceDir": { "type": "string", "description": "Source directory", "default": "." },
    "backupDir": { "type": "string", "description": "Backup destination", "default": "./backup" },
    "pattern": { "type": "string", "description": "Glob pattern for files", "default": "**/*.{ts,json,md}" }
  },
  "steps": [
    {
      "id": "find-files",
      "name": "Find important files",
      "action": "file.glob",
      "params": {
        "pattern": "{{ vars.pattern }}",
        "cwd": "{{ vars.sourceDir }}"
      }
    },
    {
      "id": "copy-files",
      "name": "Copy files to backup",
      "action": "forEach",
      "params": {
        "items": "{{ steps.find-files.output.files }}",
        "concurrency": 10,
        "step": {
          "id": "copy",
          "name": "Copy file",
          "action": "file.copy",
          "params": {
            "source": "{{ item }}",
            "destination": "{{ vars.backupDir }}/{{ item }}"
          }
        }
      }
    },
    {
      "id": "notify",
      "name": "Backup complete",
      "action": "notify.desktop",
      "params": {
        "title": "Backup Complete",
        "message": "Backed up {{ steps.find-files.output.count }} files to {{ vars.backupDir }}"
      }
    }
  ]
}
```

**Step 2: Verify**

Run: `cat src/automate/presets/project-backup.json | tools json`

Expected: Valid JSON output

**Step 3: Commit**

```bash
git add src/automate/presets/project-backup.json
git commit -m "feat(automate): add project backup example preset"
```

---

### Task 16: Example Preset -- PR Review Digest **[Nice-to-have]**

**Files:**
- Create: `src/automate/presets/pr-review-digest.json`

**Step 1: Write the preset**

Create `src/automate/presets/pr-review-digest.json`:

```json
{
  "$schema": "genesis-tools-preset-v1",
  "name": "PR Review Digest",
  "description": "Fetch open PRs needing review and create a markdown digest",
  "trigger": { "type": "manual" },
  "vars": {
    "owner": { "type": "string", "description": "GitHub org/owner", "required": true },
    "repo": { "type": "string", "description": "GitHub repository name", "required": true }
  },
  "steps": [
    {
      "id": "fetch-prs",
      "name": "Fetch open PRs",
      "action": "http.get",
      "params": {
        "url": "https://api.github.com/repos/{{ vars.owner }}/{{ vars.repo }}/pulls",
        "query": { "state": "open", "sort": "updated", "direction": "desc" },
        "headers": {
          "Accept": "application/vnd.github.v3+json",
          "Authorization": "Bearer {{ env.GITHUB_TOKEN }}"
        }
      }
    },
    {
      "id": "extract",
      "name": "Extract PR summaries",
      "action": "json.query",
      "params": {
        "input": "{{ steps.fetch-prs.output.body }}",
        "query": "$[*].{title: title, number: number, author: user.login, url: html_url}"
      }
    },
    {
      "id": "format",
      "name": "Format as markdown",
      "action": "text.template",
      "params": {
        "template": "# PR Review Digest\n\n_{{ vars.owner }}/{{ vars.repo }}_\n\n{{ steps.extract.output }}"
      }
    },
    {
      "id": "save",
      "name": "Save digest to file",
      "action": "file.write",
      "params": {
        "path": "./pr-digest.md",
        "content": "{{ steps.format.output }}"
      }
    },
    {
      "id": "copy",
      "name": "Copy to clipboard",
      "action": "notify.clipboard",
      "params": {
        "content": "{{ steps.format.output }}"
      }
    }
  ]
}
```

**Step 2: Verify**

Run: `cat src/automate/presets/pr-review-digest.json | tools json`

Expected: Valid JSON output

**Step 3: Commit**

```bash
git add src/automate/presets/pr-review-digest.json
git commit -m "feat(automate): add PR review digest example preset"
```

---

### Task 17: CLI Credential Subcommand **[Nice-to-have]**

**Files:**
- Create: `src/automate/commands/credentials.ts`
- Modify: `src/automate/index.ts`

**Step 1: Write the credentials command**

Create `src/automate/commands/credentials.ts`:

```typescript
import * as p from "@clack/prompts";
import pc from "picocolors";
import { Command } from "commander";
import {
  saveCredential,
  loadCredential,
  listCredentials,
  deleteCredential,
} from "@app/automate/lib/credentials";
import type { CredentialType, StoredCredential } from "@app/automate/lib/types";

export function registerCredentialsCommand(program: Command): void {
  const cmd = program
    .command("credentials")
    .alias("creds")
    .description("Manage stored credentials");

  cmd
    .command("add <name>")
    .description("Add or update a credential")
    .action(async (name: string) => {
      p.intro(pc.bgCyan(pc.black(" credentials add ")));

      const type = await p.select<{ value: CredentialType; label: string }[]>({
        message: "Credential type:",
        options: [
          { value: "bearer", label: "Bearer token" },
          { value: "basic", label: "Basic auth (username/password)" },
          { value: "apikey", label: "API key (custom header)" },
          { value: "custom", label: "Custom headers" },
        ],
      });
      if (p.isCancel(type)) { p.cancel("Cancelled"); process.exit(0); }

      const credential: StoredCredential = { name, type: type as CredentialType };

      switch (type) {
        case "bearer": {
          const token = await p.text({
            message: "Token (or {{ env.VAR }} expression):",
            placeholder: "{{ env.GITHUB_TOKEN }}",
          });
          if (p.isCancel(token)) { p.cancel("Cancelled"); process.exit(0); }
          credential.token = token;
          break;
        }
        case "basic": {
          const username = await p.text({ message: "Username:" });
          if (p.isCancel(username)) { p.cancel("Cancelled"); process.exit(0); }
          const password = await p.text({ message: "Password (or {{ env.VAR }}):" });
          if (p.isCancel(password)) { p.cancel("Cancelled"); process.exit(0); }
          credential.username = username;
          credential.password = password;
          break;
        }
        case "apikey": {
          const headerName = await p.text({
            message: "Header name:",
            placeholder: "X-API-Key",
            defaultValue: "X-API-Key",
          });
          if (p.isCancel(headerName)) { p.cancel("Cancelled"); process.exit(0); }
          const key = await p.text({ message: "Key value (or {{ env.VAR }}):" });
          if (p.isCancel(key)) { p.cancel("Cancelled"); process.exit(0); }
          credential.headerName = headerName;
          credential.key = key;
          break;
        }
        case "custom": {
          p.log.info(pc.dim("Enter headers as key=value pairs. Empty line to finish."));
          const headers: Record<string, string> = {};
          let addMore = true;
          while (addMore) {
            const header = await p.text({
              message: "Header (key=value):",
              placeholder: "X-Custom-Header={{ env.MY_SECRET }}",
            });
            if (p.isCancel(header)) { p.cancel("Cancelled"); process.exit(0); }
            if (!header) break;
            const eqIdx = header.indexOf("=");
            if (eqIdx > 0) {
              headers[header.substring(0, eqIdx)] = header.substring(eqIdx + 1);
            }
            const cont = await p.confirm({ message: "Add another header?", initialValue: false });
            if (p.isCancel(cont)) { p.cancel("Cancelled"); process.exit(0); }
            addMore = cont;
          }
          credential.headers = headers;
          break;
        }
      }

      await saveCredential(credential);
      p.outro(pc.green(`Credential "${name}" saved (0600 permissions)`));
    });

  cmd
    .command("list")
    .alias("ls")
    .description("List all stored credentials")
    .action(() => {
      const names = listCredentials();
      if (names.length === 0) {
        console.log(pc.dim("No credentials stored."));
        return;
      }
      for (const name of names) {
        console.log(`  ${pc.cyan(name)}`);
      }
      console.log(pc.dim(`\n${names.length} credential(s) at ~/.genesis-tools/automate/credentials/`));
    });

  cmd
    .command("show <name>")
    .description("Show credential details (values masked)")
    .action(async (name: string) => {
      const cred = await loadCredential(name);
      if (!cred) {
        console.log(pc.red(`Credential "${name}" not found`));
        process.exit(1);
      }
      console.log(`  ${pc.bold("Name:")} ${cred.name}`);
      console.log(`  ${pc.bold("Type:")} ${cred.type}`);
      // Mask sensitive values
      for (const [key, value] of Object.entries(cred)) {
        if (key === "name" || key === "type") continue;
        if (typeof value === "string") {
          const masked = value.startsWith("{{") ? value : `${value.substring(0, 4)}${"*".repeat(Math.max(0, value.length - 4))}`;
          console.log(`  ${pc.bold(`${key}:`)} ${pc.dim(masked)}`);
        }
      }
    });

  cmd
    .command("delete <name>")
    .description("Delete a credential")
    .action((name: string) => {
      const deleted = deleteCredential(name);
      if (deleted) {
        console.log(pc.green(`Credential "${name}" deleted`));
      } else {
        console.log(pc.red(`Credential "${name}" not found`));
      }
    });
}
```

**Step 2: Register in index.ts**

In `src/automate/index.ts`, add:

```typescript
import { registerCredentialsCommand } from "@app/automate/commands/credentials";

// After existing command registrations:
registerCredentialsCommand(program);
```

**Step 3: Verify**

Run: `tsgo --noEmit 2>&1 | rg "automate"`

Expected: No type errors

**Step 4: Commit**

```bash
git add src/automate/commands/credentials.ts src/automate/index.ts
git commit -m "feat(automate): add credential CLI (add/list/show/delete)"
```

---

## Directory Structure (Final)

```
src/automate/
  index.ts                          # CLI entry point (base plan, modified)
  commands/
    run.ts                          # Base plan
    list.ts                         # Base plan
    show.ts                         # Base plan
    create.ts                       # Base plan
    credentials.ts                  # NEW (Task 17)
  lib/
    types.ts                        # Extended (Task 2)
    schema.ts                       # Base plan
    engine.ts                       # Modified (Tasks 1, 10, 12)
    expressions.ts                  # Base plan
    step-runner.ts                  # Base plan
    builtins.ts                     # Base plan
    storage.ts                      # Base plan
    registry.ts                     # NEW (Task 1)
    credentials.ts                  # NEW (Task 3)
    steps/
      index.ts                      # NEW (Task 12) -- barrel import
      helpers.ts                    # NEW (Task 4)
      http.ts                       # NEW (Task 5)
      file.ts                       # NEW (Task 6)
      git.ts                        # NEW (Task 7)
      transform.ts                  # NEW (Task 8)
      notify.ts                     # NEW (Task 9)
      parallel.ts                   # NEW (Task 10)
      loop.ts                       # NEW (Task 11)
  presets/
    weekly-git-summary.json         # NEW (Task 13)
    api-health-check.json           # NEW (Task 14)
    project-backup.json             # NEW (Task 15)
    pr-review-digest.json           # NEW (Task 16)
```

## Storage Layout

```
~/.genesis-tools/automate/
  presets/                          # User preset JSON files (base plan)
  credentials/                      # Credential files with 0600 permissions
    github-api.json
    slack-webhook.json
  config.json                       # Run metadata (base plan via Storage class)
  cache/                            # Cache (base plan via Storage class)
```

---

## Dependency Summary

**No new dependencies required.** All dependencies already exist in `package.json`:

| Dependency | Used By | Already Installed |
|------------|---------|:-:|
| native `fetch` | HTTP steps | Bun built-in |
| `glob` | file.glob | Yes |
| `jsonpath` | json.query | Yes |
| `clipboardy` | notify.clipboard | Yes |
| `chalk` / `picocolors` | CLI output | Yes |
| `@clack/prompts` | Credential CLI | Yes |
| `commander` | CLI commands | Yes |
| `src/utils/git/core.ts` | Git steps | Local |
| `src/utils/async.ts` | Bounded concurrency reference | Local |

---

## Implementation Order

| Order | Task | Priority | Depends On |
|:-----:|------|:--------:|:----------:|
| 1 | Task 1: Step Handler Registry | MVP | Base framework |
| 2 | Task 2: Extended Type Definitions | MVP | Task 1 |
| 3 | Task 3: Credential System | MVP | Task 2 |
| 4 | Task 4: Shared `makeResult` Helper | MVP | Task 2 |
| 5 | Task 5: HTTP Step Handler | MVP | Tasks 3, 4 |
| 6 | Task 6: File Step Handler | MVP | Task 4 |
| 7 | Task 7: Git Step Handler | MVP | Task 4 |
| 8 | Task 8: Transform Steps (json/text/array) | MVP | Task 4 |
| 9 | Task 9: Notification Steps | MVP | Task 4 |
| 10 | Task 10: Parallel Execution | MVP | Task 4 + engine mod |
| 11 | Task 11: Loop (forEach/while) | MVP | Task 4 + engine mod |
| 12 | Task 12: Handler Auto-Registration | MVP | Tasks 5-11 |
| 13 | Task 13: Weekly Git Summary preset | Nice-to-have | Tasks 7, 8, 9 |
| 14 | Task 14: API Health Check preset | Nice-to-have | Tasks 5, 8, 9, 11 |
| 15 | Task 15: Project Backup preset | Nice-to-have | Tasks 6, 9, 11 |
| 16 | Task 16: PR Review Digest preset | Nice-to-have | Tasks 5, 6, 8, 9 |
| 17 | Task 17: CLI Credential Subcommand | Nice-to-have | Task 3 |

---

## Verification Strategy

Since the project has no test suite, verify via:

1. **Type checking after every task:** `tsgo --noEmit 2>&1 | rg "automate"`
2. **Manual preset runs after Task 12:**
   ```bash
   # Copy an example preset to user presets dir
   cp src/automate/presets/weekly-git-summary.json ~/.genesis-tools/automate/presets/

   # Run it
   tools automate run weekly-git-summary

   # Dry run
   tools automate run weekly-git-summary --dry-run
   ```
3. **Credential flow after Task 17:**
   ```bash
   tools automate credentials add test-token
   tools automate credentials list
   tools automate credentials show test-token
   tools automate credentials delete test-token
   ```
4. **Check logs on failure:** `ls logs/` for debug output from `@app/logger`

---

## Security Notes

1. **Credentials stored with 0600 permissions** -- only the owning user can read/write
2. **No secrets in preset JSON** -- presets reference credentials by name or use `{{ env.VAR }}` expressions
3. **Expression evaluation uses `new Function()`** -- acceptable for a local CLI tool where the user writes their own presets; not suitable for untrusted preset execution
4. **File operations go through `resolve()`** -- prevents relative path confusion
5. **All HTTP requests have configurable timeouts** (default 30s) via AbortController
6. **While loops have safety `maxIterations`** limit (default 100)
