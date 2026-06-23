# MONOREPO-SPEC — Approach 1: Incremental Bun Workspaces (lowest-risk)

**Branch:** `feat/monorepo-1` · **Worktree:** `/Users/Martin/Tresors/Projects/GenesisTools-monorepo-1`
**Frame:** INCREMENTAL / LOWEST-RISK using **Bun workspaces**. Preserve the
"Bun runs TypeScript directly, no build step" property. Extract only
*genuinely-shared, dependency-closed leaf code* into a small number of
workspace packages. Tools stay where they are. Add as little tooling as
possible. Optimize for: smallest diff, zero behavior change, trivial review,
fast adoption.

This document is the target architecture. `MONOREPO-PLAN.md` is the ordered
execution for this worktree.

---

## 0. Master baseline (the measurable "green" anchor)

Established on a clean checkout of `master` (`581f71f70f9ddfb4671628f76203be3488c06683`)
after `bun install`:

```
tsgo --noEmit            → exit 0, ZERO diagnostics (empty output, 0 lines)
```

So the foundation milestone bar is exact and falsifiable: **whole-repo
`tsgo --noEmit` must still emit ZERO errors** (not "zero new in a narrowed
scope" — the whole repo, identical command). Anything above 0 is a regression.

> Note: `bun install` runs a `puppeteer` postinstall that downloads a browser
> over the network; on this machine it fails (`postinstall script from
> "puppeteer" exited with 1`) but `node_modules` is fully populated and tsgo +
> tools run regardless. This is a pre-existing environmental wart, unrelated to
> the monorepo work — do NOT let it mask a real install failure (verify
> `node_modules/{pino,comment-json,chalk,commander}` exist).

---

## 1. What the repo looks like today

- **Runtime:** Bun executes `.ts`/`.tsx` directly. **No build step.** This is
  the load-bearing property the whole frame protects.
- **Package manager:** `bun` only (`bun add`, `bunx`). Never npm/npx.
- **Entry point:** root `./tools` (a `#!/usr/bin/env bun` TS file). It scans
  `src/` for tool dirs (containing `index.ts`/`index.tsx`) or standalone
  `.ts`/`.tsx` files; tool name = dir/file name. It then `bun`-spawns the
  target with two `--preload` scripts (`preload-solid-scoped.ts`,
  `sqlite-vec-preload.ts`) resolved relative to the workspace root.
- **Path aliases (`tsconfig.json` `compilerOptions.paths`):**
  - `@app/*` → `./src/*`  (the universal alias; **1867 files** import `@app/*`)
  - `@ask/*`, `@ui`, `@ui/*`, `@ext`, `@ext/*`, `@app/yt`, `@app/yt/*` (tool-local)
- **Conventions (binding, from `CLAUDE.md`):** `SafeJSON` not `JSON`
  (biome-enforced via `noRestrictedGlobals`); no `// path` header comments;
  the `logger`/`out` two-layer split with `scripts/ci/logging-guard.sh`
  enforcing logger import shape repo-wide; `src/utils/` is the shared-utility
  home; typecheck = `tsgo --noEmit`; lint/format = biome (4-space indent,
  120 cols, plus 4 custom grit plugins).
- **Tests:** `bun test`, `*.test.ts` colocated beside source (128 under
  `src/utils/` alone). `bunfig.toml` declares preloads for both runtime and
  the test runner.

### 1.1 The dependency map that decides the design

I traced the actual `@app/*` import graph of the shared-code candidates. Two
clusters emerge:

**(A) Clean dependency-closed LEAVES** — no `@app/*` deps, or deps only on each
other:

| Module | `@app/*` deps | External deps |
|---|---|---|
| `utils/json.ts` | none | `comment-json` |
| `utils/json-schema.ts` | `utils/json` (in-set) | — |
| `utils/paths.ts` | none | — |
| `utils/string.ts` | none | — |
| `utils/date.ts` | none | — |
| `utils/date-locale.ts` | none | — |
| `utils/math.ts` | none | — |
| `utils/array.ts` | none | — |
| `utils/object.ts` | none | — |
| `utils/Stopwatch.ts` | none | — |
| `utils/tokens.ts` | none | — |
| `utils/hash.ts` | none | — |
| `utils/url.ts` | none | — |
| `utils/format.ts` | `utils/Stopwatch` (in-set) | `filesize` |

This set is **transitively closed**: every `@app/*` dependency of a member is
another member. That is exactly what makes it safe to extract.

**(B) A tightly CYCLIC foundation cluster** — must NOT be touched in the
foundation milestone:

```
logger.ts ⇄ utils/cli/*          (logger imports utils/cli/{stdout,stderr,result,output-mode,quiet-spinner};
                                   utils/cli imports @app/logger)
logger/out.ts ──VALUE──▶ utils/prompts/p   (import * as p, NOT type-only)
utils/prompts/p/opentui-backend.ts ──VALUE──▶ @app/doctor/ui/tui/stores/prompt-store
                                   (imports a TOOL's TUI store — usePromptStore)
utils/storage ──▶ logger, utils/json, utils/process-alive
utils/cli ──▶ logger, utils/json, utils/readme, utils/logging/tool-policy, utils/test/skip
```

The decisive fact: **`logger/out.ts:7` is `import * as p from
"@app/utils/prompts/p"` (a value import), and `prompts/p/opentui-backend.ts:2`
is `import { usePromptStore } from "@app/doctor/ui/tui/stores/prompt-store"` (a
value import of a tool's UI store).** Under `verbatimModuleSyntax`, value
imports are NOT erased. Therefore any package that contains `logger` drags in
`prompts/p`, which drags in the `doctor` tool. That is not "foundation" code —
it is tool code with a back-edge into the shared layer. Extracting logger now
would either pull a whole tool into the shared package or require breaking that
cycle first. **Logger/cli/prompts/storage are deferred to a later phase, by
design.** (Breaking the `prompts/p → doctor` edge is its own refactor and is
out of scope here.)

This is the core reason Approach 1 is *incremental*: extract the closed leaf
set now, defer the cyclic cluster.

---

## 2. Tooling choice

**Bun workspaces, and nothing else.** No Turborepo, no Nx, no tsup, no
changesets, no project-reference build graph in the foundation milestone.

Rationale:
- The repo's defining property is **no build step**. Any tool that introduces
  a compile/bundle stage (tsup as the old PR #16 did) breaks that property and
  forces a `dist/` + watch loop into the inner dev loop. Rejected.
- Bun natively resolves a workspace package's **TypeScript source** through the
  package's `exports` map (pointing at `.ts` files). No emit, no `dist/`.
- Turbo/Nx add a task-graph cache that buys nothing for a no-build,
  Bun-test-runner repo of this size, and add config + a learning surface. They
  are the right call for *many* compiled packages with expensive builds — not
  here. (See §8 trade-offs.)
- Biome and `tsgo` already operate on the whole tree from root; they need zero
  workspace-awareness.

**New tooling added by the foundation milestone: exactly one field**
(`"workspaces"` in root `package.json`) **plus one new `packages/utils/`
directory with a 6-line `package.json` and no build script.** That is the
entire tooling delta.

---

## 3. Target package layout

```
genesis-tools/                      (root workspace, name: "genesis-tools")
├── package.json                    + "workspaces": ["packages/*"]
├── tsconfig.json                   + 2 path-alias lines for @gt/utils
├── bunfig.toml                     (unchanged)
├── biome.json                      (unchanged)
├── tools                           (unchanged — discovery + preloads identical)
├── packages/
│   └── utils/                      package name: "@gt/utils"
│       ├── package.json            type:module, exports map → .ts (NO build)
│       └── src/
│           ├── json.ts             (moved from src/utils/json.ts)
│           ├── json-schema.ts
│           ├── paths.ts
│           ├── string.ts
│           ├── date.ts
│           ├── date-locale.ts
│           ├── math.ts
│           ├── array.ts
│           ├── object.ts
│           ├── Stopwatch.ts
│           ├── tokens.ts
│           ├── hash.ts
│           ├── url.ts
│           ├── format.ts
│           └── *.test.ts           (colocated tests move with their source)
└── src/                            (all 70+ tools stay here, untouched except
    ├── utils/                       the 14 extracted files become shims)
    │   ├── json.ts                 → export * from "@gt/utils/json";   (SHIM)
    │   ├── format.ts               → export * from "@gt/utils/format"; (SHIM)
    │   ├── paths.ts                → SHIM …  (one shim per moved file)
    │   └── … (everything else unchanged: cli/, storage/, logger live on)
    ├── logger.ts                   (UNCHANGED — deferred cluster)
    └── <tool>/ …                   (40+ tools unchanged)
```

### 3.1 Package list + responsibilities

| Package | Responsibility | Depends on |
|---|---|---|
| **`@gt/utils`** | Dependency-closed leaf utilities: JSON (`SafeJSON`, `parseJSON`), JSON-schema inference, path/tilde helpers, string/date/math/array/object helpers, `Stopwatch`, token counting, hashing, URL helpers, formatting (`formatBytes/Duration/…`). Pure, no runtime side effects, no logger, no CLI, no prompts. | external only (`comment-json`, `filesize`); nothing in `@gt/*` or `@app/*` |

**Inter-package dependency graph (foundation milestone):**

```
@gt/utils   →   (external npm only)        # a single leaf package, no @gt edges
   ▲
   │  consumed by
src/<tool>/*  and  src/utils/* shims
```

There is exactly **one** workspace package in the foundation milestone. A
second package (`@gt/core` for the logger/cli/prompts/storage cluster) is
*designed for* (§7) but deliberately not created now, because its closure is
cyclic and reaches into a tool.

### 3.2 Why one package, not many (vs old PR #16)

PR #16 split utils across subpath `exports` (`/storage`, `/formatting`,
`/path`, `/diff`, `/rate-limit`, `/logger`) **and built them with tsup to
`dist/`**. Two problems it hit and we avoid:
1. **It reintroduced a build step** (`tsup`, `dist/`, `main`/`module`/`types`
   pointing at compiled JS). That contradicts the repo's no-build property.
2. It put `logger` in the shared package — which, given the cyclic cluster
   above, is the hardest possible thing to extract cleanly.

We keep ONE package, point `exports` at `.ts`, and only move the closed leaf
set. Subpath granularity (`@gt/utils/json`, `@gt/utils/format`, …) is preserved
**without** a build, so existing per-module import ergonomics are unchanged.

---

## 4. How the moving parts map into the new layout

### 4.1 `package.json` (`packages/utils/package.json`)

```jsonc
{
  "name": "@gt/utils",
  "type": "module",
  "private": true,
  "exports": {
    "./json":        "./src/json.ts",
    "./json-schema": "./src/json-schema.ts",
    "./paths":       "./src/paths.ts",
    "./string":      "./src/string.ts",
    "./date":        "./src/date.ts",
    "./date-locale": "./src/date-locale.ts",
    "./math":        "./src/math.ts",
    "./array":       "./src/array.ts",
    "./object":      "./src/object.ts",
    "./Stopwatch":   "./src/Stopwatch.ts",
    "./tokens":      "./src/tokens.ts",
    "./hash":        "./src/hash.ts",
    "./url":         "./src/url.ts",
    "./format":      "./src/format.ts"
  }
}
```

- `exports` points directly at `.ts`. Bun resolves and executes these with **no
  build**. There is intentionally **no** `main`/`module`/`types`/`build`
  script — those are the artifacts of a compiled package and we have none.
- `private: true` — never published.
- `@gt/utils` depends only on external npm packages (`comment-json`,
  `filesize`); those resolve through the **root** `node_modules` because Bun
  workspaces hoist. No per-package dependency duplication.

### 4.2 Root `package.json`

Add one field:
```jsonc
"workspaces": ["packages/*"]
```
On `bun install`, Bun symlinks `node_modules/@gt/utils → packages/utils`, so
`import "@gt/utils/json"` resolves at runtime via the package `exports`.

### 4.3 `tsconfig.json` — alias additions

`tsgo` does not consume Bun workspace symlinks for path resolution; it needs the
alias spelled out, exactly as PR #16 did for `@genesis-tools/utils`:

```jsonc
"paths": {
  "@app/*": ["./src/*"],
  "@gt/utils/*": ["./packages/utils/src/*"],
  "@gt/utils": ["./packages/utils/src/index.ts"],   // only if a barrel is added; optional
  // … existing @ask/@ui/@ext aliases unchanged
}
```

`include` is extended to cover the new package: `["src/**/*", "packages/*/src/**/*", "./test-*.ts"]`
so whole-repo `tsgo --noEmit` type-checks the package source too.

### 4.4 The backward-compat shims (the rule that keeps the repo GREEN)

Every file moved out of `src/utils/` is replaced **in place** by a pure
re-export shim — no logic, just a re-export:

```ts
// src/utils/json.ts  (after the move)
export * from "@gt/utils/json";
```

```ts
// src/utils/format.ts
export * from "@gt/utils/format";
```

…one shim per moved file (14 shims). Because `@app/utils/json` →
`./src/utils/json.ts` → re-exports `@gt/utils/json`, **all 405 files importing
`@app/utils/json` keep compiling and running unchanged.** Same for the other 13.
The 40+ tools we do not migrate never notice the move. This is the *only* reason
a partial migration stays green.

> **`export *` star-export caveat:** if any moved module also has a
> `export default`, add an explicit `export { default } from "@gt/utils/<m>"`
> line (star-export does not re-export defaults). None of the 14 leaves use a
> default export today (verified: they are all named exports), but the plan
> calls this out per-file so a future addition can't silently break a shim.

### 4.5 Intra-package imports must NOT route through `@app/*`

Inside `packages/utils/src/`, cross-module imports are rewritten to **relative**
paths, never `@app/*`:

- `format.ts` imported `@app/utils/Stopwatch` → becomes `import … from "./Stopwatch"`.
- `json-schema.ts` imported `@app/utils/json` → becomes `import … from "./json"`.

If they kept `@app/utils/Stopwatch`, the package would depend on the `src/`
shim, which re-exports back into the package — a dependency inversion plus a
runtime round-trip through the app tree. The package **source** must be
self-contained. (Shims live ONLY at the old `src/` paths, for unmigrated tools
— never inside the package.)

**One allowed exception, in test files only:** the moved `string.test.ts` and
`paths.test.ts` import `@app/utils/test/skip` (a test-only helper that is itself
a clean leaf — zero `@app/*` and zero external deps). This back-edge is kept by
exception: it resolves at runtime (Bun honors the `@app/*` alias from inside
`packages/`) and at typecheck (tsconfig `paths`), so it does not break green and
does not affect the package's *source* self-containment. If full purity is later
wanted, `test/skip.ts` can be moved to `@gt/utils/test/skip` trivially — not
required for the milestone.

### 4.6 `./tools` entry point + discovery — unchanged

`./tools` scans `src/` and spawns with root-relative preloads. Nothing about
that changes: the 14 files are still present at their `src/utils/` paths (as
shims), tools still live in `src/`, the preload paths
(`src/utils/bun/preload-solid-scoped.ts`,
`src/utils/search/stores/sqlite-vec-preload.ts`) are untouched. Tool discovery
never looked at `packages/`. **Zero change to `./tools`.**

### 4.7 Migrated tools consume `@gt/*` directly

The ~6 migrated tools swap their leaf imports from `@app/utils/<m>` to
`@gt/utils/<m>`:

```ts
// before:  import { SafeJSON } from "@app/utils/json";
// after:   import { SafeJSON } from "@gt/utils/json";
```

This is what proves, at runtime, that "Bun resolves a workspace package's `.ts`
via `exports`, no build" actually works — the smoke-run executes these tools.

---

## 5. How the workflows work after migration

| Workflow | Command | Behavior |
|---|---|---|
| Install | `bun install` | Hoists deps to root `node_modules`; symlinks `@gt/utils`. (Same pre-existing puppeteer postinstall wart; ignore.) |
| Run a tool | `./tools <name> …` | Identical. Discovery + preloads unchanged. Migrated tools resolve `@gt/utils/*` via the workspace symlink. |
| Typecheck | `tsgo --noEmit` | Whole repo, including `packages/utils/src` (via extended `include` + `paths` alias). Bar = ZERO errors. |
| Lint/format | `biome check .` / `bunx @biomejs/biome check .` | Whole tree from root, no change. The 4 grit plugins + `SafeJSON` rule still apply to package source. |
| Logging guard | `bash scripts/ci/logging-guard.sh` | Must still pass. `@gt/utils` contains NO logger code, so it cannot trip the guard. (Confirms the leaves-first choice avoids the guard's blast radius entirely.) |
| Tests | `bun test` | Colocated `*.test.ts` move with their source into `packages/utils/src`; `bun test` from root still discovers them. The root `test` script's path-ignore patterns are unaffected (they ignore dashboards/Internal/shops, not `packages/`). |

---

## 6. CI implications

- **Minimal.** Existing CI runs `tsgo --noEmit`, `biome check`, `logging-guard.sh`,
  `bun test` from root — all already whole-tree. Add `packages/*/src` to the
  tsconfig `include` and they cover the package automatically.
- No new build job (there is no build).
- No publish job (`private: true`).
- Optional hardening (cheap, recommended): a CI assertion that
  `tsgo --noEmit 2>&1 | grep -c "error TS"` equals the **recorded master
  baseline of 0**, so any future regression is a hard failure rather than a
  silent drift.
- Recommended guardrail test: a tiny smoke test that runs one migrated tool
  (e.g. `./tools npm-package-diff --help`) and asserts exit 0 — this is the only
  thing that catches a broken `exports`/symlink that tsgo would not.

---

## 7. Designed-for-later phases (NOT in the foundation milestone)

These are documented as the cutover/expansion roadmap; each is its own PR.

- **Phase 2 — `@gt/core` (the cyclic cluster), moved atomically.** Move
  `logger`, `logger/*`, `utils/cli/*`, `utils/storage/*`, `utils/readme`,
  `utils/logging/tool-policy`, and the `utils/prompts/*` tree into one package
  in a single commit, rewriting all intra-cluster imports to relative, leaving
  `src/` shims behind. **Blocker to resolve first:** the
  `prompts/p/opentui-backend.ts → @app/doctor/ui/tui/stores/prompt-store` value
  edge — invert it (move the prompt-store contract into the package, or make the
  backend lazy-load the tool store) so `@gt/core` does not import a tool. Also
  update `scripts/ci/logging-guard.sh` and `src/logger/client-isolation.test.ts`
  to recognize the new `@gt/core/logger` path; this is the highest-risk phase
  precisely because of the logging guard.
- **Phase 3 — cutover (delete the shims).** Codemod every `@app/utils/<moved>`
  and `@app/logger` importer to the `@gt/*` path, then delete the 14 + cluster
  shims. This is a large mechanical diff (e.g. 405 `@app/utils/json` sites) and
  is explicitly OUT of foundation scope. It is value-neutral for runtime; it
  only removes the shim indirection. Can be staged per-tool.
- **Phase 4 (optional) — domain packages.** If desired later, fold
  `utils/search`, `utils/macos`, `utils/git`, `utils/ai`, etc. into
  domain-scoped `@gt/*` packages once `@gt/core` exists to depend on. Not
  obviously worth it for a no-build repo — left as a judgment call.

---

## 8. Trade-offs vs the other two frames

**vs Approach 2 (per-package tsconfigs / project references, more isolation):**
- We do NOT add per-package `tsconfig.json` with `references`/`composite`.
  Pro: zero new config, whole-repo `tsgo` stays the single source of truth,
  trivial review. Con: the package does not typecheck in *isolation* (a tool
  could import a `@gt/utils` symbol that only exists because the root tsconfig
  pulls in `@app/*` types) — but for a closed leaf set with no `@app/*` deps,
  isolation buys little. If isolation is later wanted, a `packages/utils/tsconfig.json`
  can be added non-destructively; the shim + whole-repo-green rule is unchanged.

**vs Approach 3 (full build-graph / Turbo/Nx, maximal structure):**
- We reject task-graph orchestrators and any `dist/` build. Pro: preserves the
  no-build inner loop, no cache config, no DAG to maintain, fastest possible
  adoption, smallest diff (one `workspaces` field + one package dir + 14 shims
  + ~6 migrated tools). Con: no incremental-build caching (irrelevant — there is
  no build), no enforced package-boundary graph (we rely on the import-closure
  discipline + the cyclic-cluster deferral instead of a tool enforcing it).
- Approach 3's value (cache, boundary enforcement, parallel builds) is real for
  large *compiled* monorepos; this repo is neither compiled nor large enough for
  those to pay back their complexity. Choosing it here would trade the repo's
  signature property (no build) for machinery it doesn't need.

**Net:** Approach 1 makes the *minimum* structural change that (a) gives a real,
reusable workspace package, (b) keeps every one of the 1867 `@app/*` import
sites compiling untouched via shims, (c) preserves no-build, and (d) is
reviewable in an afternoon. It explicitly does NOT attempt the hard cyclic
cluster — that entanglement is the documented reason the bold move is deferred,
not attempted-and-reverted.
