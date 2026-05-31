# GenesisTools Monorepo — Target Architecture (Build-Pipeline frame: Turborepo + Bun workspaces)

> Status: design + **EXECUTED foundation milestone** (committed on `feat/monorepo-2`). `@gt/core` (10 modules) extracted with shims, 6 tools migrated to consume it, turbo wired with a verified FULL TURBO cache hit, whole-repo tsgo = 0.
> Frame: **build-pipeline** — Turborepo task orchestration + caching over Bun workspaces, packages with explicit `exports` maps, optimized for CI speed / incremental builds / remote+local caching / scaling to many packages.

## 0. What was actually measured (not hand-waved)

Before designing, the real code was inspected and a spike was run end-to-end in this worktree:

- **Master tsgo baseline = 0 errors** (`tsgo --noEmit` whole-repo on a clean checkout, log empty). This is the immovable bar: the foundation milestone must keep whole-repo tsgo at **0 new errors**.
- **Import surface (frequency-counted across `src/`):** `@app/utils` = 2147 imports, `@app/logger` = 590, then cross-tool imports (`@app/shops` 914, `@app/Internal` 323, `@app/youtube` 292, `@app/azure-devops` 176, …). Aliases `@ui/*` (666), `@ask/*` (121), `@ext/*` (23) are sub-trees, not separate packages.
- **Top shared modules:** `@app/utils/json` (403), `@app/utils/cli` (124), `@app/utils/format` (85), `@app/utils/prompts/p` (48), `@app/utils/paths` (42), `@app/utils/storage` (36+33), `@app/utils/date` (34), `@app/utils/table` (33), `@app/utils/ui/components/*` (button 33, badge 22, card 21, input 17), `@app/utils/readme` (32), `@app/utils/async` (19).
- **Dependency graph of the shared core (the decisive finding):**
  - Pure leaves (no `@app/*` deps): `json`, `date`, `string`, `paths`, `Stopwatch`, `array`, `object`, `math`. `format` → only `@app/utils/Stopwatch` (intra-leaf).
  - `logger.ts` → `@app/utils/date`, `@app/utils/json`.
  - `logger/out.ts` → `@app/utils/cli/*` **and** `@app/utils/prompts/p`.
  - `utils/cli/*` → `@app/logger` (commander.ts, executor.ts).
  - `utils/prompts/*` → `@app/logger`, `@app/utils/cli`, **and `@app/doctor/ui/tui/stores/prompt-store` (a TOOL)**.
  - `utils/async.ts` → `@app/logger`.
  - ⇒ **`cli ↔ logger ↔ prompts` form a mutually-recursive cluster, and `prompts` leaks into the `doctor` tool.** This cluster is NOT cleanly extractable now (see §6, deferred).

- **Foundation EXECUTED (committed):** `packages/core` (`@gt/core`) now holds **10 leaf modules** — `array`, `date`, `format`, `json`, `math`, `object`, `paths`, `paths.client`, `string`, `Stopwatch` — each behind a source-first `exports` subpath, each old `src/utils/<f>.ts` path replaced by a **re-export shim**. Six real tools migrated to import `@gt/core/*` directly: `json`, `npm-package-diff`, `files-to-prompt`, `last-changes`, `timer`, `usage`. Verified:
  - `tsgo --noEmit` whole-repo → **0 errors** (the `exports` map's `bun`/`types` conditions resolve to source `.ts` — **no tsconfig `paths` entry for `@gt/*` was needed**).
  - **`turbo run typecheck --filter=@gt/core`** → isolated package typecheck passes, and a rerun is **FULL TURBO cache hit** (904ms → 62ms) — the build-pipeline thesis made concrete, not asserted.
  - Bun runtime resolves **both** `@gt/core/<f>` (direct) and `@app/utils/<f>` (shim) — verified with `bun -e` and live tools.
  - All 6 migrated tools smoke-run green via `./tools`; `biome check` clean on touched files.
  - Root `bun test` discovers the relocated package tests (`packages/core/src/{math,paths.client}.test.ts`) — 13 pass.
  - One real boundary issue was caught-and-fixed during execution: `paths.ts` imports a pure sibling `paths.client.ts`, which had to move into `@gt/core` too (it also has external `@app/utils/paths.client` importers, so it got its own shim). This is exactly the kind of leak the per-file tsgo-0 gate surfaces.

This executed foundation is the proof-of-mechanism the whole spec rests on; the remaining packages are elaboration of this verified pattern.

## 1. Tooling choice + rationale

| Concern | Choice | Why |
|---|---|---|
| Workspace manager | **Bun workspaces** (`"workspaces": ["packages/*"]` in root `package.json`) | Bun is the only package manager allowed here. Workspaces are symlinked into `node_modules/@gt/*`, which is what makes both `exports`-map resolution (tsgo) and runtime resolution (Bun) work without any tsconfig `paths` change. Verified in spike. |
| Task orchestration + cache | **Turborepo** (`turbo`, pinned in devDeps) | The frame's mandate: a `dependsOn` graph for `typecheck`/`lint`/`test`/`build` with content-hash caching (local `.turbo/`, optional remote). turbo 2.7.3 is already on the machine. |
| Typecheck | **`tsgo --noEmit`** (NOT tsc) | Repo convention. Whole-repo run stays the green bar; per-package runs (turbo-cached) are the scaling win. |
| Lint/format | **biome** | Repo convention. Root `biome.json` already globs the whole tree; packages are picked up for free, and `turbo run lint` can scope per-package for cache hits. |
| Runtime | **Bun, no build step on the run path** | `./tools` runs `bun run` on TS directly. Decisive constraint: **internal consumption resolves to `src/*.ts`** via the `bun`/`types` export conditions. `dist` emit is *additive* (CI/publish/isolated-typecheck), never on the `./tools` run path — otherwise a fresh checkout would fail until `turbo build` ran, and we could not honestly claim "green = bun install + tsgo + smoke-run with no build step." |

### The `exports` map pattern (the heart of this frame)

Every package uses an `exports` map whose conditions are ordered **source-first**:

```jsonc
{
  "name": "@gt/core",
  "type": "module",
  "private": true,
  "exports": {
    "./math": {
      "bun":     "./src/math.ts",   // Bun runtime + tsgo (moduleResolution: bundler) honor this
      "types":   "./src/math.ts",   // TS picks up source types — no .d.ts build required to typecheck
      "default": "./dist/math.js"   // only used by non-Bun consumers / published artifact
    }
  }
}
```

- `bun` + `types` → `.ts` keeps the **no-build invariant** intact (Bun runs source, tsgo typechecks source).
- `default` → `dist` exists only so a `turbo build` artifact is cache-addressable and so the package *can* be consumed outside Bun later. It is never required for `./tools` or `tsgo` to be green.
- Subpath exports (`./math`, `./format`, …) preserve the deep-import ergonomics tools already rely on (`@app/utils/format`, not a fat barrel) and make turbo's per-subpath tree-shaking / future code-splitting clean.

## 2. Package list + responsibilities + dependency graph

Foundation extraction targets the **acyclic leaf spine** only. Everything cyclic is deferred (§6). The full target topology:

| Package | Responsibility | May depend on |
|---|---|---|
| **`@gt/core`** | Pure, dependency-light leaf utilities: `json` (SafeJSON), `date`, `format`, `string`, `paths`, `Stopwatch`, `array`, `object`, `math`. Zero `@app/*` deps except intra-package (`format`→`Stopwatch`). The acyclic spine. | (external npm only: `comment-json`) |
| **`@gt/logger`** *(later)* | The `logger`/`out` two-layer diagnostics+result system. | `@gt/core`, `@gt/cli`* |
| **`@gt/cli`** *(later)* | `commander` glue, `runTool`/`Executor`, `readme`, output-mode, prompt facade `p`. | `@gt/core`, `@gt/logger`* |
| **`@gt/storage`** *(later)* | `storage/storage.ts`, cache/TTL, `database/migrations`. | `@gt/core`, `@gt/logger` |
| **`@gt/ui`** *(later)* | `utils/ui/*` shared React components (`@ui/*` alias surface). | `@gt/core` |
| **`@gt/ai`** *(later)* | `utils/ai/*` (AIConfig, device, types), AI-SDK glue. | `@gt/core`, `@gt/logger` |
| **`apps/*` (the tools)** | Each `src/<tool>/` stays an app that consumes packages. No tool→tool extraction in foundation. | any `@gt/*` package |

> `@gt/logger` and `@gt/cli` are marked `*` because they are mutually recursive **today** (`out`→`cli`, `cli`→`logger`, `logger/out`→`cli`). They ship as **one combined package or stay co-located** until the cycle is broken (§6). They are explicitly NOT in the foundation milestone.

### Dependency graph (target, after full migration)

```
                 ┌────────────┐
                 │  @gt/core  │  (json,date,format,string,paths,Stopwatch,array,object,math)
                 └─────┬──────┘
        ┌──────────────┼───────────────┬───────────────┐
        ▼              ▼               ▼               ▼
   @gt/logger     @gt/storage      @gt/ui          @gt/ai
        │  ▲           │              │               │
        └──┤           │              │               │
       @gt/cli ────────┘              │               │
        │   (cli↔logger cycle: one pkg until §6)      │
        ▼              ▼              ▼               ▼
   ┌─────────────────────────────────────────────────────┐
   │                  apps/* (the 79 tools)               │
   │   ask, shops, youtube, azure-devops, task, …         │
   │   (tool→tool imports e.g. @app/shops kept as-is)     │
   └─────────────────────────────────────────────────────┘
```

Hard rule the graph enforces: **`@gt/core` has zero inbound `@app/*` edges** (verified acyclic), so it typechecks/builds/caches in true isolation. Each package up the stack adds exactly one tier of dependency. No package may import an `apps/*` tool (the rule the current `prompts→doctor` leak violates — that's why prompts is deferred).

## 3. How `./tools`, discovery, and `@app/*` map into the new layout

**Unchanged in foundation; tools stay in `src/<tool>/`.** The `./tools` entrypoint scans `src/` exactly as today (dir-with-`index.ts(x)` or standalone `.ts(x)`; tool name = dir/file name) and runs each via `bun run` with the two preloads. Nothing about discovery changes because tools do not move.

**`@app/*` alias is preserved verbatim.** `tsconfig.json` keeps `"@app/*": ["./src/*"]` (and `@ui`, `@ask`, `@ext`, `@app/yt`). The 40+ unmigrated tools keep importing `@app/utils/...` and compile unchanged — because every extracted module leaves a **re-export shim** at its old `src/` path:

```ts
// src/utils/math.ts  (after extraction — this is the entire file)
export * from "@gt/core/math";
```

So `@app/utils/math` → shim → `@gt/core/math` → `exports.bun`/`types` → `packages/core/src/math.ts`. tsgo and Bun both follow this chain (verified). The shim is **re-export only, no logic** — adding logic to a shim is forbidden (it would fork behavior between old and new import paths).

**New `@gt/*` imports** resolve purely through the Bun-workspace symlink + `exports` map — **no tsconfig `paths` entry is added for `@gt/*`** (the spike proved tsgo resolves it via `exports` under `moduleResolution: bundler`). Migrated tools may import either the shim path or `@gt/core/*` directly; both are green.

## 4. How the daily commands work after migration

| Command | Behavior after migration | Changes from today? |
|---|---|---|
| `bun install` | Installs root deps **and** symlinks `packages/*` into `node_modules/@gt/*`. Set `PUPPETEER_SKIP_DOWNLOAD=1` to avoid the unrelated puppeteer postinstall network failure muddying the exit code. | + workspace linking; otherwise same |
| Running a tool (`./tools <name>` / `tools <name>`) | Identical. `bun run`s `src/<tool>/...` directly; `@app/*` and `@gt/*` both resolve to source `.ts`. No build step. | none |
| `tsgo --noEmit` (whole repo) | Still typechecks the whole tree to **0 errors**. This stays the green bar. | none |
| `tsgo` per package (NEW) | `turbo run typecheck` fans out, each package typechecked in isolation against its own deps, **content-hash cached** — unchanged packages are skipped. The scaling win. Requires each package to be isolation-clean (no tool leaks). | new, additive |
| `bun test` | Root script keeps its ignore-pattern set; package tests travel with their files (e.g. `packages/core/src/math.test.ts`, import `./math` relatively — verified passing). `turbo run test` can scope+cache per package. | + per-package caching |
| `biome check .` | Whole-tree lint unchanged; `turbo run lint` adds per-package cache scoping. | + caching |
| `turbo build` (NEW) | Emits `dist/` per package for CI artifacts / isolated-typecheck / future external publish. **Never required** for `./tools` or `tsgo`. | new, additive, off run-path |

### Root `turbo.json` (target)

```jsonc
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "typecheck": { "dependsOn": ["^typecheck"], "outputs": [] },
    "build":     { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "lint":      { "outputs": [] },
    "test":      { "dependsOn": ["^build"], "outputs": ["coverage/**"], "env": ["CI"] }
  }
}
```

`^typecheck`/`^build` = "do upstream packages first." `@gt/core` typechecks before anything depending on it; an unchanged `@gt/core` is a cache hit and its dependents skip re-typecheck. This is the entire CI-speed thesis of the build-pipeline frame.

## 5. CI implications

- **Incremental everything.** turbo content-hashes inputs; a PR touching one tool re-runs only that tool's `typecheck`/`lint`/`test` plus any package it changed and that package's dependents. The current model re-runs whole-repo `tsgo`/`biome`/`bun test` every time.
- **Remote cache (optional, high-leverage).** `turbo` remote cache (self-hosted or Vercel) means CI and every dev share artifacts: a green `@gt/core` typecheck computed once is reused across machines. Biggest win as package count grows.
- **The whole-repo green gate stays.** CI keeps one `tsgo --noEmit` whole-repo job as the non-negotiable correctness gate (catches cross-package drift the per-package graph can't), *plus* the fast cached turbo fan-out for fast feedback. Belt and suspenders.
- **`PUPPETEER_SKIP_DOWNLOAD=1` in CI install** so a transient browser-download failure never reds the install step (it doesn't affect the dependency tree — confirmed locally).
- **Pin `turbo`** in root devDeps (turbo warns when only a global is present) for reproducible CI.

## 6. Deferred (post-foundation) phases — honestly scoped

These are NOT in the foundation milestone because they cannot keep the green bar without prerequisite refactors:

1. **Break the `cli ↔ logger ↔ prompts` cycle, then extract `@gt/logger` + `@gt/cli`.** Prerequisite: **invert `prompts → @app/doctor/ui/tui/stores/prompt-store`** (a package importing a tool makes isolated typecheck impossible — the leak that would silently fail `turbo run typecheck` even while whole-repo tsgo is green). Move the doctor prompt-store contract into `@gt/cli` (or behind an injected interface). Also resolve `async.ts → @app/logger` (keep `async` out of `@gt/core`, or land it in `@gt/logger`).
2. **Extract `@gt/storage`, `@gt/ui`, `@gt/ai`** — each is a leaf-ish cluster once `@gt/core`+`@gt/logger` exist. `@gt/ui` carries the `@ui/*` component surface (666 imports) and unblocks the dashboard sub-projects.
3. **Cutover (delete shims, rewrite importers).** Once a critical mass of tools import `@gt/*` directly, codemod the remaining `@app/utils/*` importers to `@gt/*` and delete the re-export shims. **Explicitly out of foundation scope** — the shims are what keep the partial migration green; removing them is a separate, mechanical, repo-wide pass.
4. **Promote hot tool-clusters to `apps/*` packages** (`shops` 914 inbound, `youtube`, `azure-devops`) so they gain isolated typecheck + cache too. Optional, pure scaling.

## 7. Trade-offs vs the other two frames

The two sibling approaches are (A) **minimal Bun-workspaces, no build pipeline** (just `packages/utils`, source-only, no turbo) and (B) **TS project-references / path-alias-centric** (per-package `tsconfig` + `references`, leaning on `tsc -b`/tsgo project graph rather than a task runner).

**Where this (build-pipeline) frame wins:**
- **CI/incremental speed at scale.** Content-hash caching + `dependsOn` fan-out is the only frame that makes a 79-tool repo's `typecheck`/`lint`/`test` sublinear per PR. Frame A re-runs whole-repo; frame B gets incremental *typecheck* via project refs but has no caching for lint/test and no remote/shared cache.
- **Remote cache** — shared green artifacts across CI + all devs. Neither sibling offers this.
- **`exports` maps** give explicit, enforceable package boundaries (and future external-publish optionality via the `dist` condition) that a pure alias scheme (frame B) does not.

**Where this frame costs more:**
- **Most tooling/config surface.** A `turbo.json`, per-package `package.json`+`exports`, and (for isolated typecheck to mean anything) per-package `tsconfig` — vs frame A's near-zero config.
- **Most punished by dependency leaks.** The build-pipeline frame's headline feature is *isolated, cached per-package* tasks — but `prompts→doctor` and the `cli↔logger` cycle make that feature *lie* (whole-repo green hides a broken boundary). This frame must therefore be the most disciplined about acyclicity, which is exactly why foundation here is conservatively scoped to `@gt/core` only. Frame A doesn't care about cycles (it never typechecks in isolation); frame B partially exposes them via project-ref build ordering but tolerates source-only resolution.
- **Two sources of truth for resolution** (`exports` map conditions + the `@app/*` tsconfig alias) until cutover. Frame B centralizes on tsconfig `paths`+`references`; this frame deliberately avoids adding `@gt/*` to tsconfig `paths` (spike showed `exports` suffices) to keep the alias layer thin, but the `exports` conditions are now load-bearing and must be reviewed on every package.
- **`dist` discipline.** The `default→dist` condition is a foot-gun: if a consumer ever resolves through it without a prior `turbo build`, it fails confusingly. Mitigation: `bun`+`types` always precede `default`, and CI gates that `./tools` + tsgo never need `dist`.

**Net:** this frame is the right one *if* the repo is heading toward many packages + slow CI and the team will hold the line on acyclicity. Its failure mode is config sprawl + boundary leaks that quietly defeat caching — so the foundation must be small, proven, and shim-protected, which is what the committed spike demonstrates.
