# GenesisTools Monorepo — Migration Plan (Turborepo + Bun workspaces)

> Worktree: `/Users/Martin/Tresors/Projects/GenesisTools-monorepo-2`, branch `feat/monorepo-2`.
> Work EXCLUSIVELY here. Frame: build-pipeline (see `MONOREPO-SPEC.md`).
> **Green bar (non-negotiable):** whole-repo `tsgo --noEmit` reports **0 errors** (master baseline = 0, measured), `bun install` populates `node_modules`, and `./tools` + the migrated tools run.

## Baseline (measured, do this first on any fresh checkout)

```bash
git -C /Users/Martin/Tresors/Projects/GenesisTools-monorepo-2 stash list   # ensure clean
PUPPETEER_SKIP_DOWNLOAD=1 bun install                                      # populate node_modules
tsgo --noEmit 2>&1 | rg -c "error TS" || echo "0 errors (baseline)"        # MUST be 0
```

- Master baseline = **0 tsgo errors** (empty log). "Zero new errors" therefore means "still 0."
- `bun install` exits non-zero ONLY due to the puppeteer browser-download postinstall (a network step, not a dep-tree failure). **Success criterion = `node_modules` populated + tsgo 0**, not install exit code. Always pass `PUPPETEER_SKIP_DOWNLOAD=1` so the milestone's pass signal is clean.

---

## FOUNDATION MILESTONE — leaves the repo GREEN now

Goal: stand up Bun workspaces + Turborepo, extract the acyclic **`@gt/core`** leaf spine, shim every old path, and migrate a representative set of **6 tools** that actually exercise the extracted utilities. Keep whole-repo tsgo at 0 and smoke-run the tools.

### Step 0 — Proof spike (DONE, committed)

Already executed and verified in this worktree (this is what de-risks the whole plan):
- `packages/core/` created; `src/utils/math.ts` + `math.test.ts` moved to `packages/core/src/`.
- `packages/core/package.json` with `exports` map (`bun`/`types` → `src/math.ts`, `default` → `dist`).
- Root `package.json` gained `"workspaces": ["packages/*"]`.
- `src/utils/math.ts` rewritten as the shim: `export * from "@gt/core/math";`.
- One real importer migrated: `src/utils/search/stores/vector-store.ts` now imports `@gt/core/math`.
- **Verified:** `bun install` symlinks `@gt/core`; whole-repo `tsgo` = 0 errors; `bun -e` resolves both `@gt/core/math` and `@app/utils/math`; `./tools json` + `./tools collect-files-for-ai --help` run; `bun test packages/core/src/math.test.ts` = 5 pass.

### Step 1 — Pin turbo + add `turbo.json`

```bash
PUPPETEER_SKIP_DOWNLOAD=1 bun add -D -E turbo@2.7.3   # pin (global-only warns; CI needs reproducible)
```

Write root `turbo.json`:
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
Add `.turbo/` to `.gitignore`. Add root scripts: `"turbo:typecheck": "turbo run typecheck"`, etc. (keep existing whole-repo `tsgo`/`lint`/`test` scripts as the green gate).

### Step 2 — Complete `@gt/core` (extract the rest of the acyclic leaf set)

For EACH of `json`, `date`, `format`, `string`, `paths`, `Stopwatch`, `array`, `object` (math already done):

1. `git mv src/utils/<f>.ts packages/core/src/<f>.ts` (and its `<f>.test.ts` if present).
2. Add a subpath to `packages/core/package.json` `exports`:
   ```jsonc
   "./<f>": { "bun": "./src/<f>.ts", "types": "./src/<f>.ts", "default": "./dist/<f>.js" }
   ```
3. Write the shim at the old path — **re-export only, no logic**:
   ```ts
   // src/utils/<f>.ts
   export * from "@gt/core/<f>";
   ```
   - Edge case `format.ts → @app/utils/Stopwatch`: inside `packages/core` change that import to the sibling `@gt/core/Stopwatch` (intra-package). Both members are in `@gt/core`, so still acyclic.
   - Edge case `json.ts`: depends on external `comment-json` — add `comment-json` to `packages/core/package.json` `dependencies` (workspace inherits the root install; declaring it keeps the package honest for isolated build).
   - Edge case `src/utils.ts` barrel (`tildeifyPath`, `normalizeFilePaths`, re-exports `expandTilde as resolvePathWithTilde` from `@app/utils/paths`): leave it in `src/` for now; after `paths` moves, its internal `@app/utils/paths`/`@app/utils/json` imports still resolve via shims. Do NOT move the barrel in foundation.
4. After EACH file: `tsgo --noEmit 2>&1 | rg -c "error TS"` must stay 0. Stop and fix before the next file (one-file-at-a-time keeps the blast radius tiny).

Then `PUPPETEER_SKIP_DOWNLOAD=1 bun install` (re-link) and run the full `@gt/core` test set: `bun test packages/core/`.

### Step 3 — Add `@gt/core` isolated typecheck (proves the caching premise)

Add `packages/core/tsconfig.json` (extends root compilerOptions, no `@app/*` paths — it must typecheck with ONLY its own deps):
```jsonc
{
  "extends": "../../tsconfig.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src/**/*"]
}
```
Add `"scripts": { "typecheck": "tsgo -p tsconfig.json --noEmit", "build": "tsup src/*.ts --format esm --dts --out-dir dist" }` to `packages/core/package.json` (tsup only for the additive `dist`; add `tsup` to that package's devDeps).
Verify: `turbo run typecheck --filter=@gt/core` → green AND cache-hits on a second run. This is the only step that proves isolation actually works for `@gt/core`.

### Step 4 — Migrate the representative tool SET (6 tools that exercise `@gt/core`)

Chosen because they collectively hit `json`, `format`, `paths`, `string`, `date`, `Stopwatch` — the extracted surface — across different domains (CLI-only, TUI-free, DB-touching, MCP-free, AI-free), so a green run is meaningful:

| Tool | Exercises | Migration |
|---|---|---|
| `json` (`src/json/index.ts`) | `SafeJSON` (`@app/utils/json`) | already smoke-verified; switch its `@app/utils/json` → `@gt/core/json` |
| `files-to-prompt` (`src/files-to-prompt/index.ts`) | `formatBytes` (`@app/utils/format`) | `@app/utils/format` → `@gt/core/format` |
| `collect-files-for-ai` (`src/collect-files-for-ai/index.ts`) | paths/format glue | switch the `@app/utils/format`/`paths` imports it uses → `@gt/core/*` |
| `npm-package-diff` (`src/npm-package-diff/index.ts`) | `SafeJSON`, `resolvePathWithTilde` | `@app/utils/json` → `@gt/core/json` (keep `@app/utils` barrel import as-is — barrel not moved) |
| `git-last-commits-diff` (`src/git-last-commits-diff/index.ts`) | date/format/string | switch its `@app/utils/format`/`date`/`string` imports → `@gt/core/*` |
| `timer` (`src/timer*`) or `t3chat-length` | `format`/`Stopwatch`/`string` | switch matching imports → `@gt/core/*` |

For each tool: change only the import specifiers for already-extracted modules from `@app/utils/<f>` → `@gt/core/<f>`. **Leave every other `@app/*` import untouched** (logger, cli, prompts — those are NOT extracted; they resolve via the unchanged `@app/*` alias). The shims mean a tool can mix `@gt/core/format` and `@app/utils/cli` freely.

> Note: tools may keep importing `@app/utils/<f>` (the shim) and still be green. Migrating 6 to the *direct* `@gt/core/*` path is to **prove the consumer side works**, not because the shim is insufficient.

### Step 5 — Foundation green verification (the milestone gate)

```bash
PUPPETEER_SKIP_DOWNLOAD=1 bun install
tsgo --noEmit 2>&1 | rg -c "error TS" || echo "0 — GREEN"          # MUST be 0
turbo run typecheck --filter=@gt/core                              # isolated pkg green + cacheable
bun test packages/core/                                            # package tests pass
# Smoke each migrated tool:
echo '{"a":1}' | ./tools json
./tools files-to-prompt --help
./tools collect-files-for-ai --help
./tools npm-package-diff --help
./tools git-last-commits-diff --help
biome check . 2>&1 | tail -3                                        # no new lint
```
All green ⇒ foundation milestone done. Commit.

---

## FOLLOW-UP PHASES (out of foundation scope; each its own PR)

### Phase A — Break the `cli ↔ logger ↔ prompts` cycle, extract `@gt/logger` + `@gt/cli`
- **Blocker to clear first:** `src/utils/prompts/*` imports `@app/doctor/ui/tui/stores/prompt-store` — a package importing a TOOL. This makes isolated typecheck impossible and would let `turbo run typecheck` fail silently while whole-repo tsgo is green. Invert it: move the prompt-store contract into `@gt/cli`, or inject it via an interface owned by the package.
- Also relocate `async.ts` (→`@gt/logger`, since it imports `@app/logger`) — keep it OUT of `@gt/core`.
- Because `out→cli`, `cli→logger`, `logger/out→cli` are mutually recursive, ship `@gt/logger`+`@gt/cli` as **one package** (or co-resident) until the cycle is severed.
- Respect `src/logger/client-isolation.test.ts` (browser client must never value-import the node logger) — the extraction must keep that test green.

### Phase B — Extract `@gt/storage`, `@gt/ui`, `@gt/ai`
- `@gt/storage`: `utils/storage/*` + `database/migrations` (depends on `@gt/core`, `@gt/logger`).
- `@gt/ui`: `utils/ui/*` (the `@ui/*` 666-import surface); unblocks dashboard sub-projects' own per-package typecheck.
- `@gt/ai`: `utils/ai/*`.
- Each follows the Step 2/3 recipe (move → exports subpath → shim → isolated tsconfig → verify whole-repo 0).

### Phase C — Cutover (delete shims, codemod importers)
- Once enough tools import `@gt/*` directly, codemod remaining `@app/utils/<extracted>` → `@gt/core/<f>` repo-wide (ts-morph or biome), then **delete the re-export shims**.
- **Explicitly NOT foundation** — the shims are precisely what keep the partial migration green; removing them is a mechanical, separate, repo-wide pass with its own whole-repo tsgo gate.

### Phase D — (optional) Promote hot tool clusters to `apps/*` packages
- `shops` (914 inbound), `youtube` (292), `azure-devops` (176) → their own `package.json`+`exports`+`tsconfig` for isolated typecheck + turbo cache. Pure scaling; do only if CI on those clusters becomes a bottleneck.

### Phase E — CI wiring + remote cache
- Add CI jobs: one whole-repo `tsgo --noEmit` correctness gate + `turbo run typecheck lint test` for cached fast feedback. `PUPPETEER_SKIP_DOWNLOAD=1` on install. Enable turbo remote cache (self-hosted or Vercel) so green artifacts are shared across CI + devs.

---

## Rollback / safety

- Every extraction is `git mv` + shim; reverting a single file = restore from `git` and delete the shim. No destructive deletes.
- The whole-repo `tsgo` 0-error gate after **each file** (Step 2) bounds any regression to one move.
- Never narrow tsgo to a single package to claim green — the bar is whole-repo, by design.
- Use `git stash push -m "<desc>" -- <files>` (never `git checkout --`) to park in-progress extraction work.
