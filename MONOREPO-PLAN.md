# GenesisTools Monorepo — Migration Plan (Approach 3: Domain-Driven)

> Concrete, ordered steps **for this worktree** (`feat/monorepo-3`). The
> **FOUNDATION milestone** is fully achievable now and leaves the repo GREEN
> (`bun install` + whole-repo `tsgo --noEmit` = 0 errors + smoke-run of `./tools`
> and the migrated tools). Everything after foundation is scoped follow-up.
>
> Read `MONOREPO-SPEC.md` first for the target architecture, the no-build proof
> (§0.6), the boundary-violation inventory (§0.3), and the layer model.

---

## 0. Pre-flight (measure green before touching anything)

These were run in this worktree; re-run on a clean checkout if the baseline is
ever in doubt.

```bash
cd /Users/Martin/Tresors/Projects/GenesisTools-monorepo-3
bun install
# Master baseline — MUST be 0:
tsgo --noEmit 2>&1 | rg -c "error TS"        # → 0  (this is the bar)
# Smoke-run discovery + a few tools (golden outputs to compare after migration):
./tools timer --help        2>&1 | tail -3
./tools usage --help        2>&1 | tail -3
./tools json --help         2>&1 | tail -3
```

**Definition of GREEN (the foundation gate, non-negotiable):**
1. `bun install` succeeds and links `node_modules/@gt/*`.
2. **Whole-repo** `tsgo --noEmit` reports **0 errors** (== master baseline; not a
   narrowed/per-package check).
3. `./tools` still discovers all tools; the 6 migrated tools run with unchanged
   behavior; the unmigrated 70+ tools still import `@app/utils/*` and compile.

---

## FOUNDATION MILESTONE

Extract exactly **one** import-closed package — `@gt/core` — leave a re-export
shim at every old `@app/utils/*` path, migrate **6 representative tools** to
consume `@gt/core` directly, and land the boundary guard in *warn* mode.

> Why only `@gt/core` now: it is the **only** genuinely import-closed leaf
> (SPEC §0.5). The logger (§0.4) and every L2+ domain (§0.3) carry cycles /
> reverse-deps that require deliberate breaking — that is target/phase work, not
> foundation. Holding this line is what keeps the milestone green.

### Step F1 — Enable Bun workspaces + (optional) tsconfig fallback path

`package.json` (root): add the workspaces field.
```jsonc
{
  "name": "genesis-tools",
  "type": "module",
  "workspaces": ["packages/*"],   // ← add
  ...
}
```

`tsconfig.json` — **belt-and-suspenders** (SPEC §1.1; proven *not* required for
tsgo but deterministic and on-idiom). Add as the first `paths` entry:
```jsonc
"paths": {
  "@gt/core": ["./packages/core/src/index.ts"],
  "@gt/core/*": ["./packages/core/src/*"],
  "@app/*": ["./src/*"],
  ...keep all existing entries unchanged...
}
```
> Use the explicit `@gt/core` + `@gt/core/*` shape (not a blanket `@gt/*`) so the
> mapping matches the real on-disk `packages/core/src/<module>.ts` layout. As more
> packages are extracted, add their two-line entries the same way. The
> package-`exports` map remains the source of truth.

`bun install` → verify symlink:
```bash
bun install
ls -la node_modules/@gt/        # → core -> ../../packages/core
```

### Step F2 — Scaffold the `@gt/core` package

Create `packages/core/package.json` (no build, `exports → .ts`):
```jsonc
{
  "name": "@gt/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".":           "./src/index.ts",
    "./json":      "./src/json.ts",
    "./date":      "./src/date.ts",
    "./format":    "./src/format.ts",
    "./string":    "./src/string.ts",
    "./array":     "./src/array.ts",
    "./object":    "./src/object.ts",
    "./math":      "./src/math.ts",
    "./hash":      "./src/hash.ts",
    "./tokens":    "./src/tokens.ts",
    "./Stopwatch": "./src/Stopwatch.ts"
  }
}
```
> Foundation core set = the import-closed leaf from SPEC §0.5. `async.ts` is
> **excluded** (it imports `@app/logger`, which is non-leaf) and stays in `src/`.
> `fuzzy-match`/`url`/`sql-time` are listed in the SPEC's `@gt/core` target but
> are deferred to a later `@gt/core` expansion to keep the foundation diff small
> and obviously import-closed.

Optional `packages/core/tsconfig.json` (isolated typecheck aid; additive only):
```jsonc
{ "extends": "../../tsconfig.json", "include": ["src/**/*"] }
```

### Step F3 — Move the leaf modules with `git mv` (preserve history) + colocated tests

For each module in the core set, move source **and** its colocated test:
```bash
mkdir -p packages/core/src
git mv src/utils/json.ts        packages/core/src/json.ts
git mv src/utils/json.test.ts   packages/core/src/json.test.ts
git mv src/utils/date.ts        packages/core/src/date.ts
git mv src/utils/date.test.ts   packages/core/src/date.test.ts
git mv src/utils/format.ts      packages/core/src/format.ts
git mv src/utils/format.test.ts packages/core/src/format.test.ts
git mv src/utils/string.ts      packages/core/src/string.ts
git mv src/utils/string.test.ts packages/core/src/string.test.ts
git mv src/utils/array.ts       packages/core/src/array.ts
git mv src/utils/array.test.ts  packages/core/src/array.test.ts
git mv src/utils/object.ts      packages/core/src/object.ts
git mv src/utils/object.test.ts packages/core/src/object.test.ts
git mv src/utils/math.ts        packages/core/src/math.ts
git mv src/utils/math.test.ts   packages/core/src/math.test.ts
git mv src/utils/hash.ts        packages/core/src/hash.ts
git mv src/utils/tokens.ts      packages/core/src/tokens.ts
git mv src/utils/tokens.test.ts packages/core/src/tokens.test.ts
git mv src/utils/Stopwatch.ts   packages/core/src/Stopwatch.ts
```
**Fix the one intra-set edge:** `format.ts` imported `@app/utils/Stopwatch`.
Inside the package, rewrite that single import to the sibling:
`from "@app/utils/Stopwatch"` → `from "./Stopwatch"` (or `@gt/core/Stopwatch`).
Leave all other imports in the moved files as-is (they have none — §0.5).

Create `packages/core/src/index.ts` (barrel — `export * from "./json"`, etc. for
each module) so `@gt/core` (root) also works.

### Step F4 — Leave a re-export SHIM at every old `@app/utils/*` path (THE green-keeper)

For each moved module, recreate the old path as a **pure re-export** (no logic):
```ts
// src/utils/format.ts  (entire file)
export * from "@gt/core/format";
```
Do this for `json`, `date`, `format`, `string`, `array`, `object`, `math`,
`hash`, `tokens`, `Stopwatch`. If any original had a default export, add
`export { default } from "@gt/core/<mod>";` too (check: `rg -n "export default"
packages/core/src/<mod>.ts`). These shims keep the **1124 `@app/utils/*` import
sites** in the 70+ unmigrated tools compiling and running **unchanged** — they
are the entire reason the partial migration is green.

> **`json` keystone shim — proven safe (the highest-stakes shim, 403 sites):**
> `src/utils/json.ts` has **zero `export default`** and **zero consumers import
> it via a default import** (both verified in this worktree: `rg -n "export
> default" src/utils/json.ts` → none; default-import grep over `src` → none).
> Every site uses `import { SafeJSON } from "@app/utils/json"` (named, as
> CLAUDE.md mandates), so `export * from "@gt/core/json"` re-exports `SafeJSON`
> to all 403 sites — the shim cannot silently drop the keystone.

> Do **not** move the colocated `*.test.ts` shims — the tests moved *with* their
> source in F3, so there is nothing to shim on the test side.

### Step F5 — Migrate the 6 representative tools to consume `@gt/core` directly

These were chosen by evidence (`rg -oN "@app/utils/(format|date|json|…)"`) to
span domains and exercise the three highest-traffic core modules (`format`,
`date`, `json` — `json`/SafeJSON alone has 403 import sites):

| tool | domain | core modules it uses | files to edit |
|---|---|---|---|
| `timer` | utility | `format` | `src/timer/index.ts` |
| `last-changes` | git | `date`, `format` | `src/last-changes/index.ts` |
| `files-to-prompt` | fs/collection | `format` | `src/files-to-prompt/index.ts` |
| `usage` | analytics | `date`, `json` | `src/usage/index.ts` |
| `json` | data | `json` (SafeJSON keystone) | `src/json/index.ts` |
| `benchmark` | perf (multi-file) | `format`, `json` | `commands/history.ts`, `commands/show.ts`, `lib/display.ts`, `lib/results.ts`, `lib/runner.ts` |

For each, rewrite **only the core-module imports**:
```ts
-import { formatDuration } from "@app/utils/format";
+import { formatDuration } from "@gt/core/format";
```
Leave every *other* `@app/utils/*` / `@app/logger` import in these tools flowing
through shims — mixed state is fine and green (SPEC §3.2). `benchmark` proves a
**multi-file, deep-import** tool migrates cleanly without a build step.

> Why migrate tools at all (vs. just shimming): it demonstrates the *consumer*
> contract end-to-end — a tool importing a `@gt/*` package by name, resolved via
> workspace `exports → .ts`, typechecked and run with no build (SPEC §0.6).

### Step F6 — Boundary guard in WARN mode

Add `scripts/ci/check-package-boundaries.ts` (Bun script, SPEC §1.4):
- enumerate imports in `packages/**` and `src/**`;
- **fail** if any `packages/core/**` file imports anything outside `@gt/core` /
  `node_modules` (proves the leaf stays clean — this rule is *fail* from day one
  because `@gt/core` is genuinely closed);
- **warn** (don't fail yet) on the §0.3 reverse-dep violations and tool↔tool
  imports — these flip to *fail* in their respective follow-up phases.

Wire it into the existing check set (alongside `logging-guard.sh`,
`check-ui-palette.ts`); extend `logging-guard.sh` globs to also scan
`packages/**`.

### Step F7 — Verify GREEN, then commit

```bash
bun install
tsgo --noEmit 2>&1 | rg -c "error TS"        # MUST be 0
./tools                       2>&1 | head -5  # discovery still works
./tools timer --help          2>&1 | tail -3
./tools last-changes --help   2>&1 | tail -3
./tools files-to-prompt --help 2>&1 | tail -3
./tools usage --help          2>&1 | tail -3
./tools json --help           2>&1 | tail -3
./tools benchmark --help      2>&1 | tail -3
bun run scripts/ci/check-package-boundaries.ts   # passes (warn-only on known)
bun test packages/core/src    2>&1 | tail -10     # moved tests pass in new home
```
If all green:
```bash
git add -A
git commit -m "feat(monorepo): foundation — @gt/core package + shims + 6 tools migrated"
```

> **Foundation invariants to re-confirm before declaring done (SPEC §3.1/§3.6):**
> - `./tools` preload paths (`src/utils/bun/preload-solid-scoped.ts`,
>   `src/utils/search/stores/sqlite-vec-preload.ts`) are **untouched** — the core
>   extraction never moves `bun/` or `search/`. ✔ by construction.
> - `bunfig.toml` preload list is **untouched**. ✔
> - `package.json#test` `--path-ignore-patterns` globs: none of the moved core
>   files matched an ignored pattern (they were top-level `src/utils/*.ts`), so
>   their tests now run from `packages/core/src`. Confirm `bun test` count didn't
>   silently drop them.

---

## FOLLOW-UP PHASES (scoped; each ends GREEN; not part of foundation)

Every phase follows the same shape: **`git mv` real code → leave shims → migrate
a few consumers → flip the relevant boundary-guard rule from warn to fail →
verify whole-repo tsgo = 0 + smoke-run**. Shims are never deleted until the final
cutover.

### Phase L0b — finish `@gt/core`
Move the remaining clean leaves into `@gt/core`: `fuzzy-match`, `fuzzy-tokens`,
`url`, `sql-time` (+ tests), each with a shim. Pure-add; no cycle risk.

### Phase L1 — process & IO primitives
Extract, in this intra-layer order (SPEC §2.1):
1. **`@gt/cli-core`** (`src/utils/cli/*`) — depends on `@gt/core` only.
2. **`@gt/prompts`** (`src/utils/prompts/*`) — depends on core + cli-core.
3. **`@gt/logger`** (`src/logger.ts`, `src/logger/*`) — depends on core +
   cli-core + prompts (SPEC §0.4). This is the big one: **561 `@app/logger`
   import sites**, all kept green by the `src/logger.ts` shim
   (`export * from "@gt/logger"`). Now `async.ts` can move into `@gt/core`'s
   expansion *or* a `@gt/logger`-aware home, since logger exists below it.
   **Cycle to break first (measured, SPEC §2.1 caveat):** `prompts/*` imports
   `@app/logger` back in 3 clack-helper files (`multiline.ts`,
   `settings-summary.ts`, `trash-staging.ts`). Before `@gt/logger` and
   `@gt/prompts` can be separate packages, break this — route those helpers'
   logging through an injected logger or a `@gt/core` log contract, OR co-locate
   `logger`+`prompts`+`cli-core` into one L1 package. Verify `prompts ↛ logger`
   with the boundary guard before flipping the rule to fail.
4. **`@gt/storage`**, **`@gt/fs`**, **`@gt/process`** — each depends on core.
Flip boundary-guard: packages may not import `@app/<tool>` (fail).

### Phase L2 — cross-cutting infrastructure
**`@gt/database`**, **`@gt/net`**, **`@gt/search`**. When `@gt/search` lands,
**update the `./tools` and `bunfig.toml` preload paths for
`sqlite-vec-preload.ts`** in the same commit (runtime path; invisible to tsgo).

### Phase L3 — product domains (cycle-breaking work)
- **`@gt/ai` + `@gt/macos` (break the ai↔macos cycle, SPEC §0.3/§2.1):** define
  `@gt/ai/contracts` interfaces (`SpeechProvider`, `NlpProvider`,
  `ClassifierProvider`); move the macOS-backed implementations into `@gt/macos`
  which depends on `@gt/ai`. `@gt/ai` must never import `@gt/macos`. Verify with
  the guard (flip ai↔macos rule to fail).
- **`@gt/github`:** move the `@app/github/*` helpers that `utils/github/url-parser`
  + `utils/github/utils` reach into *down* into `@gt/github` (they were
  mis-located); reverse the edge.
- **`@gt/notifications`:** invert `channels/telegram.ts → @app/telegram-bot` via a
  `NotifierChannel` interface registered by the telegram tool.
- **`@gt/claude`**, **`@gt/agents`**, **`@gt/markdown`**, **`@gt/audio`** —
  straightforward moves.

### Phase L4 — terminal/UI domains (heavy; mostly tsgo-excluded today)
- **`@gt/tui` (break the log-viewer cluster, SPEC §0.3):** extract
  `LogEntry`/`LogSource` contracts into `@gt/tui`; `task` and `debugging-master`
  *provide* their log sources to the viewer (tool → package), removing
  `utils/log-viewer → @app/task` + `@app/debugging-master`.
- **`@gt/ui` + youtube fix:** move `ui/components/youtube/*` (8 files) into the
  youtube tool (or `@gt/youtube-ui` feature pkg); extend `check-ui-palette.ts` to
  scan `@gt/ui`.
- **`@gt/cmux` / `@gt/tmux`:** shared multiplexer primitives → package;
  cmux-tool glue → back into the `cmux` tool (break `utils/cmux ↔ @app/cmux`).

### CUTOVER (final phase, explicitly OUT of foundation scope)
1. Rewrite **all** remaining `@app/utils/*` / `@app/logger` importers
   (~1700 sites) to `@gt/*` (mechanical, codemod-able with ts-morph already in
   devDeps).
2. **Delete every shim** under `src/utils/*` and `src/logger.ts`.
3. Optionally drop the `@app/*` tsconfig path (or keep it pointing at the few
   remaining `src/utils/*` files that never became packages).
4. Boundary guard now fully in **fail** mode for all rules.
This phase is large and risky; it is sequenced last and gated by the guard being
green in fail mode for every prior layer.

---

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Shim isn't a *pure* re-export (adds logic / drops an export) → new tsgo errors | Med | `export * from` only; add `export { default }` when the original had one; whole-repo tsgo after each shim batch (baseline = 0, so any non-zero is caught immediately) |
| A "leaf" turns out impure (like `async.ts → logger`) | Low (audited §0.5) | Per-file `rg -oN "@app/..."` import-closure check before moving; exclude impure files |
| `./tools` / `bunfig.toml` preload path breaks at *runtime* (tsgo can't see it) | Med | Foundation never moves `bun/` or `search/`; later phases update BOTH call sites in the same commit + smoke-run `./tools <tool>` |
| `bun test` ignore globs silently drop a moved test | Low | After each move, compare `bun test` collected-count; SPEC §3.6 |
| ai↔macos / logger→cli cycles re-introduced during a phase | Med | Boundary-guard rule flipped to *fail* for that edge as the phase completes; cannot regress |
| tsgo follows `exports` differently than bun runtime | Low (both proven §0.6) | Belt-and-suspenders tsconfig `@gt/<pkg>` paths make tsgo resolution deterministic regardless |
| Cutover (1700 rewrites) introduces errors | Med (deferred) | ts-morph codemod + per-layer phasing + guard in fail mode before cutover starts |
| Reviewer mistakes foundation for the full aggressive split | Med | SPEC §0.3/§5 + this plan state plainly: foundation = `@gt/core` + shims + 6 tools; all aggression is phases |

---

## What "done" looks like for the FOUNDATION (acceptance checklist)

- [ ] `package.json#workspaces: ["packages/*"]`; `bun install` links `@gt/core`.
- [ ] `packages/core` exists with `.ts`-only `exports`, no build step, barrel
      `index.ts`, colocated tests passing in their new home.
- [ ] Every moved `src/utils/<mod>.ts` is a pure `export * from "@gt/core/<mod>"`
      shim; the 70+ unmigrated tools compile unchanged.
- [ ] 6 tools (`timer`, `last-changes`, `files-to-prompt`, `usage`, `json`,
      `benchmark`) import their core modules from `@gt/core` and run identically.
- [ ] `scripts/ci/check-package-boundaries.ts` exists, fails on `@gt/core`
      impurity, warns on the §0.3 backlog.
- [ ] **Whole-repo `tsgo --noEmit` = 0 errors** (== master baseline).
- [ ] `./tools` discovery + the 6 migrated tools smoke-run clean.
- [ ] Committed: `feat(monorepo): foundation — @gt/core package + shims + 6 tools migrated`.
