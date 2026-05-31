# MONOREPO-PLAN — Approach 1 execution (this worktree)

**Worktree:** `/Users/Martin/Tresors/Projects/GenesisTools-monorepo-1`
**Branch:** `feat/monorepo-1` (based on `master` @ `581f71f70f9ddfb4671628f76203be3488c06683`)

Run every command with an explicit worktree path
(`cd /Users/Martin/Tresors/Projects/GenesisTools-monorepo-1 && …` or
`git -C … `). Never touch the main repo or sibling worktrees.

The FOUNDATION milestone (Steps 1–7) is fully achievable now and leaves the
repo GREEN. Steps 8+ are documented follow-up phases, not executed here.

---

## Definition of GREEN (the milestone exit gate)

All four must hold, measured exactly as written:

1. **`tsgo --noEmit`** → ZERO errors (whole repo; identical command to the
   master baseline, which was measured at 0). Verify with
   `tsgo --noEmit 2>&1 | rg -c "error TS"` → `0`.
2. **`biome check .`** → no new errors vs baseline (run it on `master` first to
   record the baseline count; the 14 moved files + shims + migrated tools must
   not add any).
3. **`bash scripts/ci/logging-guard.sh`** → passes (unchanged; `@gt/utils` has
   no logger code).
4. **Smoke-run** → each migrated tool runs: `./tools <name> --help` (or a
   trivial real invocation) exits 0, AND at least one runs a real path that hits
   an extracted function so the `@gt/*` runtime resolution is actually exercised.

---

## Step 0 — Record baselines (do FIRST, before any change)

```bash
cd /Users/Martin/Tresors/Projects/GenesisTools-monorepo-1
git rev-parse master                                   # expect 581f71f70…
bun install                                            # populates node_modules (puppeteer postinstall may fail — OK)
tsgo --noEmit 2>&1 | rg -c "error TS" || echo 0        # MASTER BASELINE → expect 0
biome check . 2>&1 | rg -c "error" || echo 0           # record biome baseline count
bash scripts/ci/logging-guard.sh && echo "guard OK"
```

Write the three numbers down in the PR description. Baseline already confirmed:
**tsgo = 0 errors**.

---

## Step 1 — Create the `@gt/utils` package skeleton

```bash
cd /Users/Martin/Tresors/Projects/GenesisTools-monorepo-1
mkdir -p packages/utils/src
```

Create `packages/utils/package.json` (NO build script, exports → `.ts`):

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

## Step 2 — Wire the workspace + tsconfig + bun install

1. Root `package.json`: add `"workspaces": ["packages/*"]`.
2. Root `tsconfig.json`:
   - add to `paths`: `"@gt/utils/*": ["./packages/utils/src/*"]`
   - extend `include` to `["src/**/*", "packages/*/src/**/*", "./test-*.ts"]`
3. `bun install` (re-resolves; symlinks `node_modules/@gt/utils → packages/utils`).

```bash
cd /Users/Martin/Tresors/Projects/GenesisTools-monorepo-1
bun install
ls -la node_modules/@gt/utils       # must be a symlink into packages/utils
```

Verify with a throwaway script that Bun resolves `.ts` via exports with no build:

```bash
echo 'import {SafeJSON} from "@gt/utils/json"; console.log(SafeJSON.stringify({ok:1}))' > /tmp/gt-probe.ts
bun /tmp/gt-probe.ts                  # expect: {"ok":1}
git add /tmp/gt-probe.ts 2>/dev/null; git rm -f /tmp/gt-probe.ts 2>/dev/null || rm -f /tmp/gt-probe.ts
```
> (Probe file is in `/tmp`, never committed.)

## Step 3 — Move the 14 leaf files (closed set) into the package

Move each file (and its colocated `*.test.ts`, if any) with `git mv` so history
is preserved:

```bash
cd /Users/Martin/Tresors/Projects/GenesisTools-monorepo-1
for f in json json-schema paths string date date-locale math array object Stopwatch tokens hash url format; do
  for ext in .ts .test.ts; do
    [ -f "src/utils/${f}${ext}" ] && git mv "src/utils/${f}${ext}" "packages/utils/src/${f}${ext}"
  done
done
git status --short
```

(`paths.client.ts`/`paths.client.test.ts` stay in `src/utils/` — they are the
browser-isolation variant; only `paths.ts` moves. Confirm before moving:
`ls src/utils/paths*`.)

## Step 4 — Rewrite intra-package imports to relative

Inside `packages/utils/src/`, replace `@app/utils/<member>` with `./<member>`:

- `format.ts`: `@app/utils/Stopwatch` → `./Stopwatch`
- `json-schema.test.ts`: `@app/utils/json` → `./json` (sibling — in-set)
- Any source/test file that imported a sibling leaf via `@app/utils/*` → relative.

**Verified test-file closure (advisor follow-up):** the moved `*.test.ts` were
scanned for `@app/*` edges. Results:
- `json-schema.test.ts` → `@app/utils/json` — a **sibling** (rewrite to `./json`).
- `string.test.ts`, `paths.test.ts` → `@app/utils/test/skip` — a **test-only
  helper** that is itself a clean leaf (`src/utils/test/skip.ts` has zero
  `@app/*` and zero external imports).

`@app/utils/test/skip` is the ONE allowed back-edge, by exception: it is
test-only, resolves at runtime (Bun honors the `@app/*` alias even from inside
`packages/`) and at typecheck (tsconfig `paths`), so it does NOT break green.
The package's **source** stays fully self-contained; only two test files keep a
test-only alias import. (If full purity is later wanted, `test/skip.ts` is a
clean leaf and can be moved to `@gt/utils/test/skip` in a trivial follow-up —
not required for the milestone.)

```bash
cd /Users/Martin/Tresors/Projects/GenesisTools-monorepo-1
rg -n "@app/utils/(json|json-schema|paths|string|date|date-locale|math|array|object|Stopwatch|tokens|hash|url|format)" packages/utils/src/
# edit each hit to a relative ./ import. Then assert the SOURCE is self-contained
# (exclude tests, which may keep the allowed @app/utils/test/skip back-edge):
rg -n "@app/" packages/utils/src/ -g '!*.test.ts' && echo "FAIL: package source still imports @app" || echo "package source is self-contained"
# tests may only reference the allowed exception:
rg -n "@app/" packages/utils/src/ -g '*.test.ts' | rg -v "@app/utils/test/skip" && echo "FAIL: unexpected @app edge in tests" || echo "tests clean (only @app/utils/test/skip allowed)"
```

## Step 5 — Add the 14 backward-compat shims at the old `src/utils/` paths

For each moved file, create a pure re-export at its original path. Example:

```ts
// src/utils/json.ts
export * from "@gt/utils/json";
```

```bash
cd /Users/Martin/Tresors/Projects/GenesisTools-monorepo-1
for f in json json-schema paths string date date-locale math array object Stopwatch tokens hash url format; do
  printf 'export * from "@gt/utils/%s";\n' "$f" > "src/utils/${f}.ts"
done
```

**Per-file default-export check** (star-export does not carry defaults):

```bash
rg -n "export default" packages/utils/src/*.ts
# For any hit, append to that shim:  export { default } from "@gt/utils/<f>";
```
(Verified today: the 14 leaves use named exports only — expect zero hits. If a
default appears later, the shim must add the explicit default re-export.)

## Step 6 — Migrate the representative tool set to consume `@gt/*`

These 6 tools were chosen because each actually imports the extracted leaves,
they span domains, and they are standalone enough for trivial review:

| Tool | Path | Extracted modules it uses | Import sites to change |
|---|---|---|---|
| `npm-package-diff` | `src/npm-package-diff/index.ts` | json | `@app/utils/json` → `@gt/utils/json` |
| `watch` | `src/watch/index.ts` | json, paths | both leaf imports → `@gt/utils/*` |
| `timer` | `src/timer/index.ts` | format | `@app/utils/format` → `@gt/utils/format` |
| `files-to-prompt` | `src/files-to-prompt/index.ts` | format | `@app/utils/format` → `@gt/utils/format` |
| `last-changes` | `src/last-changes/index.ts` | date, format | both → `@gt/utils/*` |
| `har-analyzer` | `src/har-analyzer/**` | format, json, json-schema | many sites across `commands/*`, `mcp/server.ts` |

Only rewrite the **leaf** imports in these tools. Leave their `@app/logger`,
`@app/utils/cli`, etc. imports alone (those are the deferred cluster, still
served by the originals). Concretely:

```bash
cd /Users/Martin/Tresors/Projects/GenesisTools-monorepo-1
# Inspect exactly what to change (then edit each file by hand for a clean diff):
rg -n "@app/utils/(json|json-schema|paths|date|format|string|math|array|object|Stopwatch|tokens|hash|url)\b" \
  src/npm-package-diff src/watch src/timer src/files-to-prompt src/last-changes src/har-analyzer
```

> Edit by hand (or a scoped codemod limited to these 6 paths) — do not run a
> repo-wide sed; the whole point of the shims is that the other ~64 tools stay
> on `@app/*` untouched.

## Step 7 — Verify GREEN

```bash
cd /Users/Martin/Tresors/Projects/GenesisTools-monorepo-1
bun install
# 1. tsgo whole-repo zero errors
tsgo --noEmit 2>&1 | tee /tmp/m1-tsgo.log | tail -5
rg -c "error TS" /tmp/m1-tsgo.log || echo 0          # MUST equal 0 (== baseline)
# 2. biome no new errors
biome check . 2>&1 | tee /tmp/m1-biome.log | tail -5  # compare error count to baseline
# 3. logging guard
bash scripts/ci/logging-guard.sh && echo "guard OK"
# 4. smoke-run migrated tools (exercise @gt/* runtime resolution)
./tools npm-package-diff --help                       # exit 0
./tools timer --help                                  # exit 0
./tools files-to-prompt --help                        # exit 0
./tools last-changes --help                           # exit 0
./tools watch --help                                  # exit 0
./tools har-analyzer --help                           # exit 0
# real-path exercise (hits an extracted fn at runtime):
./tools files-to-prompt src/ --cxml | head -c 200     # formatBytes path via @gt/utils
# 5. package tests still run
bun test packages/utils/ 2>&1 | tail -10
```

If any tsgo error appears: it is almost certainly a shim that lost a default
export, an intra-package import still pointing at `@app/*`, or a tool that
imported a leaf member not listed in `exports`. Fix at the source (the package
or the shim), never by narrowing tsgo scope.

## Step 8 — Commit the foundation milestone

```bash
cd /Users/Martin/Tresors/Projects/GenesisTools-monorepo-1
git add -A
git commit -m "feat(monorepo): extract @gt/utils leaf package + migrate 6 tools (foundation)"
```

(The design commit — this spec + plan — is committed separately, first.)

---

## Follow-up phases (documented, NOT executed in this worktree)

- **Phase 2 — `@gt/core` (logger/cli/prompts/storage cluster), atomic.**
  Pre-req: break the `src/utils/prompts/p/opentui-backend.ts → @app/doctor/ui/tui/stores/prompt-store`
  VALUE import (move the prompt-store contract into the package or lazy-load it)
  so the package does not import a tool. Then move `logger.ts`, `logger/*`,
  `utils/cli/*`, `utils/storage/*`, `utils/readme.ts`,
  `utils/logging/tool-policy.ts`, `utils/prompts/*`, `utils/process-alive.ts`,
  `utils/test/skip.ts` in ONE commit with intra-cluster imports rewritten to
  relative and shims left at the old paths. Update
  `scripts/ci/logging-guard.sh` allow-list and
  `src/logger/client-isolation.test.ts` for the new `@gt/core/logger` path.
  Highest-risk phase (the logging guard); do it alone.

- **Phase 3 — cutover (remove shims).** Per-tool codemod every
  `@app/utils/<moved>` / `@app/logger` site to `@gt/*`, then delete the shims.
  ~405 `@app/utils/json` sites + the rest — large mechanical diff, value-neutral
  at runtime. Stage per-tool; keep each batch green.

- **Phase 4 (optional) — domain packages.** Fold `utils/search`, `utils/macos`,
  `utils/git`, `utils/ai`, etc. into domain `@gt/*` packages once `@gt/core`
  exists. Judgment call; likely not worth it for a no-build repo.

---

## Risks & mitigations

- **`export *` drops default exports** → per-file default check in Step 5;
  add explicit `export { default }` where needed.
- **`tsgo` not seeing the package** → `include` must list `packages/*/src/**/*`
  AND `paths` must alias `@gt/utils/*`; verify with a deliberate type error in a
  package file that tsgo then reports.
- **Intra-package `@app/*` leak** → Step 4 `rg -n "@app/" packages/utils/src/`
  gate must be empty.
- **Bun symlink not created** → `ls -la node_modules/@gt/utils` after install;
  re-run `bun install` if missing.
- **Hidden non-leaf dep in a "leaf"** → the closure was verified
  (`rg -oN "@app/…" src/utils/<leaf>.ts`); re-run that scan if the set is edited.
- **puppeteer postinstall noise** masking a real install failure → assert
  `node_modules/{pino,comment-json,chalk,commander}` exist after install.
- **Migrating a tool that also uses the deferred cluster** → only the LEAF
  imports change in the 6 tools; their `@app/logger`/`@app/utils/cli` imports
  stay (served by the unchanged originals).
