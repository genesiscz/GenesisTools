# GenesisTools Monorepo — Target Architecture (Approach 3: Domain-Driven, Enforced Boundaries)

> **Frame:** aggressive domain-driven package split with *enforced* dependency
> direction. Tools become thin entrypoints over a layered stack of domain
> packages. Optimize for clean architecture, clear ownership, testability,
> long-term maintainability — at the cost of more upfront restructuring than a
> flat or single-shared-package approach.

This document is the **target** state. The companion `MONOREPO-PLAN.md` defines
the **foundation milestone** (achievable now, repo stays green) plus scoped
follow-up phases that walk us from foundation to this target.

---

## 0. Empirical findings that shape every decision

All of the following were measured in this worktree (`feat/monorepo-3`) before
any design was committed. They are the load-bearing facts.

### 0.1 The repo is large and flat
- **76 tool directories** + standalone tool files under `src/`, discovered by
  `./tools` scanning `src/` for `index.ts`/`index.tsx` (dir tools) or bare
  `*.ts`/`*.tsx` (file tools). Tool name = dir/file basename.
- **~44 distinct `src/utils/*` domains** (`json`, `ui`, `cli`, `ai`, `prompts`,
  `macos`, `format`, `storage`, `claude`, `github`, `database`, `search`,
  `audio`, `cmux`, `tmux`, `log-viewer`, `obsidian`, …).

### 0.2 Aliases resolve via tsconfig `paths` + Bun's native tsconfig support
`tsconfig.json#compilerOptions.paths` maps `@app/* → ./src/*` (plus `@ask/*`,
`@ui/*`, `@ext/*`, `@app/yt/*`). `moduleResolution: "bundler"`,
`allowImportingTsExtensions: true` (some imports carry explicit `.ts`, e.g.
`@app/utils/ai/index.ts`). There is **no** `bunfig` import-map and **no**
package.json `imports` field — Bun reads `tsconfig.json#paths` directly. This is
why a workspace package's `exports` map can point straight at `.ts` (see §0.6).

### 0.3 The dependency graph is real, and so are its violations
Import-direction reality (measured with `rg -oN "@app/..."`):

- **Tools → utils is the dominant edge** (1124 `@app/utils/*` import sites; 561
  `@app/logger` import sites). This is the direction the architecture wants.
- **BUT `src/utils/*` imports *back* from 10 tool dirs — 48 import sites.**
  These are genuine boundary violations today:
  - `src/utils/log-viewer/*` → `@app/task/lib/*` and `@app/debugging-master/core/*`
  - `src/utils/ui/components/youtube/*` → `@app/youtube/*`
  - `src/utils/cmux/*` → `@app/cmux/*`
  - `src/utils/github/*` → `@app/github/*`
  - `src/utils/notifications/channels/telegram.ts` → `@app/telegram-bot/*`
  - `src/utils/ai/tasks/Transcriber.ts` → `@app/...`, etc.
- **Cross-domain cycle inside utils:** `src/utils/ai` imports `src/utils/macos`
  (5 files: `LanguageDetector`, `AIDarwinKitProvider`, `AICoreMLProvider`,
  `AIMacOSTextToSpeechProvider`, `Translator`) **and** `src/utils/macos/tts.ts`
  imports `src/utils/ai`. Naively splitting `@gt/ai` and `@gt/macos` into
  separate packages would be **circular**.

> **This is the spine of the domain-driven argument.** A flat repo lets these
> violations rot silently. The aggressive split's entire value proposition is to
> *surface* them (they become package-boundary errors), *decide* how to break
> each cycle on purpose, and then *gate* them in CI so they cannot reappear. The
> foundation does **not** attempt to fix them; it extracts only the genuinely
> clean leaf and documents every tangle as a scoped phase.

### 0.4 The logger is NOT a pure leaf
`src/logger.ts` depends only on `@app/utils/date` + `@app/utils/json` (clean),
**but** `src/logger/out.ts` depends on `@app/utils/cli/{result,stdout,stderr,
output-mode,quiet-spinner}` **and** `@app/utils/prompts/p`. So `@gt/logger`
transitively couples to `@gt/cli-core`. The logger therefore sits *above*
cli-core in the layer stack — it is not the foundation's safe extraction.

### 0.5 The genuinely-clean leaf set (foundation target)
Import-closure verified per file (`rg -oN "@app/..."` on each):

| file | external `@app` deps | verdict |
|---|---|---|
| `json.ts` | none | clean |
| `date.ts` | none | clean |
| `string.ts` | none | clean |
| `array.ts` | none | clean |
| `object.ts` | none | clean |
| `math.ts` | none | clean |
| `hash.ts` | none | clean |
| `tokens.ts` | none | clean |
| `Stopwatch.ts` | none | clean |
| `format.ts` | `@app/utils/Stopwatch` (also clean) | clean (set-closed) |
| `async.ts` | **`@app/logger`** (1 call, `logger.error`) | **EXCLUDE** from foundation |

`async.ts` is the only impurity: it touches the logger for a single error log.
Pulling it into a leaf package would drag the (non-leaf) logger in. It stays in
`src/utils/` for the foundation and joins `@gt/core` only after `@gt/logger`
exists (so the dependency points up the stack, not into a cycle).

### 0.6 No-build is proven, not assumed (the make-or-break spike)
A throwaway workspace package `@gt/_spike` with
`"exports": { "./hello": "./src/hello.ts" }` (pointing at raw `.ts`) was created,
`bun install` linked it (`node_modules/@gt/_spike → packages/_spike`), and then:

- **Runtime:** `bun run` of an in-repo consumer importing `@gt/_spike/hello`
  printed `hello monorepo-3` — Bun resolves package `exports → .ts` with **no
  build step**.
- **Typecheck:** **whole-repo `tsgo --noEmit` reported 0 errors** with the spike
  consumer included — and it resolved `@gt/_spike/hello` **purely via the
  workspace symlink + package.json `exports`**, *without* any tsconfig `paths`
  entry (verified by deleting the path and re-running). `moduleResolution:
  "bundler"` follows `exports`.

The spike was fully reverted; the repo is pristine. **Conclusion: a Bun
workspace whose packages expose `.ts` via `exports` typechecks and runs with
zero build step — the foundational premise holds.**

### 0.7 Master tsgo baseline = ZERO errors
On a clean checkout, `tsgo --noEmit 2>&1 | rg -c "error TS"` = **0**.
**Therefore "zero NEW errors" means the whole-repo typecheck must stay at 0.**
There is no slack. Every shim must be a pure re-export; every moved file must
preserve its public surface exactly.

---

## 1. Tooling choice

### 1.1 Decision: **Bun workspaces, no build step, `exports`-to-`.ts`**
- `package.json#workspaces: ["packages/*"]` (Bun native; symlinks each package
  into `node_modules/@gt/<name>`).
- Each package ships `package.json` with `"type": "module"` and an `exports`
  map whose targets are **raw `.ts`** files — no `dist/`, no `tsup`, no compile.
- Consumers import by package name (`@gt/core/format`), resolved via the
  workspace symlink + `exports` (proven in §0.6). The existing `@app/*` alias is
  untouched and keeps serving the 70+ unmigrated tools through shims.
- **Belt-and-suspenders (recommended, low-cost):** also add
  `"@gt/*": ["./packages/*/src"]` to tsconfig `paths`. The spike proved this is
  *not required* for tsgo, but it (a) makes resolution deterministic across any
  future TS/editor that doesn't follow `exports`, and (b) matches the repo's
  existing `@app/*` idiom. If a package later adds non-root subpaths this path
  shape may need refinement; the `exports` map is the source of truth.

### 1.2 Why NOT the prior art's approach (PR #16 / `origin/feat/monorepo`)
The closed PR #16 created `packages/utils` and is the explicit anti-pattern:

1. **It introduced a build step** (`tsup`, `dist/`, `dts: true`). That breaks the
   repo's defining property — "Bun executes TypeScript directly without
   compilation." Every tool run would need a stale-aware rebuild. **Rejected.**
2. **It re-implemented utilities** (`createLogger`, `formatCost`, `Storage`,
   `withRetry`) as *new* code in `packages/utils/src/core/*` — divergent from the
   battle-tested `src/utils/*` originals (e.g. the real logger is a 300-line
   pino facade with the out/logger split; PR #16's `core/logger.ts` was a
   simplified rewrite). A second source of truth guarantees drift. **Rejected.**
3. **It had no backward-compat shims.** The other 70+ tools still imported
   `@app/utils/*`; nothing kept them green. It was rip-and-replace, which is why
   it stalled and was closed as obsolete. **Rejected.**

This spec inverts all three: **move the real code** (git-mv, not rewrite),
**leave a re-export shim** at every old `@app/*` path, and **never add a build
step**.

### 1.3 Why NOT tsconfig project references as the primary mechanism
Project references (`composite: true` + `tsc -b`) give isolated per-package
typechecking, but: (a) they imply emit/`.tsbuildinfo` artifacts that fight the
no-build model, (b) `tsgo` (the native preview compiler this repo uses instead
of `tsc`) has incomplete `-b`/composite support, and (c) the repo's existing
`typecheck:all` already shells a second `tsgo -p` for the dashboard — we keep
that pattern, not a build graph. **Per-package `tsconfig.json` (extends root,
narrows `include`) is offered as an *optional* isolation aid** so a package can
be typechecked alone during development, but **whole-repo `tsgo --noEmit`
remains the authoritative green gate.** Project refs are documented as the
heavier alternative, not adopted.

### 1.4 Boundary enforcement: a CI guard script, idiomatic to this repo
This repo already enforces conventions with bespoke CI scripts
(`scripts/ci/logging-guard.sh`, `scripts/check-ui-palette.ts`). Boundary
enforcement follows the same idiom: **`scripts/ci/check-package-boundaries.ts`**
(a Bun script) that:
- parses every import in `packages/**` and `src/**`;
- **fails** if a `packages/<A>` file imports `@gt/<B>` where `B` is *higher* in
  the layer order than `A` (back-edge), or imports `@app/<tool>/*` at all
  (a package must never depend on a tool);
- **fails** if a *tool* (`src/<tool>`) imports another tool's internals
  (`@app/<otherTool>/*`) — tools may depend only on `@gt/*` packages and their
  own subtree;
- **warns** (foundation) → **fails** (later phases) on the known §0.3 violations,
  tightening as each is fixed.

Biome has **no** real cross-module import-boundary rule, so we do **not** promise
one. The guard script is the on-brand, deterministic mechanism and it passes
green at the foundation precisely because `@gt/core` is import-closed.

---

## 2. Package list, responsibilities, and the dependency graph

### 2.1 Layered package catalog (target state)

Layers are strict: a package may depend only on packages **below** it (lower
layer number) plus third-party `node_modules`. The CI guard enforces this.

**Layer 0 — pure computation (zero `@app` deps, zero side effects):**
- **`@gt/core`** — `json` (SafeJSON), `date`, `format`, `string`, `array`,
  `object`, `math`, `hash`, `tokens`, `Stopwatch`, `fuzzy-match`, `fuzzy-tokens`,
  `url`, `sql-time`. Pure functions + small value types. The single safe
  foundation extraction (minus the items that need logger — those land here once
  Layer 1 exists). *Owner: platform/core.*

**Layer 1 — process & IO primitives (depend on core only):**
- **`@gt/logger`** — the pino facade (`logger`), the `out`/result channel, the
  scoped logger, `logger/client`. Depends on `@gt/core` and `@gt/cli-core`
  (see §0.4 — `out.ts` needs cli's stdout/stderr/result + prompts). Within
  Layer 1, logger sits *above* cli-core (one-directional).
- **`@gt/cli-core`** — `commander` bootstrap (`runTool`, `enhanceHelp`),
  `Executor`, `isInteractive`/`suggestCommand`, `output-mode`, `stdout`/`stderr`
  writers, `variadic`, `quiet-spinner`. Depends on `@gt/core` only.
- **`@gt/prompts`** — `@app/utils/prompts/p` facade + clack/inquirer backends.
  Depends on `@gt/core`, `@gt/cli-core`.
- **`@gt/storage`** — `src/utils/storage/*` (per-tool config/cache dirs under
  `~/.genesis-tools/<tool>/`). Depends on `@gt/core`.
- **`@gt/fs`** — `src/utils/fs/*` (disk-usage, watcher, path helpers), `paths`.
  Depends on `@gt/core`.
- **`@gt/process`** — `src/utils/process/*`, `process-alive`, `shell`,
  `terminal`. Depends on `@gt/core`.

> *Layer-1 internal ordering (to enforce — partially unverified):* `cli-core` →
> (nothing in L1); `logger` → `cli-core` + `prompts` (proven: `logger/out.ts`
> imports `prompts/p` + `cli/*`). **Caveat (measured):** `prompts/*` imports
> `@app/logger` back in 3 clack-helper files (`multiline.ts`,
> `settings-summary.ts`, `trash-staging.ts`) — note the `p` facade itself is
> guarded clean by `prompts/p/no-logger-import.test.ts`, but the broader clack
> layer is not. So `@gt/logger ↔ @gt/prompts` is a **cycle to break** in Phase L1
> (route those helpers' logging through an injected logger / `@gt/core`-level
> contract, or co-locate logger+prompts+cli-core into one L1 package). Do **not**
> assume a clean `logger → prompts` edge; verify `prompts ↛ logger` and break it
> if present. This does not affect the foundation (`@gt/core` is clean and
> proven); it is L1-phase work.

**Layer 2 — cross-cutting infrastructure (depend on L0–L1):**
- **`@gt/database`** — `src/utils/database/*` (migrations, `Migrator`, base
  accessor), `src/utils/macos/MacDatabase` base. Depends on `@gt/core`,
  `@gt/storage`, `@gt/logger`.
- **`@gt/net`** — `src/utils/net`, `api`, `network`, `curl`, `browser` (HTTP/
  fetch/ofetch helpers, ApiClient). Depends on `@gt/core`, `@gt/logger`.
- **`@gt/search`** — `src/utils/search/*` (orama, qdrant/sqlite-vec stores,
  embeddings glue). Depends on `@gt/core`, `@gt/storage`, `@gt/logger`,
  `@gt/database`.

**Layer 3 — product domains (depend on L0–L2; this is where cycles get broken):**
- **`@gt/ai`** — `src/utils/ai/*` (AI SDK wrappers, `AIConfig`, `ModelManager`,
  providers, tasks: Embedder/Translator/Synthesizer/Transcriber). **Cycle break
  with macos:** `@gt/ai` defines provider *interfaces* (`SpeechProvider`,
  `NlpProvider`, `ClassifierProvider`) in `@gt/ai/contracts`; the macOS-backed
  implementations move to `@gt/macos`, which depends on `@gt/ai` (one
  direction). `@gt/ai` never imports `@gt/macos`. (Alternative considered:
  merge ai+macos into one package — rejected; macOS-only code must not load on
  Linux CI, and the interface inversion is the cleaner ownership boundary.)
- **`@gt/macos`** — `src/utils/macos/*` (darwinkit, MailDatabase, calendar,
  nlp, classification, tts, notifications, apfs). Depends on `@gt/core`,
  `@gt/logger`, `@gt/database`, `@gt/ai` (implements `@gt/ai/contracts`).
- **`@gt/github`** — `src/utils/github/*` (octokit, url-parser). Depends on
  `@gt/core`, `@gt/logger`, `@gt/net`. **Violation to fix:** `url-parser`/
  `utils` currently reach into `@app/github/*` — those tool-side helpers move
  *down* into `@gt/github` (they were mis-located) so the edge points the right
  way.
- **`@gt/claude`** — `src/utils/claude/*` (session/message types aligned with
  `@anthropic-ai/claude-agent-sdk`, projects, runtime-context). Depends on
  `@gt/core`, `@gt/logger`.
- **`@gt/agents`** — `src/utils/agents/*` + `agent-runtime`. Depends on
  `@gt/core`, `@gt/logger`, `@gt/claude`.
- **`@gt/markdown`** — `src/utils/markdown/*` (markdown-it/marked pipeline).
  Depends on `@gt/core`.
- **`@gt/audio`** — `src/utils/audio/*` (converter, detect-format). Depends on
  `@gt/core`, `@gt/logger`.
- **`@gt/notifications`** — `src/utils/notifications/*`. **Violation to fix:**
  `channels/telegram.ts` → `@app/telegram-bot`; invert via a `NotifierChannel`
  interface so the telegram *tool* registers its channel (tool → package),
  not the reverse.

**Layer 4 — terminal/UI domains (heavy, optional, often excluded from tsgo):**
- **`@gt/ui`** — `src/utils/ui/*` shared React/design-system primitives
  (`@ui/*`, `wow-components`). Depends on `@gt/core`. **Violation to fix:**
  `ui/components/youtube/*` (8 files) → `@app/youtube`; these are *youtube
  feature* components mis-placed in shared UI — they move into the youtube tool
  (or a `@gt/youtube-ui` feature package), reversing the edge.
- **`@gt/tui`** — `src/utils/{ink,opentui,terminal,ansi,log-viewer}` (Ink/
  OpenTUI/log-viewer). **Major violation cluster:** `log-viewer/*` → `@app/task`
  + `@app/debugging-master`. Resolution: extract the *log-source contract*
  (`LogEntry`, `LogSource`) into `@gt/tui`; `task` and `debugging-master` tools
  *provide* their sources to the viewer (tool → package), instead of the viewer
  reaching up into two specific tools.
- **`@gt/cmux` / `@gt/tmux`** — `src/utils/{cmux,tmux}`. **Violation:**
  `utils/cmux/*` ↔ `@app/cmux`. Resolution: shared multiplexer primitives live
  in the package; cmux-tool-specific glue (workspace/layout/send) moves back into
  the `cmux` tool.

**Tools layer — `src/<tool>/` stay where they are, become thin entrypoints:**
Tools keep their `src/<tool>/index.ts` discovery contract and their own
`@app/<tool>/...` internal imports. Over the migration they swap
`@app/utils/<domain>` / `@app/logger` for `@gt/<package>` imports. End state: a
tool's `index.ts` is a thin commander wiring file plus `commands/` + `lib/`
that consume `@gt/*` packages.

### 2.2 Dependency graph (target)

```
                         tools (src/<tool>/) — thin entrypoints
                                   │  (depend on @gt/* only; never on another tool)
        ┌──────────────┬──────────┴───────────┬───────────────┬──────────────┐
   L4  @gt/ui      @gt/tui            @gt/cmux/@gt/tmux        (feature UIs)
        │              │                       │
   L3  @gt/ai ◀──── @gt/macos   @gt/github  @gt/claude ─ @gt/agents  @gt/markdown  @gt/audio  @gt/notifications
        │              │            │           │            │
   L2  @gt/database   @gt/net    @gt/search
        │              │            │
   L1  @gt/logger ──▶ @gt/cli-core ◀── @gt/prompts     @gt/storage   @gt/fs   @gt/process
                          │
   L0  ─────────────── @gt/core ───────────────────────────────────────────────
```
Arrows point in the **allowed** dependency direction (toward lower layers).
`@gt/macos → @gt/ai` is the inverted edge that breaks the ai↔macos cycle;
`@gt/logger → @gt/cli-core` is the intra-L1 edge from §0.4.

---

## 3. How the existing mechanics map into the new layout

### 3.1 `./tools` entrypoint & tool discovery — **unchanged**
`./tools` still scans `src/` for `index.ts`/`index.tsx` dirs and bare
`*.ts`/`*.tsx` files. Tools remain in `src/<tool>/`, so discovery, the fuzzy
"did you mean?" matcher, and the `bun run <targetScript>` exec model are
untouched. **Critical:** the hardcoded preload paths in `./tools`
(`src/utils/bun/preload-solid-scoped.ts`, `src/utils/search/stores/
sqlite-vec-preload.ts`) and the identical list in `bunfig.toml` must keep
resolving. **Foundation rule: do not move those preload files** (`@gt/core`
extraction never touches `bun/` or `search/`); when `@gt/search` is later
extracted, both `./tools` and `bunfig.toml` preload paths are updated in the
same commit (it's a runtime path, invisible to tsgo — easy to miss).

### 3.2 `@app/*` aliases — **kept forever via shims**
`@app/* → ./src/*` stays in tsconfig. Every file moved out of `src/` into a
`@gt/*` package leaves a **pure re-export shim** at its old path:

```ts
// src/utils/format.ts  (after move — the ENTIRE file)
export * from "@gt/core/format";
```

For default/named-export modules the shim mirrors exactly (`export * from …`;
add `export { default } from …` only if the original had a default). The 1124
`@app/utils/*` + 561 `@app/logger` import sites in unmigrated tools keep
compiling and running **unchanged** — this is the *only* reason a partial
migration stays green. Shims are deleted only in the final cutover phase
(§5, out of foundation scope).

### 3.3 `bun install`
`bun install` reads `workspaces: ["packages/*"]`, symlinks each `@gt/<pkg>`
into `node_modules/@gt/`, and hoists shared third-party deps to the root
`node_modules` (single version, no duplication — verified: the spike linked
cleanly). Tool authors run one `bun install` at the root; nothing per-package.

### 3.4 Running a tool
`tools <name> [args]` → identical path. The tool's imports resolve `@gt/*` via
the workspace symlink (`exports → .ts`) and `@app/*` via tsconfig paths/shims.
No build, no watch, no codegen. Proven end-to-end by the §0.6 spike.

### 3.5 `tsgo --noEmit`
Whole-repo `tsgo --noEmit` is the authoritative gate and **must report 0
errors** (baseline §0.7). It typechecks `src/**` *and* `packages/**` in one
pass (packages are reachable through `exports`; the optional `@gt/*` tsconfig
path makes it deterministic). The existing `typecheck:all` script (which also
runs `tsgo -p src/claude-history-dashboard/tsconfig.json`) is extended, if
desired, with per-package `tsgo -p packages/<pkg>/tsconfig.json` for isolated
checks — but those are *additive*, never a substitute for the whole-repo run.

### 3.6 Tests
`bun test` is unchanged in mechanism. Colocated `*.test.ts` move **with** their
source into the package (Bun test discovers them in `packages/**` the same way).
**Caveat:** the root `package.json#test` script uses `--path-ignore-patterns`
globs (`**/dashboard/**`, `**/task/tests/**`, …) — when a tool/util with such a
test moves, confirm the ignore globs still match the new location (they are
suffix-glob, so `**/task/tests/**` keeps matching `packages/.../task/...` only if
the segment survives; audit per move). `bunfig.toml#[test].preload` paths
(`preload-test-process-exit`, `sqlite-vec-preload`, `test-cleanup-preload`) are
runtime paths — same "keep in `src/` or update both" rule as §3.1.

---

## 4. CI implications

1. **`tsgo --noEmit` (whole repo) = 0 errors** — the green gate. Already in CI.
2. **`scripts/ci/check-package-boundaries.ts`** (new) — fails on back-edges,
   `package → @app/<tool>` imports, and tool↔tool imports. Starts in *warn* mode
   for the known §0.3 violations, flips to *fail* per-violation as each phase
   fixes it. This is the mechanism that makes "enforced boundaries" real and
   keeps the win from eroding.
3. **`scripts/ci/logging-guard.sh`** — still passes; the logger module moves to
   `@gt/logger` but the guard's checks (no default import, no `logger.*(
   SafeJSON.stringify)` result dumps, client-isolation test exists) are
   path-agnostic regex over `src/**` + `scripts/**`; extend its globs to cover
   `packages/**` so the convention is enforced inside packages too.
4. **`scripts/check-ui-palette.ts`** — extend glob to `packages/@gt/ui` when
   `@gt/ui` is extracted (Layer 4, late).
5. **`biome check .`** — unchanged; biome lints `packages/**` and `src/**`
   uniformly (one root `biome.json`).
6. **`bun test`** — unchanged; verify ignore globs after each move (§3.6).
7. **No new build job** — there is deliberately nothing to compile in CI.

---

## 5. Migration end-state vs foundation (handoff to the PLAN)

- **Foundation (now, green):** workspace config + `@gt/core` extracted with full
  shims + 4–8 representative tools migrated to consume `@gt/core` directly +
  boundary guard in warn mode. Whole-repo tsgo = 0, `./tools` + migrated tools
  run. (Details in `MONOREPO-PLAN.md`.)
- **Follow-up phases (scoped, each green):** L1 (`cli-core`/`logger`/`prompts`/
  `storage`/`fs`/`process`) → L2 (`database`/`net`/`search`) → L3 product domains
  *with their cycle-breaks* (`ai`/`macos` inversion, `github`/`notifications`
  edge fixes) → L4 UI/TUI/mux *with their violation fixes* (`log-viewer`,
  `youtube-ui`, `cmux`). Each phase: move code, leave shims, flip the relevant
  boundary-guard rule to fail.
- **Cutover (final, explicitly OUT of foundation scope):** rewrite every
  `@app/utils/*` / `@app/logger` importer to `@gt/*`, then **delete the shims**
  and (optionally) drop the `@app/*` tsconfig path. This is mechanical but
  touches ~1700 import sites — it is its own phase, gated by the boundary guard
  being fully in fail mode.

---

## 6. Trade-offs vs the other two frames

| Dimension | **(3) Domain-driven, enforced (this spec)** | (1) Minimal: one `@gt/utils` shared package | (2) Pragmatic: a few coarse packages, no enforcement |
|---|---|---|---|
| **# packages** | ~22 layered packages (target) | 1 | 3–5 |
| **Upfront cost** | Highest — must *decide and break* the ai↔macos cycle, the logger→cli coupling, and 48 reverse-deps before those layers land | Lowest — bag everything clean into one package | Low–medium |
| **Surfaces existing rot (§0.3)** | **Yes — that's the point.** Violations become hard CI errors, fixed deliberately | No — a single `@gt/utils` re-absorbs the tangle; cycles hide inside one package | Partially — coarse packages may still contain a cycle |
| **Ownership clarity** | High — each domain has a package boundary + CODEOWNERS-able dir | Low — one giant util grab-bag | Medium |
| **Testability in isolation** | High — a package + its tests run/typecheck alone | Low | Medium |
| **Risk of new tsgo errors during migration** | Higher per phase (must keep cycles broken), but bounded by phasing + shims | Lowest | Low |
| **Reversibility** | High — shims mean any phase can pause indefinitely while green | High | High |
| **Long-term maintainability** | **Best** — boundaries enforced, drift gated | Worst at scale — the grab-bag keeps growing | Middle |
| **Build step** | None (proven §0.6) | None | None |
| **Foundation footprint** | Identical to the others: `@gt/core` + shims + a few tools (the *aggressive* part is all target/phases, not foundation) | Same `@gt/core`-ish | Same |

**Honest caveat about this frame:** the aggressive split's cost is *entirely*
in the L3/L4 phases where cycles must be inverted — the foundation itself is no
bigger than the minimal approach (one clean package + shims). If the project
never funds the later phases, approach (3) degrades gracefully to approach (1)
with a boundary guard already in place. That graceful-degradation property, plus
the fact that the violations are *named and gated* rather than buried, is why
domain-driven is the recommended long-term target despite its higher ceiling
cost.
