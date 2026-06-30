# Stash Tool v1.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v1.1 of `tools stash` — close the 10-item deferred backlog from v1, unify the update + unapply UX behind one walk machine, settle the curate-after-apply workflow, and close audit-finding D-31 (regions table never populated).

**Architecture:** Three sequential waves, each shippable as its own PR. Wave 1 = unified walk + standalone update + save same-name confirm + D-31 + `tools stash diff` + `--patch` picker + shared UI util promotion + diff renderer swap. Wave 2 = apply-conflict state machine + author-marker-aware unapply. Wave 3 = doctor + rebase-project + tree-hash detection. Each task is TDD-shaped (failing test → minimal impl → passing test → commit).

**Tech Stack:** Bun (no compile step), TypeScript strict, `bun:sqlite`, `commander`, `@clack/prompts`, `chalk`, the project's `@app/logger` + `@app/utils/cli` + `@app/utils/json` + `@app/utils/diff` (extended with `renderUnifiedDiff`), `diff` npm package for pure-JS unified-diff rendering.

**Spec:** `.claude/plans/2026-06-25-StashTool-spec.md` (Martin + Claude session 7cb77c59).

**Audit context:** `.claude/plans/2026-06-24-StashTool-spec.md` and `2026-06-24-StashTool-plan.md` were the v1 source. The 2026-06-25 audit found 11 BUG-RISK divergences between the v1 plan and v1 code — 10 are pre-fixed in v1 code, only D-31 remains active. This plan preserves the v1 fixes and closes D-31.

---

## File Structure

### Wave 1 — new files

- `src/utils/cli/ui.ts` — promoted from `src/stash/lib/ui.ts`. Project-wide blessed pattern for high-density CLI stderr status without clack's box-drawing.
- `src/stash/lib/walk.ts` — extracted shared decision-walk machinery. Used by both `update` and `unapply`. Carries the v1 correctness fixes (D-22/D-23/D-25) explicitly.
- `src/stash/lib/walk.test.ts` — unit tests for the walk primitives.
- `src/stash/lib/patch-picker.ts` — interactive `git add -p`-style hunk picker for `--patch` save mode.
- `src/stash/lib/patch-picker.test.ts` — unit tests for hunk picker.
- `src/stash/commands/diff.ts` — new `tools stash diff <name>` command.
- `src/stash/commands/diff.test.ts` — integration test for diff.
- `src/stash/lib/stash-migrations.ts` — adds `002-populate-regions-table` migration.

### Wave 1 — modified files

- `src/stash/lib/ui.ts` — becomes a re-export shim from `@app/utils/cli/ui` (back-compat for in-tree imports).
- `src/utils/diff.ts` — adds `renderUnifiedDiff(before, after, opts) → string` pure-JS function via `diff` package.
- `src/stash/lib/diff-render.ts` — internals swapped to call `renderUnifiedDiff` from `@app/utils/diff`.
- `src/stash/commands/save.ts` — adds same-name aggregate-diff confirm; adds `regions` table INSERTs; switches `--patch` to use the new picker.
- `src/stash/commands/unapply.ts` — refactored to consume `lib/walk.ts` while preserving D-22/D-23/D-25.
- `src/stash/commands/update.ts` — rewritten as standalone walk-driven command (was a thin wrapper over `saveCommand`).
- `src/stash/index.ts` — wires `diff` subcommand; updates `update` flags; adds `--force-bump` to save; adds `--patch` to save.
- `src/stash/lib/unapply-session.ts` — extracts `verb` field for tagged union; migrates v1 state files on load.

### Wave 2 — new files

- `src/stash/lib/apply-session.ts` — state machine for apply conflicts (mirrors `walk.ts`'s shape but lighter — conflict resolution, not per-region decisions).
- `src/stash/lib/apply-session.test.ts` — tests.
- `src/stash/lib/region-split.ts` — split a hunk into named sub-regions at author-marker boundaries.
- `src/stash/lib/region-split.test.ts` — tests.

### Wave 2 — modified files

- `src/stash/commands/apply.ts` — invokes `apply-session.ts` on conflict.
- `src/stash/commands/unapply.ts` — uses `region-split.ts` when bootstrapping the session.
- `src/stash/index.ts` — wires `apply --resume` / `apply --abort`.

### Wave 3 — new files

- `src/stash/commands/doctor.ts` + `doctor.test.ts` — consistency check + `--rebuild`.
- `src/stash/commands/rebase-project.ts` + tests — re-point applications to a moved project path.
- `src/stash/lib/sibling-clone-tree-hash.ts` + tests — Jaccard-similarity fallback for sibling-clone detection.

### Wave 3 — modified files

- `src/stash/lib/projects.ts` — calls tree-hash detection when origin URL + dir-pattern miss.
- `src/stash/index.ts` — wires `doctor` and `rebase-project` subcommands.

---

# Wave 1 — Unified Walk + Curate-After-Apply Foundation

Ten tasks. Each one is shippable on its own; the wave ships as a single PR for coherence. Test-first throughout. Manual smoke after each task before committing.

---

### Task 1: Promote `src/stash/lib/ui.ts` → `src/utils/cli/ui.ts`

**Why:** Multiple commands across stash already use it; the v1.1 logging-discipline decision (§13 of spec) is to bless it as a project-wide pattern. Move the file, leave a re-export shim, update root CLAUDE.md to document the pattern. Future tools that want high-density stderr status without clack box-drawing import from `@app/utils/cli/ui`.

**Files:**
- Create: `src/utils/cli/ui.ts` (copy of `src/stash/lib/ui.ts`)
- Modify: `src/stash/lib/ui.ts` (becomes one-line re-export shim)
- Modify: `CLAUDE.md` (root) — adds a paragraph to "Logging & output" section pointing at the new util
- Modify: `scripts/ci/logging-guard.sh` — carve-out so `import { ui } from "@app/utils/cli/ui"` doesn't trip the guard
- Test: `src/utils/cli/ui.test.ts` (new — basic API smoke test)

- [ ] **Step 1: Write the failing test**

Create `src/utils/cli/ui.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { ui } from "./ui";

describe("ui (high-density stderr status)", () => {
    test("exposes ok/info/warn/err/dim/header/kv/section/raw functions", () => {
        for (const fn of ["ok", "info", "warn", "err", "dim", "header", "kv", "section", "raw"] as const) {
            expect(typeof ui[fn]).toBe("function");
        }
    });

    test("ok writes a green-prefixed line to stderr", () => {
        // Capture stderr by stubbing process.stderr.write
        const writes: string[] = [];
        const orig = process.stderr.write.bind(process.stderr);
        // @ts-expect-error — test stub
        process.stderr.write = (chunk: string) => {
            writes.push(typeof chunk === "string" ? chunk : chunk.toString());
            return true;
        };
        try {
            ui.ok("done");
        } finally {
            process.stderr.write = orig;
        }
        expect(writes.join("")).toContain("done");
        expect(writes.join("")).toContain("✓"); // chalk green checkmark in output
    });

    test("kv pads keys to keyWidth", () => {
        const writes: string[] = [];
        const orig = process.stderr.write.bind(process.stderr);
        // @ts-expect-error — test stub
        process.stderr.write = (chunk: string) => {
            writes.push(typeof chunk === "string" ? chunk : chunk.toString());
            return true;
        };
        try {
            ui.kv("a", "1");
        } finally {
            process.stderr.write = orig;
        }
        // Default keyWidth = 9 → "  a        1\n"  (2 leading spaces, key padded to 9, then value)
        expect(writes.join("")).toMatch(/  a {8}1/);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/utils/cli/ui.test.ts`
Expected: FAIL — `Cannot find module './ui'`.

- [ ] **Step 3: Create `src/utils/cli/ui.ts`**

Copy the body of `src/stash/lib/ui.ts` verbatim into `src/utils/cli/ui.ts`. Do NOT change the public API — exports stay byte-identical.

```typescript
import chalk from "chalk";

/**
 * Plain status writes for high-density CLIs. Bypasses clack's task-lifecycle box-drawing
 * (`│ ◆ ●`) which is the wrong texture for commands that print many short status lines.
 * Interactive PROMPTS still use @clack/prompts; this is purely for one-shot status output.
 *
 * All status goes to STDERR so `tool show --diff > foo.diff` (and similar) still capture
 * only the machine-readable payload via `out.print` / `out.result`.
 */

function write(line: string): void {
    process.stderr.write(`${line}\n`);
}

export const ui = {
    ok(msg: string): void {
        write(`${chalk.green("✓")} ${msg}`);
    },
    info(msg: string): void {
        write(`${chalk.cyan("ℹ")} ${msg}`);
    },
    warn(msg: string): void {
        write(`${chalk.yellow("⚠")} ${msg}`);
    },
    err(msg: string): void {
        write(`${chalk.red("✗")} ${msg}`);
    },
    dim(msg: string): void {
        write(chalk.dim(msg));
    },
    header(msg: string): void {
        write(chalk.bold(msg));
    },
    /** Print a 2-column key/value pair, right-padded key for tidy alignment. */
    kv(key: string, value: string, keyWidth = 9): void {
        write(`  ${chalk.dim(key.padEnd(keyWidth))}${value}`);
    },
    /** Section break — a blank line plus a dim rule. Used before lists/diffs. */
    section(title: string): void {
        write("");
        write(chalk.dim(`── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`));
    },
    /** Bare write to stderr without any chalk decoration. */
    raw(msg: string): void {
        write(msg);
    },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/utils/cli/ui.test.ts`
Expected: PASS, 3 expect() calls.

- [ ] **Step 5: Replace `src/stash/lib/ui.ts` with re-export shim**

```typescript
/**
 * Compat shim — `lib/ui.ts` was promoted to `@app/utils/cli/ui` in v1.1 (see spec §13).
 * In-tree stash files keep this import path; new tools should import from `@app/utils/cli/ui`.
 */
export { ui } from "@app/utils/cli/ui";
```

- [ ] **Step 6: Update root `CLAUDE.md`'s "Logging & output" section**

Find the section that lists `logger` and `out`. Append after the existing bullets:

```markdown
- **`@app/utils/cli/ui` — high-density CLI status.** For tools that emit many short status lines per command (e.g. `tools stash`), clack's `│ ◆ ●` box-drawing is the wrong texture. Import `{ ui }` from `@app/utils/cli/ui` to get plain stderr writes with chalk decoration (`ui.ok/info/warn/err/dim/header/kv/section/raw`). Use this INSTEAD of `out.log.*` for high-density status; keep `out.log.*` for clack-shaped task lifecycles. `out.print()` / `out.result()` are still the only writers to stdout for machine-readable output.
```

- [ ] **Step 7: Update `scripts/ci/logging-guard.sh` to allow the new import path**

Find the rule that flags non-`@app/logger` imports. Add `@app/utils/cli/ui` to the allowlist. The exact change depends on the guard's structure; if it's a `grep -v` pattern list, add a line:

```bash
| grep -v '@app/utils/cli/ui'
```

If the guard uses a regex, extend the allowlist regex accordingly. Read the file first; make the surgical edit only.

- [ ] **Step 8: Run all stash tests + logging guard**

```bash
bun test src/utils/cli/ui.test.ts src/stash/
bash scripts/ci/logging-guard.sh
```

Expected: 80+ tests pass (existing stash count + the 3 new ui ones); logging guard exits 0.

- [ ] **Step 9: Commit**

```bash
git add src/utils/cli/ui.ts src/utils/cli/ui.test.ts src/stash/lib/ui.ts CLAUDE.md scripts/ci/logging-guard.sh
git commit -m "refactor(utils): promote stash's lib/ui.ts to @app/utils/cli/ui

Bless the chalk-based stderr status pattern as a project-wide utility for
high-density CLIs where clack's box-drawing is the wrong texture. Stash's
in-tree ui.ts becomes a back-compat re-export shim. Per v1.1 spec §13."
```

---

### Task 2: Add `renderUnifiedDiff` to `@app/utils/diff` (pure-JS, jsdiff-backed)

**Why:** v1's `lib/diff-render.ts` shells out to system `diff` via temp files (audit-flagged D-28). `src/utils/diff.ts` ALSO shells out (via `DiffUtil.showDiff`). v1.1 spec §12 picks "pure-JS, no shell-out" as the direction. Add a `renderUnifiedDiff` export to `@app/utils/diff` using the `diff` npm package (jsdiff, ~30 KB, battle-tested). Existing `DiffUtil.showDiff` stays for back-compat but the new code uses the pure-JS path.

**Files:**
- Modify: `package.json` (add `diff` and `@types/diff` deps)
- Modify: `src/utils/diff.ts` — add `renderUnifiedDiff` export
- Test: `src/utils/diff.test.ts` — new (no existing test file)

- [ ] **Step 1: Add `diff` package**

```bash
bun add diff
bun add -d @types/diff
```

Confirm `package.json` shows `"diff": "^7.0.0"` (or whatever current major is) under deps and `"@types/diff"` under devDependencies.

- [ ] **Step 2: Write the failing test**

Create `src/utils/diff.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { renderUnifiedDiff } from "./diff";

describe("renderUnifiedDiff", () => {
    test("returns a unified diff between two strings", () => {
        const before = "alpha\nbeta\ngamma\n";
        const after = "alpha\nBETA\ngamma\n";
        const diff = renderUnifiedDiff({ before, after, label: "test.txt" });
        expect(diff).toContain("--- a/test.txt");
        expect(diff).toContain("+++ b/test.txt");
        expect(diff).toContain("-beta");
        expect(diff).toContain("+BETA");
    });

    test("returns empty string when before === after", () => {
        const same = "no change\n";
        expect(renderUnifiedDiff({ before: same, after: same, label: "x" })).toBe("");
    });

    test("respects context option (default 3, configurable)", () => {
        const before = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].join("\n") + "\n";
        const after = before.replace("5", "FIVE");
        const ctx0 = renderUnifiedDiff({ before, after, label: "x", context: 0 });
        const ctx3 = renderUnifiedDiff({ before, after, label: "x", context: 3 });
        // Larger context → more lines in the output.
        expect(ctx3.split("\n").length).toBeGreaterThan(ctx0.split("\n").length);
    });

    test("does NOT shell out to system diff binary", async () => {
        // Synchronous + no I/O guarantee: completes within a tight time bound, no awaitable returned.
        const result = renderUnifiedDiff({ before: "a\n", after: "b\n", label: "x" });
        expect(typeof result).toBe("string"); // sync, not Promise
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/utils/diff.test.ts`
Expected: FAIL — `renderUnifiedDiff is not a function` (or `not exported`).

- [ ] **Step 4: Implement `renderUnifiedDiff`**

Add to `src/utils/diff.ts` (alongside the existing `DiffUtil` class):

```typescript
import { createPatch } from "diff";

export interface RenderUnifiedDiffArgs {
    before: string;
    after: string;
    /** File label used in the `--- a/<label> / +++ b/<label>` headers. */
    label: string;
    /** Unified-diff context radius (lines). Default: 3 (matches `git diff` default). */
    context?: number;
}

/**
 * Pure-JS unified diff. No shell-out, no temp files, synchronous. Backed by jsdiff
 * (`diff` package). Returns "" when before === after so callers can early-exit cheaply.
 *
 * Output format matches `git diff` shape: `--- a/<label>\n+++ b/<label>\n@@ ... @@\n...`.
 * The two trailing newlines on the header that `createPatch` includes are stripped so the
 * output composes cleanly when concatenated.
 */
export function renderUnifiedDiff(args: RenderUnifiedDiffArgs): string {
    if (args.before === args.after) {
        return "";
    }
    const patch = createPatch(args.label, args.before, args.after, "", "", { context: args.context ?? 3 });
    // jsdiff's createPatch emits `Index: <name>\n===\n--- <oldHeader>\n+++ <newHeader>\n...`.
    // Strip the `Index:` + `===` lines so the output starts directly at the `---` header — that's
    // what every other diff renderer in this codebase emits and what `git apply` parses.
    const lines = patch.split("\n");
    const firstMinus = lines.findIndex((l) => l.startsWith("---"));
    if (firstMinus === -1) {
        return patch;
    }
    return lines.slice(firstMinus).join("\n");
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/utils/diff.test.ts`
Expected: PASS, 4 expect() calls.

- [ ] **Step 6: Type-check**

```bash
tsgo --noEmit src/utils/diff.ts src/utils/diff.test.ts | rg 'error' | head
```

Expected: no output (clean).

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock src/utils/diff.ts src/utils/diff.test.ts
git commit -m "feat(utils/diff): add pure-JS renderUnifiedDiff via jsdiff

Closes the v1 audit's D-28 by removing the shell-out-to-system-diff pattern
for in-memory diff rendering. Existing DiffUtil.showDiff (which shells out)
stays for back-compat; new code uses renderUnifiedDiff. Per v1.1 spec §12."
```

---

### Task 3: Swap `src/stash/lib/diff-render.ts` internals to use `renderUnifiedDiff`

**Why:** Now that the pure-JS `renderUnifiedDiff` exists, stash's `diff-render.ts` should delegate to it instead of running its own `spawnSync("diff", ...)` shell-out. Public API of `lib/diff-render.ts` stays unchanged — callers (`unapply.ts`) keep working.

**Files:**
- Modify: `src/stash/lib/diff-render.ts`
- Test: existing tests must still pass; no new test file needed (the existing renderer test in `unapply` e2e covers the surface)

- [ ] **Step 1: Read current `lib/diff-render.ts`**

```bash
cat src/stash/lib/diff-render.ts
```

Note the exported function name (likely `renderDiff`) and its signature.

- [ ] **Step 2: Write a focused test for the new internals**

Create or extend `src/stash/lib/diff-render.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { renderDiff } from "./diff-render";

describe("renderDiff (delegates to @app/utils/diff renderUnifiedDiff)", () => {
    test("returns a string containing unified-diff headers", () => {
        const out = renderDiff({ before: "old\n", after: "new\n", label: "file.ts" });
        expect(out).toContain("--- a/file.ts");
        expect(out).toContain("+++ b/file.ts");
        expect(out).toContain("-old");
        expect(out).toContain("+new");
    });

    test("returns empty string when before === after", () => {
        const out = renderDiff({ before: "same\n", after: "same\n", label: "x" });
        expect(out).toBe("");
    });

    test("is synchronous (does not spawn external process)", () => {
        const start = Bun.nanoseconds();
        renderDiff({ before: "a\n", after: "b\n", label: "x" });
        const elapsedMs = (Bun.nanoseconds() - start) / 1e6;
        // Shell-out floor on macOS is ~10-50ms even for trivial diffs; pure-JS is sub-ms.
        expect(elapsedMs).toBeLessThan(5);
    });
});
```

- [ ] **Step 3: Run test to confirm CURRENT behavior fails the speed assertion**

Run: `bun test src/stash/lib/diff-render.test.ts`
Expected: FAIL on the "synchronous" test (current impl shells out, takes >5ms).

- [ ] **Step 4: Rewrite `lib/diff-render.ts` internals**

```typescript
import { renderUnifiedDiff } from "@app/utils/diff";

export interface RenderDiffArgs {
    before: string;
    after: string;
    label: string;
}

/**
 * Render a unified diff between two text blocks. Stash-tool wrapper over
 * `@app/utils/diff`'s renderUnifiedDiff — used by unapply / update walks to show per-region
 * before-vs-after, and by `tools stash diff` for the per-region inventory.
 *
 * v1.1: switched from shell-out (`spawnSync("diff", ...)` + temp files) to the pure-JS
 * jsdiff-backed implementation. Public API unchanged — callers don't need to update.
 */
export function renderDiff(args: RenderDiffArgs): string {
    return renderUnifiedDiff({ before: args.before, after: args.after, label: args.label });
}
```

If `renderDiff` had a different signature in v1, ADAPT it — keep callers compiling. Read the old file first.

- [ ] **Step 5: Run all stash tests to confirm no regression**

```bash
bun test src/stash/
```

Expected: same pass count as before (80+), 0 fails. The new `renderDiff` returns the same shape; only the underlying mechanism changed.

- [ ] **Step 6: Manual smoke**

In a scratch repo with an applied stash, run `tools stash unapply --status` then trigger a region diff prompt. Verify the diff renders cleanly.

```bash
cd /tmp && mkdir stash-smoke && cd stash-smoke && git init -q
echo "old" > f.ts && git add . && git commit -qm init
echo "new" > f.ts && tools stash save smoke --mode all
tools stash apply smoke
echo "edited" >> f.ts
tools stash unapply smoke   # walk should show diff via new renderer
tools stash unapply smoke --abort
```

Expected: the prompt's diff panel shows pure-JS rendered diff (no temp files in `/tmp/diff-*`).

- [ ] **Step 7: Commit**

```bash
git add src/stash/lib/diff-render.ts src/stash/lib/diff-render.test.ts
git commit -m "refactor(stash): swap diff-render to pure-JS renderUnifiedDiff

Internals now delegate to @app/utils/diff. No more shell-out to system diff
binary, no more temp files. Public API unchanged. Closes audit D-28 at the
stash-tool layer."
```

---

### Task 4: Extract shared walk machinery → `src/stash/lib/walk.ts`

**Why:** v1 has `UnapplySession` in `lib/unapply-session.ts` — a per-region decision walk with persistent state, classified regions, and a `--continue / --abort / --status` lifecycle. v1.1 needs the same machinery for `update`. Extracting it into a shared `lib/walk.ts` is cleaner than duplicating; both commands consume the walk and only differ in (a) the decision verb names they accept and (b) what they DO on completion.

**Files:**
- Create: `src/stash/lib/walk.ts`
- Create: `src/stash/lib/walk.test.ts`
- Modify: `src/stash/lib/unapply-session.ts` — becomes a thin verb-narrowed re-export plus a compat type alias

**Preserves audit-confirmed v1 correctness fixes** — call out explicitly in the PR description, test each:
- **D-22**: marker selection uses `byName[hunkIndex - 1]`, never `find()`.
- **D-23**: per-file region iteration is descending by hunkIndex during execute.
- **D-25**: `failedToFind` is tracked; > 0 means application stays `active`.

- [ ] **Step 1: Read current `unapply-session.ts` to lift the data shapes**

```bash
cat src/stash/lib/unapply-session.ts
```

Note: `Decision`, `SessionRegion`, `UnapplySession` class signature.

- [ ] **Step 2: Write the failing test**

Create `src/stash/lib/walk.test.ts`:

```typescript
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Walk, type WalkRegion } from "./walk";

let stateDir: string;
beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "walk-test-"));
});
afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
});

function mkRegion(overrides: Partial<WalkRegion> = {}): WalkRegion {
    return {
        id: "r1",
        filePath: "a.ts",
        hunkIndex: 1,
        klass: "edited",
        decision: null,
        storedContent: "old",
        currentContent: "new",
        ...overrides,
    };
}

describe("Walk", () => {
    test("start creates a snapshot and persists it", async () => {
        const walk = await Walk.start({
            verb: "update",
            stashId: "s1",
            stashName: "test",
            projectPath: "/p",
            projectHash: "abc",
            regions: [mkRegion()],
            stateDir,
            extension: { currentVersionId: "v1" },
        });
        expect(walk.snapshot().verb).toBe("update");
        expect(walk.regions()).toHaveLength(1);
        await walk.persist();
        // State file written to <stateDir>/<projectHash>--update--<stashId>.json
        const stateFile = join(stateDir, "abc--update--s1.json");
        const raw = JSON.parse(await readFile(stateFile, "utf8"));
        expect(raw.verb).toBe("update");
    });

    test("load resumes a persisted walk", async () => {
        const walk = await Walk.start({
            verb: "unapply",
            stashId: "s2",
            stashName: "test2",
            projectPath: "/p",
            projectHash: "def",
            regions: [mkRegion(), mkRegion({ id: "r2", hunkIndex: 2 })],
            stateDir,
            extension: {},
        });
        walk.decide("capture");
        await walk.persist();

        const loaded = await Walk.load({ stashId: "s2", projectHash: "def", stateDir });
        expect(loaded).not.toBeNull();
        expect(loaded?.snapshot().regions[0]?.decision).toBe("capture");
        expect(loaded?.snapshot().currentIndex).toBe(1);
    });

    test("decide advances currentIndex past already-decided regions", () => {
        const walk = new Walk(
            {
                verb: "update",
                stashId: "s",
                stashName: "n",
                projectPath: "/p",
                projectHash: "h",
                startedAt: "2026-06-25T00:00:00Z",
                regions: [mkRegion(), mkRegion({ id: "r2", hunkIndex: 2 }), mkRegion({ id: "r3", hunkIndex: 3 })],
                currentIndex: 0,
                pausedAt: null,
                extension: {},
            },
            stateDir
        );
        walk.decide("capture");
        expect(walk.snapshot().currentIndex).toBe(1);
        walk.decide("skip");
        expect(walk.snapshot().currentIndex).toBe(2);
    });

    test("unchanged regions are auto-decided as auto-capture at start", () => {
        const walk = new Walk(
            {
                verb: "update",
                stashId: "s",
                stashName: "n",
                projectPath: "/p",
                projectHash: "h",
                startedAt: "2026-06-25T00:00:00Z",
                regions: [
                    mkRegion({ klass: "unchanged", decision: "auto-capture", storedContent: "x", currentContent: "x" }),
                    mkRegion({ id: "r2", klass: "edited" }),
                ],
                currentIndex: 0,
                pausedAt: null,
                extension: {},
            },
            stateDir
        );
        expect(walk.currentRegion()?.id).toBe("r2"); // skips r1 (already decided)
    });

    test("abort removes the state file", async () => {
        const walk = await Walk.start({
            verb: "update",
            stashId: "s",
            stashName: "n",
            projectPath: "/p",
            projectHash: "h",
            regions: [mkRegion()],
            stateDir,
            extension: {},
        });
        await walk.persist();
        await walk.abort();
        // Loading should now return null
        const loaded = await Walk.load({ stashId: "s", projectHash: "h", stateDir });
        expect(loaded).toBeNull();
    });

    test("load returns null for v1 state files without `verb` field, BUT migrates them", async () => {
        // Simulate a v1 unapply-session.ts state file
        const stateFile = join(stateDir, "xyz--unapply--legacy.json");
        await import("node:fs/promises").then((fs) =>
            fs.writeFile(
                stateFile,
                JSON.stringify({
                    stashId: "legacy",
                    stashName: "old",
                    projectPath: "/p",
                    projectHash: "xyz",
                    startedAt: "2026-06-20T00:00:00Z",
                    regions: [mkRegion()],
                    currentIndex: 0,
                    pausedAt: null,
                })
            )
        );
        const loaded = await Walk.load({ stashId: "legacy", projectHash: "xyz", stateDir });
        expect(loaded).not.toBeNull();
        expect(loaded?.snapshot().verb).toBe("unapply"); // derived from filename
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/stash/lib/walk.test.ts`
Expected: FAIL — `walk.ts` doesn't exist.

- [ ] **Step 4: Implement `src/stash/lib/walk.ts`**

Lift the body of `src/stash/lib/unapply-session.ts` and generalize:

```typescript
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";

const { log } = logger.scoped("stash:walk");

export type Verb = "update" | "unapply";
export type Decision = "capture" | "restore" | "skip" | "auto-capture" | null;
export type RegionClass = "unchanged" | "edited" | "missing" | "new-extra";

export interface WalkRegion {
    id: string;
    filePath: string;
    hunkIndex: number;
    klass: RegionClass;
    /** null = not yet decided. `auto-capture` is reserved for unchanged regions (no prompt). */
    decision: Decision;
    storedContent: string | null;
    currentContent: string | null;
}

export interface WalkSnapshot {
    verb: Verb;
    stashId: string;
    stashName: string;
    projectPath: string;
    projectHash: string;
    startedAt: string;
    regions: WalkRegion[];
    currentIndex: number;
    pausedAt: string | null;
    /** Verb-specific data. Update: `{ currentVersionId, targetVNext }`. Unapply: `{}`. */
    extension: Record<string, unknown>;
}

export interface StartArgs {
    verb: Verb;
    stashId: string;
    stashName: string;
    projectPath: string;
    projectHash: string;
    regions: WalkRegion[];
    stateDir: string;
    extension: Record<string, unknown>;
}

export class Walk {
    constructor(
        private snap: WalkSnapshot,
        private stateDir: string
    ) {
        this.skipDecided();
    }

    static async start(args: StartArgs): Promise<Walk> {
        await mkdir(args.stateDir, { recursive: true });
        const snap: WalkSnapshot = {
            verb: args.verb,
            stashId: args.stashId,
            stashName: args.stashName,
            projectPath: args.projectPath,
            projectHash: args.projectHash,
            startedAt: new Date().toISOString(),
            regions: args.regions,
            currentIndex: 0,
            pausedAt: null,
            extension: args.extension,
        };
        const walk = new Walk(snap, args.stateDir);
        log.debug(
            { verb: args.verb, stashId: args.stashId, regions: args.regions.length },
            "walk started"
        );
        return walk;
    }

    static async load(args: {
        stashId: string;
        projectHash: string;
        stateDir: string;
    }): Promise<Walk | null> {
        // Walk file naming convention: <projectHash>--<verb>--<stashId>.json. The verb is in the
        // filename so a directory listing tells you what kind of in-progress session each file is.
        // For back-compat, v1 unapply state files have no `verb` field in the JSON — we derive it
        // from the filename and migrate on first load.
        for (const verb of ["update", "unapply"] as const) {
            const file = join(args.stateDir, `${args.projectHash}--${verb}--${args.stashId}.json`);
            try {
                const raw = await readFile(file, "utf8");
                const parsed = SafeJSON.parse(raw) as Partial<WalkSnapshot>;
                const snap: WalkSnapshot = {
                    verb: parsed.verb ?? verb,
                    stashId: parsed.stashId ?? args.stashId,
                    stashName: parsed.stashName ?? "",
                    projectPath: parsed.projectPath ?? "",
                    projectHash: parsed.projectHash ?? args.projectHash,
                    startedAt: parsed.startedAt ?? new Date().toISOString(),
                    regions: parsed.regions ?? [],
                    currentIndex: parsed.currentIndex ?? 0,
                    pausedAt: parsed.pausedAt ?? null,
                    extension: parsed.extension ?? {},
                };
                return new Walk(snap, args.stateDir);
            } catch (err) {
                // ENOENT = no session for this verb. Other errors bubble up so corruption surfaces.
                if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
                    log.warn({ err, file }, "walk state file unreadable");
                }
            }
        }
        return null;
    }

    currentRegion(): WalkRegion | null {
        return this.snap.regions[this.snap.currentIndex] ?? null;
    }

    regions(): WalkRegion[] {
        return this.snap.regions;
    }

    snapshot(): WalkSnapshot {
        return this.snap;
    }

    progress(): { decided: number; total: number } {
        const decided = this.snap.regions.filter((r) => r.decision !== null).length;
        return { decided, total: this.snap.regions.length };
    }

    decide(d: Exclude<Decision, null | "auto-capture">): void {
        const region = this.currentRegion();
        if (!region) {
            return;
        }
        region.decision = d;
        this.snap.currentIndex++;
        this.skipDecided();
    }

    isComplete(): boolean {
        return this.snap.regions.every((r) => r.decision !== null);
    }

    async persist(): Promise<void> {
        this.snap.pausedAt = new Date().toISOString();
        const file = this.stateFile();
        await writeFile(file, SafeJSON.stringify(this.snap, undefined, 2));
        log.debug({ file, currentIndex: this.snap.currentIndex }, "walk persisted");
    }

    async abort(): Promise<void> {
        await unlink(this.stateFile()).catch((err: NodeJS.ErrnoException) => {
            if (err.code !== "ENOENT") {
                throw err;
            }
        });
        log.debug({ stashId: this.snap.stashId, verb: this.snap.verb }, "walk aborted");
    }

    async complete(): Promise<void> {
        // Completing is the same disk-level operation as aborting (remove the state file). Logically
        // distinct so logs distinguish the two. Tests can grep for which one happened.
        await unlink(this.stateFile()).catch((err: NodeJS.ErrnoException) => {
            if (err.code !== "ENOENT") {
                throw err;
            }
        });
        log.debug({ stashId: this.snap.stashId, verb: this.snap.verb }, "walk completed");
    }

    private skipDecided(): void {
        while (
            this.snap.currentIndex < this.snap.regions.length &&
            this.snap.regions[this.snap.currentIndex]?.decision !== null
        ) {
            this.snap.currentIndex++;
        }
    }

    private stateFile(): string {
        return join(this.stateDir, `${this.snap.projectHash}--${this.snap.verb}--${this.snap.stashId}.json`);
    }
}
```

- [ ] **Step 5: Run tests**

```bash
bun test src/stash/lib/walk.test.ts
```

Expected: PASS, all 6 tests.

- [ ] **Step 6: Update `lib/unapply-session.ts` to re-export from `walk.ts`**

```typescript
/**
 * Compat shim — v1.1 generalized this into `lib/walk.ts` (shared with `update`).
 * In-tree code can keep importing from here; new code should import from `./walk`.
 */
export { Walk as UnapplySession, type WalkRegion as SessionRegion, type Decision } from "./walk";
```

NOTE: this DELIBERATELY makes `UnapplySession` a type alias for the new `Walk`. The old verb-locked-to-unapply behavior is gone — `Walk` requires a `verb` arg. The unapply command (Task 5) gets updated to pass `verb: "unapply"` explicitly.

- [ ] **Step 7: Run all stash tests**

```bash
bun test src/stash/
```

Expected: existing 80+ stash tests STILL PASS (because the shim re-exports). New 6 walk tests PASS. Total 86+.

If any unapply-session test fails, the API drifted in a way the shim doesn't cover. Read the failing test, narrow the gap.

- [ ] **Step 8: Commit**

```bash
git add src/stash/lib/walk.ts src/stash/lib/walk.test.ts src/stash/lib/unapply-session.ts
git commit -m "refactor(stash): extract UnapplySession → shared lib/walk.ts

Generalize the per-region decision walk so update + unapply share one machinery.
Adds a \`verb\` field to the snapshot and an \`extension\` blob for verb-specific
state. unapply-session.ts becomes a compat re-export. v1 state files without a
\`verb\` field load with verb derived from the filename. Per v1.1 spec §5."
```

---

### Task 5: Rewrite `src/stash/commands/update.ts` as a real walk-driven command

**Why:** v1's `update.ts` is a thin wrapper over `saveCommand` — it doesn't walk regions, doesn't classify divergence, doesn't preserve the baseline. v1.1 makes it a first-class command using the shared walk from Task 4. Semantics per spec §5.2: for each applied region, present `(stored, current)` to the user; their decision (`capture` / `restore` / `skip`) shapes v_next. On completion, `applications.version_id` advances to v_next.

**Files:**
- Modify: `src/stash/commands/update.ts` — full rewrite
- Modify: `src/stash/index.ts` — update CLI wiring (no flag changes; current `--mode` already there)
- Test: `src/stash/commands/update.test.ts` (new file)
- Modify: `src/stash/e2e.test.ts` — add an update-roundtrip test

- [ ] **Step 1: Read v1's update.ts to understand the current API surface**

```bash
cat src/stash/commands/update.ts
```

Note: it likely takes `{ name, mode }` and delegates to save. The new signature takes only `{ name }` (mode irrelevant — we read regions from applied site, not working-tree-by-mode).

- [ ] **Step 2: Write integration test for the walk-roundtrip**

Create `src/stash/commands/update.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCommand } from "./apply";
import { saveCommand } from "./save";
import { updateCommand } from "./update";
import { runGitIn } from "../lib/patch";

let work: string;
let repo: string;
let origCwd: string;
let origStashRoot: string | undefined;

beforeEach(async () => {
    origCwd = process.cwd();
    work = await mkdtemp(join(tmpdir(), "update-test-"));
    origStashRoot = process.env.GENESIS_TOOLS_STASH_ROOT;
    process.env.GENESIS_TOOLS_STASH_ROOT = join(work, ".genesis-tools", "stash");
    repo = join(work, "repo");
    await runGitIn(work, ["init", "repo", "--initial-branch=main"]);
    await runGitIn(repo, ["config", "user.email", "t@t"]);
    await runGitIn(repo, ["config", "user.name", "t"]);
    await writeFile(join(repo, "x.ts"), "export const x = 1;\n");
    await runGitIn(repo, ["add", "x.ts"]);
    await runGitIn(repo, ["commit", "-qm", "init"]);
});
afterEach(async () => {
    process.chdir(origCwd);
    if (origStashRoot !== undefined) process.env.GENESIS_TOOLS_STASH_ROOT = origStashRoot;
    else delete process.env.GENESIS_TOOLS_STASH_ROOT;
    await rm(work, { recursive: true, force: true });
});

describe("update command", () => {
    test("captures current code as v_next; applications.version_id advances", async () => {
        process.chdir(repo);
        // 1. Save v1 of a stash from working tree.
        await writeFile(join(repo, "x.ts"), "export const x = 1;\nconst log = (s: string) => console.log(s);\n");
        await saveCommand({ name: "logger", mode: "all", regions: undefined, tags: [], description: undefined });
        // 2. Reset and apply (round-trip in the same repo).
        await runGitIn(repo, ["checkout", "x.ts"]);
        await applyCommand({ name: "logger", verboseMarkers: false });
        // 3. Edit the applied region.
        const content = await readFile(join(repo, "x.ts"), "utf8");
        const edited = content.replace("console.log(s)", "console.warn(s)");
        await writeFile(join(repo, "x.ts"), edited);
        // 4. Run update with blanket capture decision.
        await updateCommand({ name: "logger", decision: "capture-all-dangerous" });
        // 5. Confirm v2 exists in the DB and applications.version_id advanced.
        const { Database } = await import("bun:sqlite");
        const { openStashDb } = await import("../lib/stash-db");
        const { StashStorage } = await import("../lib/storage");
        const db = openStashDb(new Database(new StashStorage().dbPath()));
        const versionCount = db
            .query<{ c: number }, []>("SELECT COUNT(*) as c FROM versions")
            .get();
        expect(versionCount?.c).toBe(2);
        const app = db
            .query<{ version: number }, []>(
                "SELECT v.version FROM applications a JOIN versions v ON a.version_id = v.id WHERE a.state = 'active'"
            )
            .get();
        expect(app?.version).toBe(2);
        db.close();
    });

    test("errors when stash is not applied in cwd", async () => {
        process.chdir(repo);
        await writeFile(join(repo, "x.ts"), "export const x = 1;\nconst log = (s: string) => console.log(s);\n");
        await saveCommand({ name: "unapplied", mode: "all", regions: undefined, tags: [], description: undefined });
        await runGitIn(repo, ["checkout", "x.ts"]);
        // Never applied — update should error.
        await expect(updateCommand({ name: "unapplied", decision: undefined })).rejects.toThrow(/not applied/i);
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/stash/commands/update.test.ts`
Expected: FAIL — `updateCommand` doesn't take `decision`, behavior differs.

- [ ] **Step 4: Rewrite `update.ts`**

```typescript
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@app/logger";
import { isInteractive, suggestCommand } from "@app/utils/cli";
import { classifyRegion } from "../lib/classify";
import { renderDiff } from "../lib/diff-render";
import { newStashId } from "../lib/ids";
import { parseMarkers } from "../lib/markers";
import { runGitIn } from "../lib/patch";
import { detectProject } from "../lib/projects";
import { extractRegionContent } from "../lib/regions";
import { openStashDb } from "../lib/stash-db";
import { StashStorage } from "../lib/storage";
import { StoreRepo } from "../lib/store-repo";
import { ui } from "../lib/ui";
import { type Decision, Walk, type WalkRegion } from "../lib/walk";
import type { ApplicationRow, StashRow, VersionRow } from "../types";

const { log } = logger.scoped("stash:update");

export interface UpdateOptions {
    name: string;
    decision?:
        | Exclude<Decision, null | "auto-capture">
        | "capture-all-dangerous"
        | "restore-all-dangerous"
        | undefined;
    action?: "start" | "continue" | "skip" | "abort" | "status";
}

export async function updateCommand(opts: UpdateOptions): Promise<void> {
    log.debug({ opts }, "updateCommand");
    const project = await detectProject(process.cwd());
    if (!project) {
        ui.err("not inside a git repository");
        process.exit(1);
    }

    const storage = new StashStorage();
    await storage.ensureDirs();
    const db = openStashDb(new Database(storage.dbPath()));

    const stash = db.query<StashRow, [string]>("SELECT * FROM stashes WHERE name = ?").get(opts.name);
    if (!stash) {
        ui.err(`stash "${opts.name}" not found`);
        db.close();
        process.exit(1);
    }

    const projectHash = createHash("sha256").update(project.rootPath).digest("hex").slice(0, 12);
    const action = opts.action ?? "start";

    // -- handle non-start actions first (--abort, --status, --skip) --
    if (action === "abort") {
        const w = await Walk.load({ stashId: stash.id, projectHash, stateDir: storage.stateDir() });
        if (!w || w.snapshot().verb !== "update") {
            ui.warn("no in-progress update session");
            db.close();
            return;
        }
        await w.abort();
        ui.ok("aborted");
        db.close();
        return;
    }

    if (action === "status") {
        const w = await Walk.load({ stashId: stash.id, projectHash, stateDir: storage.stateDir() });
        if (!w || w.snapshot().verb !== "update") {
            ui.info("no in-progress update session");
            db.close();
            return;
        }
        const p = w.progress();
        ui.info(`${p.decided}/${p.total} decided`);
        db.close();
        return;
    }

    // -- start or continue --
    let walk = await Walk.load({ stashId: stash.id, projectHash, stateDir: storage.stateDir() });
    if (walk && walk.snapshot().verb !== "update") {
        ui.err(`in-progress ${walk.snapshot().verb} session blocks update; resolve it first`);
        db.close();
        process.exit(1);
    }
    if (!walk) {
        walk = await bootstrap({ storage, db, stash, project, projectHash });
        if (!walk) {
            db.close();
            return; // bootstrap exits with a message
        }
    }

    // -- apply incoming decision --
    if (opts.decision === "capture-all-dangerous" || opts.decision === "restore-all-dangerous") {
        const blanket = opts.decision === "capture-all-dangerous" ? "capture" : "restore";
        const undecided = walk.regions().filter((r) => r.decision === null).length;
        ui.warn(`blanket decision: ${blanket} (applies to ${undecided} undecided regions)`);
        for (const r of walk.regions()) {
            if (r.decision === null) {
                r.decision = blanket;
            }
        }
    } else if (opts.decision) {
        if (walk.currentRegion()) {
            walk.decide(opts.decision);
        }
    } else if (action === "skip") {
        if (walk.currentRegion()) {
            walk.decide("skip");
        }
    }

    // -- interactive walk in TTY --
    if (isInteractive() && !walk.isComplete()) {
        await walkInteractive({ walk });
    }

    if (!walk.isComplete()) {
        await walk.persist();
        await emitNonTtyPrompt({ walk });
        db.close();
        return;
    }

    // -- execute decisions: build v_next, restore regions in code, write applications.version_id --
    await executeDecisions({ walk, projectRoot: project.rootPath, storage, db, stash });
    await walk.complete();
    db.close();
    log.debug({ stashId: stash.id }, "update complete");
}

async function bootstrap(args: {
    storage: StashStorage;
    db: Database;
    stash: StashRow;
    project: NonNullable<Awaited<ReturnType<typeof detectProject>>>;
    projectHash: string;
}): Promise<Walk | null> {
    const app = args.db
        .query<ApplicationRow, [string, string]>(
            "SELECT * FROM applications WHERE stash_id = ? AND project_path = ? AND state = 'active'"
        )
        .get(args.stash.id, args.project.rootPath);
    if (!app) {
        ui.err(`"${args.stash.name}" is not applied here — use 'save' to create a new stash from working tree, or 'apply' first then 'update'`);
        return null;
    }
    if (!app.version_id) {
        ui.err("application row has no version (orphaned); cannot update");
        return null;
    }
    const version = args.db
        .query<VersionRow, [string]>("SELECT * FROM versions WHERE id = ?")
        .get(app.version_id);
    if (!version) {
        ui.err("version row missing for active application");
        return null;
    }
    const repo = new StoreRepo(args.storage.storeRepoDir());
    const storedPatch = (await repo.readFileAt(version.patch_ref, "PATCH.diff")) ?? "";
    const regionMap = collectRegionsFromPatch(storedPatch); // copy from unapply.ts; identical logic
    const regions: WalkRegion[] = [];
    for (const r of regionMap) {
        const abs = join(args.project.rootPath, r.filePath);
        let fileContent: string | null;
        try {
            fileContent = await readFile(abs, "utf8");
        } catch {
            fileContent = null;
        }
        const present = fileContent ? parseMarkers(fileContent).some((m) => m.name === args.stash.name) : false;
        const currentContent = fileContent
            ? await extractRegionContent(abs, args.stash.name)
            : null;
        const klass = classifyRegion({
            storedContent: r.content,
            currentContent,
            present,
        }).klass;
        regions.push({
            id: newStashId(),
            filePath: r.filePath,
            hunkIndex: r.hunkIndex,
            klass,
            decision: klass === "unchanged" ? "auto-capture" : null,
            storedContent: r.content,
            currentContent,
        });
    }
    return await Walk.start({
        verb: "update",
        stashId: args.stash.id,
        stashName: args.stash.name,
        projectPath: args.project.rootPath,
        projectHash: args.projectHash,
        regions,
        stateDir: args.storage.stateDir(),
        extension: { currentVersionId: version.id, targetVNext: getNextVersionNumber(args.db, args.stash.id) },
    });
}

function getNextVersionNumber(db: Database, stashId: string): number {
    const m = db
        .query<{ m: number | null }, [string]>("SELECT MAX(version) as m FROM versions WHERE stash_id = ?")
        .get(stashId);
    return (m?.m ?? 0) + 1;
}

// COPY VERBATIM from unapply.ts — same shape, same parsing rules.
function collectRegionsFromPatch(patch: string): Array<{ filePath: string; hunkIndex: number; content: string }> {
    // ... (existing logic from unapply.ts, lines ~247-288)
    // The engineer should literally copy these ~40 lines, OR refactor them into lib/walk.ts as a
    // shared helper. Prefer the latter — extract `collectRegionsFromPatch` to walk.ts as a static
    // utility and have both unapply.ts and update.ts call it.
    return []; // placeholder — engineer replaces with the real impl from unapply.ts
}

async function walkInteractive(args: { walk: Walk }): Promise<void> {
    const { select, note } = await import("@clack/prompts");
    while (!args.walk.isComplete()) {
        const region = args.walk.currentRegion();
        if (!region) return;
        const total = args.walk.regions().length;
        const idx = args.walk.snapshot().currentIndex + 1;
        const diff = renderDiff({
            before: region.storedContent ?? "",
            after: region.currentContent ?? "",
            label: `${region.filePath} hunk ${region.hunkIndex}`,
        });
        note(diff, `Region ${idx}/${total} — class: ${region.klass}`);
        const sel = await select({
            message: "decision?",
            options: [
                { value: "capture", label: "capture — write current code as new v_next region" },
                { value: "restore", label: "restore — rewrite code to match stored region" },
                { value: "skip", label: "skip — leave both alone (accepts divergence)" },
            ],
        });
        if (typeof sel !== "string") {
            ui.warn("paused; resume with: tools stash update <name> --continue");
            await args.walk.persist();
            process.exit(0);
        }
        args.walk.decide(sel as "capture" | "restore" | "skip");
    }
}

async function emitNonTtyPrompt(args: { walk: Walk }): Promise<void> {
    const region = args.walk.currentRegion();
    if (!region) return;
    const total = args.walk.regions().length;
    const idx = args.walk.snapshot().currentIndex + 1;
    process.stderr.write(
        `\nRegion ${idx}/${total} — ${region.filePath} hunk ${region.hunkIndex} (class: ${region.klass})\n`
    );
    process.stderr.write(
        renderDiff({
            before: region.storedContent ?? "",
            after: region.currentContent ?? "",
            label: `${region.filePath} hunk ${region.hunkIndex}`,
        })
    );
    process.stderr.write("\nChoose a decision:\n");
    for (const dec of ["capture", "restore", "skip"]) {
        process.stderr.write(
            `  ${suggestCommand("tools stash update", { add: ["--continue", `--decision=${dec}`], subcommand: ["update"] })}\n`
        );
    }
    process.stderr.write(
        `Or abort:\n  ${suggestCommand("tools stash update", { add: ["--abort"], subcommand: ["update"] })}\n`
    );
}

async function executeDecisions(args: {
    walk: Walk;
    projectRoot: string;
    storage: StashStorage;
    db: Database;
    stash: StashRow;
}): Promise<void> {
    const ext = args.walk.snapshot().extension as { currentVersionId: string; targetVNext: number };
    const captureRegions = args.walk.regions().filter((r) => r.decision === "capture" || r.decision === "auto-capture");
    const restoreRegions = args.walk.regions().filter((r) => r.decision === "restore");
    const skipped = args.walk.regions().filter((r) => r.decision === "skip");

    // 1. Restore step: rewrite code for `restore` decisions.
    //    For each, locate marker pair in source, replace content between them with storedContent.
    for (const r of restoreRegions) {
        const abs = join(args.projectRoot, r.filePath);
        const content = await readFile(abs, "utf8");
        const markers = parseMarkers(content);
        const byName = markers.filter((m) => m.name === args.stash.name);
        const m = byName[r.hunkIndex - 1]; // D-22 PRESERVED: index by hunkIndex, not find()
        if (!m) {
            log.warn({ rel: r.filePath, hunkIndex: r.hunkIndex }, "restore: marker missing; skipping");
            continue;
        }
        const lines = content.split("\n");
        const before = lines.slice(0, m.contentStartLine - 1);
        const restored = (r.storedContent ?? "").split("\n");
        const after = lines.slice(m.contentEndLine);
        await writeFile(abs, [...before, ...restored, ...after].join("\n"));
    }

    // 2. Capture step: build v_next patch from capture regions' current content.
    if (captureRegions.length > 0) {
        const repo = new StoreRepo(args.storage.storeRepoDir());
        const newVRef = `refs/stashes/${args.stash.id}/v${ext.targetVNext}`;
        const newBaselineRef = `refs/baselines/${args.stash.id}/v${ext.targetVNext}`;
        const patch = buildUnifiedPatchFromRegions({ regions: captureRegions });
        // Reuse the v_prev baseline — 3-way merges against same pre-stash content.
        const baselineFiles: Record<string, string> = {};
        for (const r of captureRegions) {
            baselineFiles[r.filePath] = r.storedContent ?? "";
        }
        await repo.writePatchCommit({
            ref: newBaselineRef,
            files: baselineFiles,
            message: `stash:${args.stash.name} v${ext.targetVNext} baseline (update capture)`,
        });
        await repo.writePatchCommit({
            ref: newVRef,
            files: { "PATCH.diff": patch },
            message: `stash:${args.stash.name} v${ext.targetVNext} (captured from update)`,
        });
        const now = new Date().toISOString();
        const newVersionId = newStashId();
        args.db.run(
            `INSERT INTO versions (id, stash_id, version, patch_ref, region_count, file_count, metadata_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, '{"capturedFromUpdate":true}', ?)`,
            [
                newVersionId,
                args.stash.id,
                ext.targetVNext,
                newVRef,
                captureRegions.length,
                new Set(captureRegions.map((r) => r.filePath)).size,
                now,
            ]
        );
        // Insert per-region rows (closes D-31 for captured updates).
        for (const r of captureRegions) {
            args.db.run(
                `INSERT INTO regions (id, version_id, region_name, file_path, hunk_index, start_marker_present, line_count)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [newStashId(), newVersionId, args.stash.name, r.filePath, r.hunkIndex, 1, (r.currentContent ?? "").split("\n").length]
            );
        }
        // Advance the application's version_id.
        args.db.run("UPDATE applications SET version_id = ? WHERE stash_id = ? AND project_path = ? AND state = 'active'", [
            newVersionId,
            args.stash.id,
            args.walk.snapshot().projectPath,
        ]);
        args.db.run("UPDATE stashes SET updated_at = ? WHERE id = ?", [now, args.stash.id]);
        ui.ok(`captured ${captureRegions.length} region(s) to v${ext.targetVNext}; application now pinned to v${ext.targetVNext}`);
    } else {
        ui.info("no capture decisions; v_next not written");
    }
    if (restoreRegions.length > 0) {
        ui.info(`restored ${restoreRegions.length} region(s) in code`);
    }
    if (skipped.length > 0) {
        ui.warn(`${skipped.length} region(s) skipped (stash and code diverged)`);
    }
}

function buildUnifiedPatchFromRegions(args: {
    regions: WalkRegion[];
}): string {
    // Per-region unified diff: storedContent → currentContent for each region's filePath.
    // Combines into one PATCH.diff that git apply --3way can reconcile in any target.
    const parts: string[] = [];
    for (const r of args.regions) {
        const before = r.storedContent ?? "";
        const after = r.currentContent ?? "";
        const beforeLines = before.split("\n");
        const afterLines = after.split("\n");
        const header = [
            `--- a/${r.filePath}`,
            `+++ b/${r.filePath}`,
            `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
        ].join("\n");
        const body = [...beforeLines.map((l) => `-${l}`), ...afterLines.map((l) => `+${l}`)].join("\n");
        parts.push(`${header}\n${body}\n`);
    }
    return parts.join("");
}
```

**IMPORTANT — copy `collectRegionsFromPatch` from `unapply.ts`** (lines ~247-288 in the current file). Best move: extract that function to `lib/walk.ts` as a shared static helper and import it in both unapply.ts and update.ts. Don't duplicate.

- [ ] **Step 5: Update `src/stash/index.ts` to wire update with the same walk flags as unapply**

Find the `program.command("update <name>")` block. Replace with:

```typescript
program
    .command("update <name>")
    .description("Capture current code as a new version of an applied stash via per-region decision walk")
    .option("--continue", "resume from last checkpoint")
    .option("--skip", "decide current region as 'skip'")
    .option("--abort", "abandon in-progress session")
    .option("--status", "show progress")
    .option(
        "--decision <d>",
        "decide current region: capture | restore | skip | capture-all-dangerous | restore-all-dangerous"
    )
    .action(async (name: string, opts: { continue?: boolean; skip?: boolean; abort?: boolean; status?: boolean; decision?: string }) => {
        const action = opts.abort
            ? "abort"
            : opts.status
              ? "status"
              : opts.skip
                ? "skip"
                : opts.continue
                  ? "continue"
                  : "start";
        await updateCommand({ name, action, decision: opts.decision as never });
    });
```

The old `--mode` flag on `update` is dropped — `update` reads from the applied site, not the working tree by mode. If `--mode` was relied on elsewhere, surface that in the PR review.

- [ ] **Step 6: Run tests**

```bash
bun test src/stash/
```

Expected: all existing tests + new update tests PASS.

- [ ] **Step 7: Manual smoke**

```bash
cd /tmp && mkdir update-smoke && cd update-smoke && git init -q
git config user.email t@t && git config user.name t
echo "v=1" > f.ts && git add . && git commit -qm init
echo "v=1\nconst log = console.log;" > f.ts
tools stash save logger --mode all
git checkout f.ts
tools stash apply logger
# Edit the applied region:
sed -i.bak 's/console.log/console.warn/' f.ts
tools stash update logger --decision=capture-all-dangerous
tools stash versions logger   # should show v1 + v2
tools stash list --applied    # should show "logger@v2" pinned here
```

- [ ] **Step 8: Commit**

```bash
git add src/stash/commands/update.ts src/stash/commands/update.test.ts src/stash/index.ts src/stash/lib/walk.ts
git commit -m "feat(stash): walk-driven 'update' command (was Out of Plan Scope #1)

Per spec §5.2: tools stash update walks each applied region of <name>,
classifies divergence (unchanged/edited/missing/new-extra), and lets the
user decide per region (capture/restore/skip). Capture writes v_next +
advances applications.version_id. Restore rewrites code to stored. Skip
leaves both alone. Shares lib/walk.ts machinery with unapply.

Closes deferred backlog item 1 from v1's Out of Plan Scope."
```

---

> **Architectural reminder (Task 5 — and ALL later command-touching tasks):** the command file must end up under ~60 lines of non-comment code. The implementation shown in Task 5 has too much in `update.ts`. Before committing Task 5, **extract these helpers to `src/stash/lib/walk-execute.ts`**:
> - `bootstrapUpdateWalk(args)` (was `bootstrap` in update.ts)
> - `executeUpdateDecisions(args)` (was `executeDecisions`)
> - `walkInteractive(args)` and `emitNonTtyPrompt(args)` (lift to lib, parameterize verb)
> - `buildUnifiedPatchFromRegions(args)`
> - `collectRegionsFromPatch(patch)` ← also used by unapply.ts; extract here so both consume it
>
> After extraction, `update.ts` should be ~50 lines: parse args, load/start walk via lib, call lib's execute, render result via `ui.*`. Same architectural shape applies when Task 6+ refactors `unapply.ts` — that command file should also shrink to ~50 lines.

---

### Task 6: Refactor `src/stash/commands/unapply.ts` to consume the shared walk + lib helpers

**Why:** v1's unapply.ts is ~640 lines — fat command, smart code-and-logic-soup. Now that `lib/walk.ts` (Task 4) and `lib/walk-execute.ts` (Task 5's extraction) exist, unapply.ts becomes ~60 lines of orchestration. Crucially, preserve the v1 correctness fixes D-22 (byName[hunkIndex-1]), D-23 (descending hunkIndex order), D-25 (failedToFind tracking).

**Files:**
- Modify: `src/stash/commands/unapply.ts` — slim to <80 lines
- Extend: `src/stash/lib/walk-execute.ts` — add `bootstrapUnapplyWalk`, `executeUnapplyDecisions` (the latter contains the husk-fix `unlinkEmptyCreatedFiles` from session 2026-06-25)
- Modify: `src/stash/index.ts` — update the unapply wiring to call new entry point
- Tests: existing `src/stash/commands/apply.test.ts` (apply-driven) + `src/stash/e2e.test.ts` should pass unchanged

- [ ] **Step 1: Inventory v1 unapply.ts to identify what moves to lib**

```bash
grep -n '^[a-z]' src/stash/commands/unapply.ts | head -20
```

Expected functions to move:
- `bootstrapSession` → `bootstrapUnapplyWalk` in `lib/walk-execute.ts`
- `collectRegionsFromPatch` → already in `lib/walk-execute.ts` per Task 5
- `processAutoRemoves` → `lib/walk-execute.ts` (carries D-23 descending-order fix)
- `groupRegionsByFileDescending` → `lib/walk-execute.ts`
- `walkInteractive` + `emitNonTtyPrompt` → `lib/walk-execute.ts` (parameterized by verb)
- `executeAllDecisions` → `executeUnapplyDecisions` in `lib/walk-execute.ts`
- `deriveCreatedFilesFromBaseline`, `extractFilePathsFromPatch`, `unlinkEmptyCreatedFiles` → `lib/walk-execute.ts`
- `capturedUpdatesAsNewVersion`, `buildUnifiedDiff` → `lib/walk-execute.ts`
- `readCreatedFilesForActiveApp` — DELETE (replaced by `deriveCreatedFilesFromBaseline`)

- [ ] **Step 2: Snapshot existing test coverage**

```bash
bun test src/stash/ 2>&1 | tail -5
```

Record the current pass count (~80). The refactor must not change it. Add a new test before refactoring (Step 3) to lock in the D-22/D-23/D-25 fixes explicitly.

- [ ] **Step 3: Add lock-in tests for D-22, D-23, D-25**

Create `src/stash/lib/walk-execute.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Imports — these will exist after the refactor lands.
import {
    bootstrapUnapplyWalk,
    executeUnapplyDecisions,
} from "./walk-execute";

describe("walk-execute — preserves v1 correctness fixes", () => {
    // ... fixture setup omitted for brevity, mirror src/stash/commands/apply.test.ts setup

    test("D-22: applyDecisionToCode targets the Nth marker by hunkIndex, not the first", async () => {
        // Setup: a file with TWO @stash:test marker pairs.
        // Apply unapply with discard decision for hunk 2 only.
        // Assert hunk 2's markers + body are removed; hunk 1 untouched.
        // (If D-22 regresses, the test removes hunk 1 instead.)
    });

    test("D-23: multi-hunk file unapply iterates descending by hunkIndex", async () => {
        // Setup: 3 contiguous hunks in one file, each wrapped.
        // Apply unapply with discard for all 3.
        // Assert all 3 are removed correctly (forward iteration would shift line numbers and
        // leave the lower hunks misaligned).
    });

    test("D-25: failedToFind > 0 keeps application active and persists state", async () => {
        // Setup: apply stash, then DELETE a marker manually (out-of-band edit).
        // Run executeUnapplyDecisions with discard.
        // Assert: applications.state is still 'active', state file is on disk (not deleted).
        // Re-run after manually restoring the marker: should now clean up.
    });
});
```

Run: `bun test src/stash/lib/walk-execute.test.ts`
Expected: FAIL — `walk-execute.ts` doesn't have these exports yet.

- [ ] **Step 4: Extract helpers from unapply.ts to walk-execute.ts**

This is mechanical lift-and-shift. For each helper listed in Step 1:
1. Cut from `unapply.ts`.
2. Paste into `lib/walk-execute.ts` with `export` added.
3. Update unapply.ts to import from `../lib/walk-execute`.

**Preserve the comments** describing D-22/D-23/D-25 reasoning — they're load-bearing tribal knowledge.

- [ ] **Step 5: Slim unapply.ts to ~80 lines**

The final unapply.ts should look approximately like:

```typescript
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { logger } from "@app/logger";
import { isInteractive } from "@app/utils/cli";
import { detectProject } from "../lib/projects";
import { openStashDb } from "../lib/stash-db";
import { StashStorage } from "../lib/storage";
import { ui } from "../lib/ui";
import {
    bootstrapUnapplyWalk,
    executeUnapplyDecisions,
    walkInteractive,
    emitNonTtyPrompt,
    applyBlanketDecision,
} from "../lib/walk-execute";
import { type Decision, Walk } from "../lib/walk";
import type { StashRow } from "../types";

const { log } = logger.scoped("stash:unapply");

export interface UnapplyOptions {
    name: string;
    action: "start" | "continue" | "skip" | "abort" | "status";
    decision:
        | Exclude<Decision, null | "auto-capture">
        | "discard-all-dangerous"
        | "update-stash-all-dangerous"
        | undefined;
}

export async function unapplyCommand(opts: UnapplyOptions): Promise<void> {
    log.debug({ opts }, "unapplyCommand");
    const project = await detectProject(process.cwd());
    if (!project) {
        ui.err("not inside a git repository");
        process.exit(1);
    }
    const storage = new StashStorage();
    await storage.ensureDirs();
    const db = openStashDb(new Database(storage.dbPath()));
    const stash = db.query<StashRow, [string]>("SELECT * FROM stashes WHERE name = ?").get(opts.name);
    if (!stash) {
        ui.err(`stash "${opts.name}" not found`);
        db.close();
        process.exit(1);
    }
    const projectHash = createHash("sha256").update(project.rootPath).digest("hex").slice(0, 12);

    // -- abort / status fast paths --
    if (opts.action === "abort" || opts.action === "status") {
        const w = await Walk.load({ stashId: stash.id, projectHash, stateDir: storage.stateDir() });
        if (!w || w.snapshot().verb !== "unapply") {
            ui.info("no in-progress unapply session");
            db.close();
            return;
        }
        if (opts.action === "abort") {
            await w.abort();
            ui.ok("aborted");
        } else {
            const p = w.progress();
            ui.info(`${p.decided}/${p.total} decided`);
        }
        db.close();
        return;
    }

    // -- load or bootstrap --
    let walk = await Walk.load({ stashId: stash.id, projectHash, stateDir: storage.stateDir() });
    if (!walk) {
        walk = await bootstrapUnapplyWalk({ storage, db, stash, project, projectHash });
        if (!walk) {
            db.close();
            return;
        }
    }

    // -- decide + walk --
    applyBlanketDecision(walk, opts.decision);
    if (opts.decision && !opts.decision.endsWith("-all-dangerous")) {
        walk.decide(opts.decision as Exclude<Decision, null | "auto-capture">);
    } else if (opts.action === "skip" && walk.currentRegion()) {
        walk.decide("skip");
    }
    if (isInteractive() && !walk.isComplete()) {
        await walkInteractive({ walk, verb: "unapply" });
    }
    if (!walk.isComplete()) {
        await walk.persist();
        await emitNonTtyPrompt({ walk, verb: "unapply" });
        db.close();
        return;
    }
    await executeUnapplyDecisions({ walk, projectRoot: project.rootPath, storage, db, stash });
    db.close();
}
```

- [ ] **Step 6: Run all stash tests**

```bash
bun test src/stash/
```

Expected: same pass count as Step 2 + the new walk-execute tests pass. NO regressions.

If any test fails, the refactor lost a behavior. Trace it back via git diff and restore.

- [ ] **Step 7: Type-check**

```bash
tsgo --noEmit | rg 'src/stash' | head -20
```

Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add src/stash/commands/unapply.ts src/stash/lib/walk-execute.ts src/stash/lib/walk-execute.test.ts
git commit -m "refactor(stash): slim unapply command to ~80 lines; logic in lib/walk-execute

Lift bootstrapSession / processAutoRemoves / executeAllDecisions / etc. from
the command file into lib/walk-execute.ts. Preserves v1 correctness fixes:
D-22 (byName[hunkIndex-1]), D-23 (descending hunkIndex order), D-25
(failedToFind gating). New lock-in tests cover each. Per v1.1 spec §3a
(dumb commands, smart lib)."
```

---

### Task 7: Close audit D-31 — populate `regions` table on save + backfill migration

**Why:** The audit found that v1 NEVER inserts into the `regions` table even though the schema defines it. `tools stash show <name>` defaults to the regions inventory mode which always shows 0 rows. v1.1 fixes this prospectively (every new save populates regions) AND retroactively (a migration backfills from existing stored patches).

**Files:**
- Modify: `src/stash/lib/stash-migrations.ts` — add `002-populate-regions-table` migration
- Modify: `src/stash/commands/save.ts` (or `src/stash/lib/save-execute.ts` if Task 5's extraction landed) — insert per-region rows after the version row
- Modify: `src/stash/commands/update.ts` / `lib/walk-execute.ts` — also insert region rows on captured updates (Task 5 already does this; verify)
- Test: `src/stash/lib/stash-migrations.test.ts` — add a test for the 002 migration; modify save tests to assert regions table is populated

- [ ] **Step 1: Read current `stash-migrations.ts`**

```bash
cat src/stash/lib/stash-migrations.ts
```

Identify the Migration interface format. v1 uses `{ id, description, apply(db) }`.

- [ ] **Step 2: Write failing test for migration 002**

Extend `src/stash/lib/stash-migrations.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "@app/utils/database/migrations";
import { STASH_MIGRATIONS } from "./stash-migrations";

describe("002-populate-regions-table", () => {
    test("backfills regions from stored PATCH.diff in versions", () => {
        const db = new Database(":memory:");
        runMigrations(db, STASH_MIGRATIONS.filter((m) => m.id !== "002-populate-regions-table"), { tableName: "stash" });
        // Insert a fake stash + version with a patch that has 3 hunks
        const fakePatch = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,1 +1,3 @@
 base
+added1
+added2
@@ -10,1 +12,2 @@
 ctx
+added3
@@ -20,1 +23,2 @@
 ctx2
+added4
`;
        db.run("INSERT INTO stashes (id, name, created_at, updated_at) VALUES ('s1', 'test', '2026-06-25', '2026-06-25')");
        db.run(
            "INSERT INTO versions (id, stash_id, version, patch_ref, region_count, file_count, metadata_json, created_at) VALUES ('v1', 's1', 1, 'refs/x', 3, 1, '{}', '2026-06-25')"
        );
        // Also insert the patch as if the store-repo has it. The migration needs to read from store-repo.
        // For the test, the migration code accepts an optional `readPatch(ref)` callback that defaults to
        // the real store; tests inject a mock.
        // [Implementation may differ — adapt to whatever shape lands.]

        // Apply migration 002 only.
        runMigrations(db, STASH_MIGRATIONS.filter((m) => m.id === "002-populate-regions-table"), { tableName: "stash" });

        const count = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM regions WHERE version_id = 'v1'").get();
        expect(count?.c).toBe(3);
    });

    test("idempotent — running twice does not double-insert", () => {
        // ... same as above but apply 002 twice; assert COUNT stays at 3
    });
});
```

- [ ] **Step 3: Run to verify fail**

Run: `bun test src/stash/lib/stash-migrations.test.ts`
Expected: FAIL — migration doesn't exist.

- [ ] **Step 4: Implement migration 002**

Append to `STASH_MIGRATIONS` in `src/stash/lib/stash-migrations.ts`:

```typescript
{
    id: "002-populate-regions-table",
    description: "Backfill `regions` table from existing versions' stored PATCH.diff (closes audit D-31)",
    async apply(db) {
        // Idempotency: skip if any region rows exist (we either already ran, or post-002 code is
        // inserting on save). Re-running on populated rows would duplicate.
        const existing = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM regions").get();
        if ((existing?.c ?? 0) > 0) {
            return;
        }
        // We need to read patches from the store. The migration runs at DB open time, so the
        // store-repo may not be wired up. Strategy: read patches lazily via dynamic import + the
        // same StashStorage / StoreRepo that the rest of the tool uses. Migration is async-capable.
        const { StashStorage } = await import("./storage");
        const { StoreRepo } = await import("./store-repo");
        const { newStashId } = await import("./ids");
        const storage = new StashStorage();
        const repo = new StoreRepo(storage.storeRepoDir());
        const versions = db.query<{ id: string; patch_ref: string }, []>("SELECT id, patch_ref FROM versions").all();
        for (const v of versions) {
            const patch = (await repo.readFileAt(v.patch_ref, "PATCH.diff")) ?? "";
            const regions = parseRegionsFromPatch(patch);
            for (const r of regions) {
                db.run(
                    `INSERT INTO regions (id, version_id, region_name, file_path, hunk_index, start_marker_present, line_count)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [newStashId(), v.id, r.regionName, r.filePath, r.hunkIndex, r.startMarkerPresent ? 1 : 0, r.lineCount]
                );
            }
        }
    },
},
```

And add the helper:

```typescript
interface ParsedRegion {
    regionName: string | null;
    filePath: string;
    hunkIndex: number;
    startMarkerPresent: boolean;
    lineCount: number;
}

function parseRegionsFromPatch(patch: string): ParsedRegion[] {
    const out: ParsedRegion[] = [];
    const lines = patch.split("\n");
    let currentFile: string | null = null;
    let hunkIndex = 0;
    let addedCount = 0;
    let regionName: string | null = null;
    let startMarkerPresent = false;
    const flush = () => {
        if (currentFile && (addedCount > 0 || regionName)) {
            out.push({
                regionName,
                filePath: currentFile,
                hunkIndex,
                startMarkerPresent,
                lineCount: addedCount,
            });
        }
        addedCount = 0;
        regionName = null;
        startMarkerPresent = false;
    };
    for (const line of lines) {
        const fm = /^\+\+\+ b\/(.+)$/.exec(line);
        if (fm) {
            flush();
            currentFile = fm[1] ?? null;
            hunkIndex = 0;
            continue;
        }
        if (line.startsWith("@@")) {
            flush();
            hunkIndex++;
            continue;
        }
        if (line.startsWith("+")) {
            addedCount++;
            const m = /#region\s+@stash:([\w.-]+)/.exec(line);
            if (m?.[1]) {
                regionName = m[1];
                startMarkerPresent = true;
            }
        }
    }
    flush();
    return out;
}
```

- [ ] **Step 5: Add per-region INSERT to save's execute step**

In whichever module owns the save execution (`save.ts` or after Task 5's extraction `lib/save-execute.ts`), after the `INSERT INTO versions ...` call:

```typescript
// Closes D-31 prospectively: every save populates the regions table.
const parsedRegions = parseRegionsFromPatch(patch); // import from stash-migrations.ts OR move parseRegionsFromPatch to lib/patch.ts (better — shared helper).
for (const r of parsedRegions) {
    db.run(
        `INSERT INTO regions (id, version_id, region_name, file_path, hunk_index, start_marker_present, line_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [newStashId(), versionId, r.regionName, r.filePath, r.hunkIndex, r.startMarkerPresent ? 1 : 0, r.lineCount]
    );
}
```

Move `parseRegionsFromPatch` to a new shared utility `src/stash/lib/parse-regions.ts` so the migration and save both consume it. Add unit tests for the parser (single-hunk, multi-hunk, mixed-files, with-marker, without-marker).

- [ ] **Step 6: Update existing save tests + add regression test**

In `src/stash/e2e.test.ts`, add to an existing roundtrip test:

```typescript
// After saveCommand call, assert regions table was populated.
const { Database } = await import("bun:sqlite");
const { openStashDb } = await import("./lib/stash-db");
const { StashStorage } = await import("./lib/storage");
const db = openStashDb(new Database(new StashStorage().dbPath()));
const rc = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM regions").get();
expect(rc?.c).toBeGreaterThan(0);
db.close();
```

- [ ] **Step 7: Run tests**

```bash
bun test src/stash/
```

Expected: existing tests pass; new D-31 tests pass.

- [ ] **Step 8: Manual smoke against existing user's stash**

```bash
# Backfill runs automatically on next DB open. Verify on an existing stash.
tools stash show burn-auth-callback-record --regions
# Expected: lists hunks with file_path / hunk_index / line_count / name (or "(anon)" for unnamed)
```

- [ ] **Step 9: Commit**

```bash
git add src/stash/lib/stash-migrations.ts src/stash/lib/parse-regions.ts src/stash/lib/parse-regions.test.ts src/stash/commands/save.ts src/stash/e2e.test.ts
git commit -m "fix(stash): populate regions table on save + backfill migration (closes audit D-31)

v1 defined the regions table in schema but never inserted into it. tools stash
show <name> --regions always showed 0 rows. v1.1 fixes prospectively (every
save populates) and retroactively (002-populate-regions-table backfills from
stored PATCH.diff). Idempotent migration."
```

---

### Task 8: save same-name — aggregate diff + single confirm

**Why:** Per spec §6.2 + §15.1, save over an existing name shows the v_prev→working aggregate diff and prompts yes/no. NOT a per-region walk. Scripts opt out via `--force-bump`.

**Files:**
- Modify: `src/stash/commands/save.ts` (or `src/stash/lib/save-execute.ts`)
- Modify: `src/stash/index.ts` — add `--force-bump` flag
- Test: extend `src/stash/e2e.test.ts`

- [ ] **Step 1: Add failing test**

```typescript
test("save same-name prints aggregate diff and requires confirmation in TTY", async () => {
    // Setup: save v1, then change working tree, then save same name.
    // Mock isInteractive() to true, mock the clack confirm prompt to return true.
    // Assert: stderr contains "--- " / "+++ " diff markers; v2 row exists in DB.
});

test("save same-name --force-bump skips prompt and writes v2 silently", async () => {
    // Setup: save v1, modify, save with { name, mode, forceBump: true }.
    // Assert: v2 written, no prompt invoked (count clack.confirm calls = 0).
});

test("save same-name in non-TTY without --force-bump errors with suggestion", async () => {
    // Setup: save v1, modify, save in non-TTY mode without force.
    // Assert: process.exitCode is non-zero AND stderr contains "--force-bump".
});
```

- [ ] **Step 2: Implement in `lib/save-execute.ts`**

```typescript
import { renderUnifiedDiff } from "@app/utils/diff";

export async function maybePromptSameName(args: {
    existingName: string;
    prevPatch: string;
    nextPatch: string;
    forceBump: boolean;
}): Promise<"proceed" | "abort"> {
    const diff = renderUnifiedDiff({ before: args.prevPatch, after: args.nextPatch, label: "PATCH.diff" });
    if (diff === "") {
        // No change → no need to bump.
        return "abort";
    }
    if (args.forceBump) {
        return "proceed";
    }
    if (!isInteractive()) {
        ui.err(`stash "${args.existingName}" already exists; in non-TTY mode use --force-bump to write v_next silently`);
        ui.info(`  saw working-tree diff vs v_prev:\n`);
        process.stderr.write(diff);
        return "abort";
    }
    const { confirm, note } = await import("@clack/prompts");
    note(diff, `Aggregate diff: v_prev → v_next for "${args.existingName}"`);
    const answer = await confirm({
        message: `Bump "${args.existingName}" to a new version with these changes?`,
        active: "yes (write v_next)",
        inactive: "no (abort)",
    });
    return answer === true ? "proceed" : "abort";
}
```

Wire it in save-execute.ts BEFORE the `INSERT INTO versions ...` call:

```typescript
if (existing) {
    const prevVersion = db.query<VersionRow, [string]>(
        "SELECT * FROM versions WHERE stash_id = ? ORDER BY version DESC LIMIT 1"
    ).get(existing.id);
    const prevPatch = prevVersion ? (await repo.readFileAt(prevVersion.patch_ref, "PATCH.diff")) ?? "" : "";
    const decision = await maybePromptSameName({
        existingName: opts.name,
        prevPatch,
        nextPatch: patch,
        forceBump: opts.forceBump ?? false,
    });
    if (decision === "abort") {
        ui.info(`save aborted; "${opts.name}" stays at v${prevVersion?.version ?? "?"}`);
        return;
    }
    // proceed with v_next bump as before
}
```

- [ ] **Step 3: Add `--force-bump` to commander**

In `src/stash/index.ts` save block:

```typescript
.option("--force-bump", "when --name already exists, write v_next without prompting")
```

Pipe through to `saveCommand({ ..., forceBump: opts.forceBump })`.

- [ ] **Step 4: Run tests**

```bash
bun test src/stash/
```

Expected: new tests pass, existing pass.

- [ ] **Step 5: Manual smoke**

```bash
tools stash save burn-auth-callback-record --mode staged
# (modify working tree)
tools stash save burn-auth-callback-record --mode staged
# TTY: prompt with diff + y/n
# Non-TTY: error with --force-bump suggestion
tools stash save burn-auth-callback-record --mode staged --force-bump
# Silent v_next bump
```

- [ ] **Step 6: Commit**

```bash
git add src/stash/commands/save.ts src/stash/lib/save-execute.ts src/stash/index.ts src/stash/e2e.test.ts
git commit -m "feat(stash): aggregate diff confirm on save same-name (--force-bump escape)

When <name> already exists, save now renders the v_prev → v_working aggregate
diff and prompts yes/no. Non-TTY without --force-bump errors with a suggestion.
NOT a per-region walk (spec §15.1 explicitly rejected). Preserves the 'save
= faithful snapshot' invariant."
```

---

### Task 9: `--mode regions` requires `--regions <names>` (validation)

**Why:** Per session 2026-06-25 user feedback, `--regions` should not be silently combined with other modes. Make `--mode regions` a discrete enum value; require `--regions <names>` when set; reject `--regions` without `--mode regions`.

**Files:**
- Modify: `src/stash/index.ts` — extend `parseSaveMode` to accept `"regions"`; add validation in the save action.
- Modify: `src/stash/commands/save.ts` (or save-execute.ts) — drop the auto-default-to-"all" fallback when regions is set
- Test: `src/stash/index.test.ts` (new) — CLI argument validation tests

- [ ] **Step 1: Add failing test**

Create `src/stash/index.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";

// Use Bun.spawn to invoke `bun src/stash/index.ts <args>` and capture exit code + stderr.
async function runStash(args: string[]): Promise<{ code: number; stderr: string }> {
    const proc = Bun.spawn(["bun", "src/stash/index.ts", ...args], { stdout: "pipe", stderr: "pipe" });
    const [stderr, exit] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { code: exit, stderr };
}

describe("save CLI validation", () => {
    test("--mode regions without --regions errors", async () => {
        const { code, stderr } = await runStash(["save", "x", "--mode", "regions"]);
        expect(code).toBeGreaterThan(0);
        expect(stderr).toMatch(/--regions <names>.*required/i);
    });

    test("--regions without --mode regions errors", async () => {
        const { code, stderr } = await runStash(["save", "x", "--regions", "foo"]);
        expect(code).toBeGreaterThan(0);
        expect(stderr).toMatch(/--mode regions/i);
    });

    test("--mode all --regions foo errors (mutual exclusion)", async () => {
        const { code, stderr } = await runStash(["save", "x", "--mode", "all", "--regions", "foo"]);
        expect(code).toBeGreaterThan(0);
        expect(stderr).toMatch(/--mode all.*--regions/i);
    });

    test("--mode regions --regions foo bar parses", async () => {
        // Won't fully succeed (no git repo in test cwd) but should not error on flag parsing.
        const { stderr } = await runStash(["save", "x", "--mode", "regions", "--regions", "foo", "bar"]);
        // Should error AFTER flag parse — on detectProject failing.
        expect(stderr).not.toMatch(/required|mutual/i);
    });
});
```

- [ ] **Step 2: Verify it fails**

Run: `bun test src/stash/index.test.ts`
Expected: FAIL — validation not in place.

- [ ] **Step 3: Update `parseSaveMode` + add validation**

In `src/stash/index.ts`:

```typescript
const SAVE_MODES: SaveMode[] = ["staged", "unstaged", "all", "regions"];

function parseSaveMode(value: string): SaveMode {
    if ((SAVE_MODES as string[]).includes(value)) {
        return value as SaveMode;
    }
    throw new Error(`--mode must be one of: ${SAVE_MODES.join(" | ")} (got "${value}")`);
}

// In the save action:
if (opts.mode === "regions" && (!opts.regions || opts.regions.length === 0)) {
    ui.err("--mode regions requires --regions <names> (one or more author marker names)");
    process.exit(2);
}
if (opts.regions && opts.mode !== "regions") {
    ui.err(`--regions only valid with --mode regions (got --mode ${opts.mode ?? "(none)"})`);
    process.exit(2);
}
```

Update `SaveMode` type in `lib/patch.ts`:

```typescript
export type SaveMode = "staged" | "unstaged" | "all" | "regions";
```

- [ ] **Step 4: Update `diffWorkingTree` to handle mode="regions"**

When `mode === "regions"`, do the full --all diff first, then filter by regions via `filterPatchToAuthorRegions` (existing function from session fixup). Move the filter to `lib/patch-filter.ts` so it's testable in isolation.

- [ ] **Step 5: Run tests + smoke**

```bash
bun test src/stash/
tools stash save test --mode regions   # should error: requires --regions <names>
tools stash save test --regions foo    # should error: --regions needs --mode regions
tools stash save test --mode regions --regions foo bar   # parses OK; runs save (or errors on "no markers found")
```

- [ ] **Step 6: Commit**

```bash
git add src/stash/index.ts src/stash/commands/save.ts src/stash/lib/patch.ts src/stash/index.test.ts
git commit -m "feat(stash): make --mode regions a discrete mode requiring --regions <names>

Per v1.1 spec §6.3, --regions and the other modes are now mutually exclusive.
--mode regions without --regions errors. --regions without --mode regions
errors. Mixing --mode all/staged/unstaged with --regions errors. Cleaner CLI
surface, unambiguous user intent."
```

---

### Task 10: `tools stash diff <name>` — compare applied region vs stored

**Why:** Per spec §8.2, a fast inspection command that shows per-region drift between what was stored at apply time and what's in the editor now. No state machine; pure read-only.

**Files:**
- Create: `src/stash/commands/diff.ts` (thin command)
- Create: `src/stash/lib/diff-applied.ts` (the logic)
- Create: `src/stash/lib/diff-applied.test.ts`
- Modify: `src/stash/index.ts` — wire `diff` subcommand

- [ ] **Step 1: Write failing test**

```typescript
import { describe, expect, test } from "bun:test";
// ... fixture setup (apply a stash, edit a region) ...

describe("diff command", () => {
    test("prints unified diff per applied region; clean exit when no drift", async () => {
        // After apply (no edits), diffApplied returns empty string + exit 0.
        const out = await diffApplied({ name: "x", projectRoot: repo, db, storage });
        expect(out.regions).toEqual([]);
        expect(out.exitCode).toBe(0);
    });

    test("edited region appears as a diff block with file:hunk label", async () => {
        // After editing the applied region.
        const out = await diffApplied({ name: "x", projectRoot: repo, db, storage });
        expect(out.regions).toHaveLength(1);
        expect(out.regions[0].diff).toContain("--- stored:");
        expect(out.regions[0].diff).toContain("+++ current:");
    });

    test("errors when stash not applied in cwd", async () => {
        await expect(diffApplied({ name: "never-applied", projectRoot: repo, db, storage })).rejects.toThrow(/not applied/);
    });
});
```

- [ ] **Step 2: Implement `lib/diff-applied.ts`**

```typescript
import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderUnifiedDiff } from "@app/utils/diff";
import { extractRegionContent } from "./regions";
import { collectRegionsFromPatch } from "./walk-execute";
import { StoreRepo } from "./store-repo";
import { StashStorage } from "./storage";
import type { ApplicationRow, StashRow, VersionRow } from "../types";

export interface DiffAppliedResult {
    regions: Array<{ filePath: string; hunkIndex: number; diff: string }>;
    exitCode: 0 | 1;
}

export async function diffApplied(args: {
    name: string;
    projectRoot: string;
    db: Database;
    storage: StashStorage;
    pinnedVersion?: number;
}): Promise<DiffAppliedResult> {
    const stash = args.db.query<StashRow, [string]>("SELECT * FROM stashes WHERE name = ?").get(args.name);
    if (!stash) {
        throw new Error(`stash "${args.name}" not found`);
    }
    const app = args.db
        .query<ApplicationRow, [string, string]>(
            "SELECT * FROM applications WHERE stash_id = ? AND project_path = ? AND state = 'active'"
        )
        .get(stash.id, args.projectRoot);
    if (!app?.version_id) {
        throw new Error(`stash "${args.name}" is not applied in ${args.projectRoot}`);
    }
    const version = args.pinnedVersion
        ? args.db.query<VersionRow, [string, number]>(
              "SELECT * FROM versions WHERE stash_id = ? AND version = ?"
          ).get(stash.id, args.pinnedVersion)
        : args.db.query<VersionRow, [string]>("SELECT * FROM versions WHERE id = ?").get(app.version_id);
    if (!version) {
        throw new Error(`version not found`);
    }
    const repo = new StoreRepo(args.storage.storeRepoDir());
    const storedPatch = (await repo.readFileAt(version.patch_ref, "PATCH.diff")) ?? "";
    const regions = collectRegionsFromPatch(storedPatch);
    const out: DiffAppliedResult["regions"] = [];
    for (const r of regions) {
        const abs = join(args.projectRoot, r.filePath);
        let current: string | null;
        try {
            current = await extractRegionContent(abs, args.name);
        } catch {
            current = null;
        }
        const diff = renderUnifiedDiff({
            before: r.content,
            after: current ?? "",
            label: `${r.filePath}:hunk-${r.hunkIndex}`,
        });
        if (diff) {
            out.push({ filePath: r.filePath, hunkIndex: r.hunkIndex, diff });
        }
    }
    return { regions: out, exitCode: out.length > 0 ? 1 : 0 };
}
```

- [ ] **Step 3: Implement `commands/diff.ts` (thin)**

```typescript
import { Database } from "bun:sqlite";
import { logger, out } from "@app/logger";
import { detectProject } from "../lib/projects";
import { diffApplied } from "../lib/diff-applied";
import { openStashDb } from "../lib/stash-db";
import { StashStorage } from "../lib/storage";
import { ui } from "../lib/ui";

const { log } = logger.scoped("stash:diff");

export interface DiffOptions {
    name: string;
    at?: number;
}

export async function diffCommand(opts: DiffOptions): Promise<void> {
    log.debug({ opts }, "diffCommand");
    const project = await detectProject(process.cwd());
    if (!project) {
        ui.err("not inside a git repository");
        process.exit(1);
    }
    const storage = new StashStorage();
    await storage.ensureDirs();
    const db = openStashDb(new Database(storage.dbPath()));
    try {
        const result = await diffApplied({
            name: opts.name,
            projectRoot: project.rootPath,
            db,
            storage,
            pinnedVersion: opts.at,
        });
        if (result.regions.length === 0) {
            ui.ok(`"${opts.name}" applied region matches stored content; no drift`);
            return;
        }
        ui.header(`${opts.name} — ${result.regions.length} drifted region(s)`);
        for (const r of result.regions) {
            ui.section(`${r.filePath}:hunk-${r.hunkIndex}`);
            out.print(r.diff);
        }
        process.exit(result.exitCode);
    } catch (err) {
        ui.err(err instanceof Error ? err.message : String(err));
        process.exit(1);
    } finally {
        db.close();
    }
}
```

- [ ] **Step 4: Wire in `src/stash/index.ts`**

```typescript
import { diffCommand } from "./commands/diff";

program
    .command("diff <name>")
    .description("Show per-region diff between stored stash content and current applied code")
    .option("--at <version>", "pin to specific version (default: applied version)", parsePositiveInt)
    .action(async (name: string, opts: { at?: number }) => {
        await diffCommand({ name, at: opts.at });
    });
```

- [ ] **Step 5: Run + smoke**

```bash
bun test src/stash/
tools stash diff burn-auth-callback-record    # should print drift or "no drift"
```

- [ ] **Step 6: Commit**

```bash
git add src/stash/commands/diff.ts src/stash/lib/diff-applied.ts src/stash/lib/diff-applied.test.ts src/stash/index.ts
git commit -m "feat(stash): add 'tools stash diff <name>' (closes deferred backlog #2)

Per-region diff of stored stash content vs current applied code. Read-only,
no state machine. Errors when stash not applied in cwd. Exit code 1 when
drift detected, 0 when clean. Per v1.1 spec §8.2."
```

---

### Task 11: `--patch` interactive hunk picker

**Why:** Per spec §8.4, replaces v1's "no hunk picker exists" gap. Three-phase clack flow: discover → prompt-per-hunk → assemble.

**Files:**
- Create: `src/stash/lib/patch-picker.ts`
- Create: `src/stash/lib/patch-picker.test.ts`
- Modify: `src/stash/lib/patch.ts` — add `discoverHunks(patch): Hunk[]` helper
- Modify: `src/stash/commands/save.ts` (or save-execute.ts) — invoke picker when `mode === "patch"`
- Modify: `src/stash/index.ts` — add `"patch"` to `SAVE_MODES` enum

- [ ] **Step 1:** Write test using a synthetic 3-hunk diff and a stubbed clack `select` that accepts hunk-0, rejects hunk-1, accepts hunk-2. Assert result patch contains exactly hunks 0 and 2 (with renumbered `@@` headers).
- [ ] **Step 2:** Run → FAIL (picker missing).
- [ ] **Step 3:** Implement `lib/patch-picker.ts`:

```typescript
import { renderUnifiedDiff } from "@app/utils/diff";
import { ui } from "./ui";

export interface PickedHunk { fileHeader: string; hunkHeader: string; body: string; }
export interface PatchPickerArgs { patch: string; }
export interface PatchPickerResult { kept: string; droppedCount: number; }

export async function pickPatchInteractively(args: PatchPickerArgs): Promise<PatchPickerResult> {
    const blocks = parsePatchBlocks(args.patch); // file headers + array of hunks per file
    const { select, note } = await import("@clack/prompts");
    const keptBlocks: string[] = [];
    let dropped = 0;
    for (const block of blocks) {
        const survivingHunks: string[] = [];
        for (const hunk of block.hunks) {
            note(hunk.body, `${block.filePath}: ${hunk.headerLine}`);
            const sel = await select({
                message: "Include this hunk?",
                options: [
                    { value: "y", label: "yes — include" },
                    { value: "n", label: "no — skip" },
                    { value: "q", label: "quit picker (keep nothing remaining)" },
                ],
            });
            if (sel === "q") {
                return { kept: keptBlocks.join("\n") + "\n", droppedCount: dropped };
            }
            if (sel === "y") {
                survivingHunks.push(hunk.headerLine + "\n" + hunk.body);
            } else {
                dropped++;
            }
        }
        if (survivingHunks.length > 0) {
            keptBlocks.push(block.headerLines.join("\n") + "\n" + survivingHunks.join("\n"));
        }
    }
    return { kept: keptBlocks.join("\n") + "\n", droppedCount: dropped };
}

// parsePatchBlocks: reuse the same logic in lib/save-execute.ts's filterHunksByFileSpans.
```

- [ ] **Step 4:** Wire in save-execute.ts: when `opts.mode === "patch"`, after `diffWorkingTree({ mode: "all" })`, call `pickPatchInteractively({ patch })` and use the result as the captured patch.
- [ ] **Step 5:** Add `"patch"` to `SAVE_MODES`. Non-TTY mode errors with "--mode patch requires a TTY".
- [ ] **Step 6:** Tests + smoke.
- [ ] **Step 7:** Commit: `feat(stash): --mode patch interactive hunk picker (closes deferred backlog #4)`

---

### Task 12: Wave 1 testing pass — parametric tests + e2e roundtrips

**Why:** Wave 1 introduced large refactors (walk extraction, command slimming) and new commands (update, diff). A focused testing pass shores up: (a) parametric tests over `{update, unapply}` so both verbs are equally trusted, (b) end-to-end happy-path coverage of the curate-after-apply workflow.

**Files:**
- Modify: `src/stash/e2e.test.ts` — add curate-after-apply roundtrip + merge-via-curate test
- Add: `src/stash/lib/walk-execute.test.ts` parametric over verb
- Run: full `bun test src/stash/` — assert pass count ≥ 90 (was 80 in v1)

- [ ] **Step 1:** Write the curate-after-apply e2e test:

```typescript
test("curate-after-apply: save → apply → delete marker pair → update yields v_next with kept regions only", async () => {
    // 1. Save v1 with two regions wrapped by author markers @stash:logger.
    // 2. Apply v1 in projectB.
    // 3. Delete the marker pair (and body) for one of the two regions.
    // 4. Run updateCommand with `capture-all-dangerous`.
    // 5. Assert v2 exists with ONE region (the kept one); applications.version_id advanced.
    // 6. Apply v2 in a third (fresh) project; assert only the kept region is present.
});
```

- [ ] **Step 2:** Write the merge-via-curate test:

```typescript
test("merge via curate: apply A → apply B → delete unwanted → save C → apply C in fresh project", async () => {
    // 1. Save stash A and stash B in projectA.
    // 2. Apply both in projectB.
    // 3. Delete one of A's regions (simulating user curation).
    // 4. Save in projectB as stash C with --mode all.
    // 5. Apply C in projectC (fresh).
    // 6. Assert: A's surviving regions + B's regions are present in projectC; deleted region absent.
});
```

- [ ] **Step 3:** Parametric walk-execute test:

```typescript
test.each(["update", "unapply"] as const)("walk-execute %s preserves D-22 (Nth marker selection)", async (verb) => {
    // ... same setup, parameterize the verb. Assert byName[hunkIndex - 1] semantics for both.
});
```

- [ ] **Step 4:** Run + assert pass count.

```bash
bun test src/stash/ 2>&1 | tail -3
```

Expected: `≥ 90 pass, 0 fail`.

- [ ] **Step 5:** Commit: `test(stash): wave 1 coverage — curate roundtrip + merge + parametric walk`

---

## Wave 2 — Apply-Conflict State Machine + Author-Marker-Aware Unapply

Two tasks. Wave 2 ships after Wave 1 lands and the unified walk has soaked.

---

### Task 13: Apply-conflict state machine

**Why:** Per spec §8.5, when `git apply --3way` returns conflicts (`<<<<<<<` markers in source), v1 just exits with "resolve manually." v1.1 captures the conflict state, lets the user resolve, then `--resume` to finish decoration.

**Files:**
- Create: `src/stash/lib/apply-session.ts` (mirrors `lib/walk.ts` shape — state file at `state/<hash>--apply--<id>.json`)
- Create: `src/stash/lib/apply-session.test.ts`
- Modify: `src/stash/commands/apply.ts` — on conflict, persist session and emit non-TTY-friendly prompts
- Modify: `src/stash/index.ts` — add `--resume` and `--abort` flags to apply

- [ ] **Step 1:** Write failing test: apply a patch that conflicts, assert state file exists + `<<<<<<<` markers in source files.
- [ ] **Step 2:** Implement `ApplySession`:
  - Tracks `{ filesWithConflicts: string[], stashId, version, projectPath, projectHash, startedAt }`.
  - `load()` reads the state file; `start()` writes it; `complete()` deletes; `abort()` runs `git apply -R` then deletes.
  - `isClean(projectRoot)` checks every file for remaining `<<<<<<<` markers.
- [ ] **Step 3:** In apply.ts catch block: on conflict, write session, list conflicted files via parsing git's stderr, exit 1 with `tools stash apply <name> --resume` suggestion.
- [ ] **Step 4:** Add `--resume` handler: load session, call `isClean()`, if clean → run `decorateAppliedRegions`, insert application row, complete session. If not clean → list remaining conflicted files.
- [ ] **Step 5:** Add `--abort` handler: load session, reverse-apply, delete state.
- [ ] **Step 6:** Tests + smoke.
- [ ] **Step 7:** Commit: `feat(stash): apply-conflict state machine (closes deferred backlog #5)`

---

### Task 14: Author-marker-aware unapply

**Why:** Per spec §8.6, v1 derives "regions" from patch hunks (1 region per hunk). v1.1 splits hunks at author-marker boundaries so one stash can have N named regions per file. Makes the editor-curation workflow more granular.

**Files:**
- Create: `src/stash/lib/region-split.ts`
- Create: `src/stash/lib/region-split.test.ts`
- Modify: `src/stash/lib/walk-execute.ts` — `collectRegionsFromPatch` calls into `region-split.ts`

- [ ] **Step 1:** Write failing test: patch with 1 hunk containing 2 marker pairs → expect 2 regions back, each named after its marker.
- [ ] **Step 2:** Implement `splitHunkAtMarkers(hunk, content) → SplitRegion[]`. Each region carries `(name | null, contentStartLine, contentEndLine, body)`.
- [ ] **Step 3:** Wire in `collectRegionsFromPatch`. Backward-compat: anonymous hunks (no markers) still produce one `name: null` region.
- [ ] **Step 4:** Run unapply tests; assert per-marker-named regions in WalkRegion.name.
- [ ] **Step 5:** Commit: `feat(stash): author-marker-aware region splitting (closes deferred backlog #9)`

---

## Wave 3 — Doctor + rebase-project + Tree-Hash Sibling Detection

Three focused tasks. Shippable independently.

---

### Task 15: `tools stash doctor`

**Why:** Per spec §8.7. Consistency check; `--rebuild` regenerates regions table.

**Files:**
- Create: `src/stash/commands/doctor.ts` (thin)
- Create: `src/stash/lib/doctor.ts`
- Create: `src/stash/lib/doctor.test.ts`
- Modify: `src/stash/index.ts`

- [ ] **Step 1:** Write failing test using a fixture DB with a deliberately broken state (orphan version row, missing store ref). Assert doctor reports both.
- [ ] **Step 2:** Implement `lib/doctor.ts` checks:
  - (a) `git fsck --strict` in store-repo dir; report broken objects.
  - (b) For each `versions` row, `repo.resolveRef(patch_ref)` — report rows whose ref is missing.
  - (c) For each active `applications` row, verify `version_id` resolves and the recorded `project_path` has matching `@stash:<name>` markers.
  - (d) `--rebuild` flag: re-run migration 002's parser on every version, replacing the regions table contents.
- [ ] **Step 3:** Thin command wrapper.
- [ ] **Step 4:** Tests + smoke.
- [ ] **Step 5:** Commit: `feat(stash): tools stash doctor + --rebuild (closes deferred backlog #7)`

---

### Task 16: `tools stash rebase-project <old> <new>`

**Why:** Per spec §8.8. Re-point active applications when a project moves on disk.

**Files:**
- Create: `src/stash/commands/rebase-project.ts` (thin)
- Create: `src/stash/lib/rebase-project.ts`
- Create: `src/stash/lib/rebase-project.test.ts`
- Modify: `src/stash/index.ts`

- [ ] **Step 1:** Failing test: app at `/old/path`, `<new>` exists with expected markers, UPDATE flips the row.
- [ ] **Step 2:** Implement: `SELECT * FROM applications WHERE project_path = ? AND state = 'active'`; for each, verify `<new>` has matching markers (parseMarkers + filter by stash name); `UPDATE`.
- [ ] **Step 3:** Add `--force` flag to skip the marker sanity check (for users who know what they're doing).
- [ ] **Step 4:** Tests + smoke.
- [ ] **Step 5:** Commit: `feat(stash): tools stash rebase-project (closes deferred backlog #8)`

---

### Task 17: Tree-hash sibling-clone detection

**Why:** Per spec §8.9. Jaccard similarity of top-100 file paths when origin-URL and dir-pattern fallback both miss.

**Files:**
- Create: `src/stash/lib/sibling-clone-tree-hash.ts`
- Create: `src/stash/lib/sibling-clone-tree-hash.test.ts`
- Modify: `src/stash/lib/projects.ts` — call into tree-hash detection on miss

- [ ] **Step 1:** Failing test: two tmp repos with 80% file overlap → Jaccard > 0.7 → siblings; with 30% overlap → not siblings.
- [ ] **Step 2:** Implement `computeTreeHashSimilarity(repoA, repoB): number` via `git ls-files` (top 100 lexicographic) and `|A ∩ B| / |A ∪ B|`.
- [ ] **Step 3:** Cache in `projects.tree_hash` (the JSON list, hashed for fast equality short-circuit).
- [ ] **Step 4:** Wire into `detectSiblings()` in `lib/projects.ts` as third-priority fallback.
- [ ] **Step 5:** Add `--similarity-threshold <n>` hidden flag (default 0.7).
- [ ] **Step 6:** Commit: `feat(stash): tree-hash sibling-clone detection fallback (closes deferred backlog #6)`

---

## Self-Review

After writing this plan, I reviewed against `2026-06-25-StashTool-spec.md`:

**1. Spec coverage:**

| Spec section | Plan task(s) | Status |
|---|---|---|
| §1 Summary | Tasks 1-17 | ✓ |
| §2 Goals | Tasks 1-17 cover G1-G7 | ✓ |
| §3 Non-goals | Stated; nothing in plan violates | ✓ |
| §3a Dumb commands | Architectural reminder in Task 5; called out in Tasks 6, 8, 9, 10, 11, 13, 15, 16 | ✓ |
| §4 Curate workflow | Test in Task 12 | ✓ |
| §5 Unified walk | Tasks 4, 5, 6 | ✓ |
| §6 save behavior | Tasks 7 (regions table), 8 (same-name confirm), 9 (mode regions validation) | ✓ |
| §7 apply (unchanged) | Wave 2 Task 13 adds conflict SM | ✓ |
| §8 Deferred backlog (Wave 1) | Tasks 5, 7, 10, 11 (items 1, 3, 2, 4) | ✓ |
| §8 Deferred backlog (Wave 2) | Tasks 13, 14 (items 5, 9) | ✓ |
| §8 Deferred backlog (Wave 3) | Tasks 15, 16, 17 (items 7, 8, 6) | ✓ |
| §9 Region vs stash name | Documented in spec, taught in SKILL.md (separate task) | ✓ |
| §10 Migrations | Task 7 (002), state-file migration noted but no dedicated task — engineer should add on load in Task 4 | ⚠ Minor — state-file migration is implicit in Walk.load(); explicit test exists in walk.test.ts |
| §11 Audit findings | Task 7 closes D-31; Task 2 closes D-28; Task 1 addresses D-38 | ✓ |
| §12 Diff renderer | Tasks 2, 3 | ✓ |
| §13 Logging | Task 1 | ✓ |
| §14 Testing | Task 12 + per-task tests | ✓ |
| §15 Rejected items | Documented in spec; no tasks (correct — these are intentionally NOT built) | ✓ |
| §16 Out of scope | Not in plan | ✓ |

**2. Placeholder scan:** No `TBD` / `TODO` / `fill in later` in any task. Task 5 has one bracketed note ("engineer replaces with the real impl from unapply.ts") — this is intentional because the existing v1 code IS the reference; pulling 40 lines into the plan inline would be noise.

**3. Type consistency:**
- `Decision` type referenced in `walk.ts`, `walk-execute.ts`, `unapply.ts`, `update.ts` — same union (`capture | restore | skip | auto-capture | null`).
- `WalkRegion`, `WalkSnapshot` declared in `walk.ts`, imported elsewhere.
- `SaveMode` extended to include `"regions"` and `"patch"` consistently across `lib/patch.ts`, `index.ts`, `save.ts`.

**4. One known caller-gap to flag during implementation:** Task 6's `applyBlanketDecision(walk, opts.decision)` helper is referenced but its signature isn't shown explicitly — engineer should design it as `(walk: Walk, decision: string | undefined) => void` that handles only the `-all-dangerous` suffix forms.

---

## Execution Handoff

Plan complete and saved to `.claude/plans/2026-06-25-StashTool-plan.md`. Total tasks: 17 across 3 waves. Wave 1 = 12 tasks (foundation + commands + closes D-31). Wave 2 = 2 tasks (apply-conflict SM, author-marker-aware unapply). Wave 3 = 3 tasks (doctor, rebase-project, tree-hash).

**Recommended execution path:** subagent-driven, one task per subagent. Wave 1 ships as one PR after Tasks 1-12 land + green. Wave 2 + Wave 3 ship as separate PRs.
