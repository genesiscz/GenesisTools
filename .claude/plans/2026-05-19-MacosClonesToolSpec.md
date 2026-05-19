# `tools macos clones` — Tool Design Spec

**Status:** approved design (brainstorming complete) — ready for writing-plans
**Date:** 2026-05-19
**Branch / worktree:** `feat/apfs` @ `/Users/Martin/Tresors/Projects/GenesisTools-apfs`

---

## Context

bun materialises each project's `node_modules` via macOS `clonefile()` (APFS copy-on-write). `du`/Finder/`ncdu` sum per-inode blocks and **massively overcount** what is actually reclaimable. The utilities that compute the *real* numbers and safely convert non-clone duplicates into clones are specified separately and are a **hard prerequisite** for this tool:

> **Prerequisite:** `.claude/plans/2026-05-19-FsCloneAwareDiskUsage.md` (utils: `@app/utils/macos/apfs`, `@app/utils/fs/disk-usage`, 14-invariant dedupe safety contract). **Implement the utils plan in full and green before any line of this tool.** This tool is a thin controller over those utils — it adds no filesystem mutation logic of its own.

This spec is **design only**: command surface, the renderer interface, the `--format` contract, the process-audit (JSONL) data model, the duplicate-folder-collapse algorithm, config/daemon/cache integration. It does not restate util behaviour — it links it.

Implementation order (state in the tool plan): **(1)** utils plan → green → **(2)** this tool.

## Goal

`tools macos clones <measure|du|duplicates|optimize|config|daemon>` — see the *real* reclaimable size of APFS-cloned trees vs what `du` claims, find content-identical files/dirs that are not yet clones, and (opt-in, audited, reversible) convert them into clones to reclaim disk. macOS-only; nested under the existing `macos` umbrella tool. Hidden alias: `tools macos apfs …`.

## Non-Goals

- No Linux/Windows path (the util core is APFS syscalls; documented in utils plan).
- No new `src/utils/` abstractions; the renderer interface is **tool-local** (reuses `@app/utils/table`).
- No MCP server, no auto-apply daemon (daemon is report-only).
- Tool does **not** extend the utils `dedupeFile` contract — it **wraps** it for auditing (see §7).

## File structure

```
src/macos/commands/clones/
  index.ts              register `clones` command group (+ hidden alias `apfs`) on macos program
  measure.ts            measure + du actions (du = measure rooted at one folder, depth-limited)
  duplicates.ts         duplicates action (+ --group)
  optimize.ts           optimize: dry-run | --apply | --list | --log | --rollback
  config.ts             config action (clack TTY / parseVariadic non-TTY)
  daemon.ts             daemon enable|disable|status
src/macos/lib/clones/
  orchestrator.ts       multi-root walking, node_modules discovery, aggregation → report value objects
  collapse.ts           duplicate folder-collapse algorithm (§6)
  audit.ts              ProcessReport build/stream/replay; JSONL read+write; rollback
  cache.ts              1h plan cache (key + Storage wrappers)
  store.ts              Storage("macos-clones") config schema accessors
  render/
    types.ts            CloneRenderer interface + report value objects (the data contracts)
    table.ts            TableRenderer (formatTable + chalk headers/totals + glossary footer)
    json.ts             JsonRenderer (SafeJSON of the report objects; no glossary)
    index.ts            resolveRenderer(format) — auto→table(TTY)/json(non-TTY)
  scan-daemon.ts        non-interactive entry the daemon spawns (dry-run scan + notify)
src/macos/commands/clones/*.test.ts
src/macos/lib/clones/*.test.ts
```

Commands are thin controllers (parse args → call lib → render). All logic in `lib/`. `@app/logger` everywhere; `commander`; `@clack/prompts` for interactive.

## Conventions

- Imports via `@app/*`. `SafeJSON` not `JSON`. Block-form `if`, blank line after `}`. Object params for 3+ args.
- Tests next to source, `bun:test`, `skip.unlessMac` for clone behaviour (from `@app/utils/test/skip`).
- Non-TTY guard: `isInteractive()` / `suggestCommand()` from `@app/utils/cli`.

---

## 1. Command surface (final)

```
tools macos clones measure   [roots...]                 # clone-aware sizes; breakdown default
tools macos clones du        [folder=cwd] [--depth N]   # measure rooted at one folder, deep
tools macos clones duplicates[roots...] [--group]       # identical content, folder-collapsed
tools macos clones optimize  [roots...]                 # dry-run; --apply --list --log --rollback
tools macos clones config                               # watched dirs + filters
tools macos clones daemon    <enable|disable|status>    # once/24h dry-run scan + notify
   (hidden alias: tools macos apfs …)
```

**Roots resolution** (measure/du/duplicates/optimize): explicit `[roots...]` → else configured `watchedDirs` → else cwd. `--node-modules` focus mode: expand each root to its `node_modules` dirs via `find <root> -type d -name node_modules -prune` (NOT `fd` — gitignored; see utils plan §5 scanner caveat).

## 2. Shared flags & `--format` contract

Every command except `config`:

- `--format <auto|table|json|jsonl>` (default `auto`). `resolveFormat()` (copy of `src/todo/lib/format.ts` pattern): `auto` → `table` if `isInteractive()` else `json`. `jsonl` only meaningful for `optimize --log` (streams ops).
- `--node-modules` · `--min-real <bytes>` (default `10485760` = 10 MB) · `--top <N>` (default **unlimited** — no trimming) · `--no-breakdown` · `--include <glob>` / `--exclude <glob>` (repeatable, `parseVariadic`) · `-v/--verbose` · `--silent`.
- `optimize` adds: `--apply` · `--rollback` · `--list` · `--log` · `--process <id>` · `--no-cache`.

`config` has no `--format` (prompt/flag flow); emits its config as JSON when non-TTY with no mutating flag.

## 3. Renderer interface (tool-local, swappable)

`src/macos/lib/clones/render/types.ts`:

```ts
export type Format = "auto" | "table" | "json" | "jsonl";

export interface CloneRenderer {
    measure(r: MeasureReport): string;
    duplicates(r: DuplicatesReport): string;
    processReport(r: ProcessReport): string; // optimize --apply tail, --rollback tail, --log
    processList(r: ProcessListReport): string; // optimize --list
}
```

- `TableRenderer` — `formatTable` from `@app/utils/table` for the grids; `chalk` ONLY for headers/totals/section labels (stripped when non-TTY); appends the canonical **glossary footer** (§9) to `measure`/`duplicates`. Indentation: 2 spaces per tree depth in the first column.
- `JsonRenderer` — `SafeJSON.stringify(reportValueObject, null, 2)`; identical data shape across commands; **no** glossary/no chalk. `jsonl` variant: one JSON object per `ProcessOp` line (for `--log --format jsonl`).
- `render/index.ts`: `resolveRenderer(format): CloneRenderer`. The interface is the single swap point — a future `cli-table3`/TUI renderer implements `CloneRenderer`; callers never change.

## 4. Report value objects (data contracts — the backbone)

```ts
export interface DirNode {
    path: string;            // absolute
    depth: number;           // 0 = root
    logical: number;
    allocated: number;       // du-style
    real: number | null;     // ATTR_CMNEXT_PRIVATESIZE sum; null off-APFS
    overcount: number | null;// allocated / real
    children: DirNode[];     // only dirs with real > minReal (deepest-kept; §5)
    sharedNote?: string;     // e.g. "3,402 files cloned from <keeper> → 0 B real"
}
export interface MeasureReport {
    roots: string[];
    nodeModulesMode: boolean;
    minReal: number;
    tree: DirNode[];                 // top-level rows (roots or node_modules)
    totals: { logical; allocated; real: number|null; overcount: number|null };
    cloneAnalysis: {
        families: number; clonedFiles: number; sharedBytes: number;
        crossTreePartners: string[]; // e.g. ["~/.bun/install/cache"]
        notes: string[];             // human lines ("col-fe*: du 14 GB → real 3.58 GB …")
    };
    freeSpace: { total; free; available };
    errors: { path: string; errno: string }[];
}
export interface DuplicateSet {
    kind: "file" | "dir";
    what: string;            // collapsed path label (relative to common root)
    copies: number;
    eachBytes: number;
    reclaimable: number;     // (copies-1) * eachBytes
    members: string[];       // all absolute paths (full list; never trimmed)
    keep: string;            // chosen representative
}
export interface DuplicatesReport {
    roots: string[]; sets: DuplicateSet[];
    totalReclaimable: number; grouped: boolean; hardStop: string[]; // the scan roots
}
export type OpKind = "clone" | "skip" | "error" | "rollback-uncloned";
export interface ProcessOp {
    seq: number; ts: string;            // ISO
    op: OpKind;
    status: string;                     // "ok"|"changed"|"hardlink"|"same-file"|"not-regular"|"cross-volume"|"errno:EACCES"…
    bytes: number;
    keep: string; replace: string;
    modeBefore: number; mtimeBeforeMs: number;
    sha256Before: string; sha256After?: string; // After re-hashed post-clone (byte-identity proof)
    message?: string;                   // human reason for skip/error
}
export interface ProcessReport {
    id: string;                         // ISO-ish, filename-safe (2026-05-19T14-03-22Z)
    state: "dry-run" | "applied" | "rolled-back";
    roots: string[]; startedAt: string; endedAt: string;
    planCache: { hit: boolean; ageMs?: number };
    ops: ProcessOp[];
    totals: { cloned: number; skipped: number; errors: number; bytesReclaimed: number };
}
export interface ProcessListReport {
    processes: Pick<ProcessReport,"id"|"state"|"roots"|"totals"|"startedAt">[];
}
```

The JSONL on disk is **the source of truth**. `--apply` produces `ProcessReport` live; `--log` reconstructs it from the JSONL; both render via `renderer.processReport`. `--apply`/`--rollback` print exactly that render as their tail (so the end-of-run report is *replicable verbatim* by `--log --process <id>`).

## 5. `measure` / `du` semantics

- Walks via the utils (`measureTree` per root; `freeDiskSpace`; `getCloneId` for family analysis). Tool builds the `DirNode` tree.
- **Breakdown is default.** `--no-breakdown` → totals + cloneAnalysis only (no `children`).
- **Subdir keep rule (deepest-significant):** include a dir D as a `children` node iff `real(D) > minReal`. Collapse ancestors: if a single child C has `real(C) ≥ 0.9 * real(D)` and is itself kept, D is *not* emitted as its own row (pass-through) — its child is. A dir IS emitted when it has `> minReal` of its own real spread across sub-`minReal` children (e.g. `.cache/` 198 MB, children all <10 MB → `.cache/` is the deepest-kept). `du` = same algorithm rooted at one folder with `--depth N` cap (default unlimited).
- Columns per row: `logical · du -sh · real · overcount`. `real` per row = bytes freed if **that dir alone** is deleted (clone/snapshot-aware). Cloned-away remainder shown as one `sharedNote` line (e.g. `└ 3,402 files cloned from <keeper> → 0 B real`), expandable with `--show-shared`.
- `--sort <overcount|real|du>` (default `overcount`). No trimming; `--top N` opt-in.
- Off-APFS: `real`/`overcount` = `null`; renderer prints `unavailable`; `measure`/`du` still work (logical/du). `optimize` hard-errors off-APFS (see §7).
- Footer: cloneAnalysis lines + glossary (§9).

## 6. `duplicates` — folder-collapse algorithm

`src/macos/lib/clones/collapse.ts`:

1. Use utils `findDuplicateFiles(root)` per root → file-level identical groups (size→sha256→byte-equal; already clone-aware: a group only matters if members are NOT already same `cloneId`).
2. **Directory rollup:** for each dir, compute `dirContentHash = sha256(sorted list of (relpathFromDir, fileSha256, mode))`. Two dirs are *whole-dir duplicates* iff equal `dirContentHash` AND equal recursive file count AND no extra entries.
3. **Collapse upward** to the **highest** ancestor that is still a whole-dir duplicate of a counterpart — but **HARD STOP at the scan roots**: never test or ascend above any path in `roots` (prevents a bug walking up to `/Users` or `/`). If a whole `node_modules/` is duplicated, that's the entry; else the deepest shared subtree; else individual files.
4. Emit `DuplicateSet` per collapsed group: `kind`, `what` (label relative to common ancestor of roots), `copies`, `eachBytes`, `reclaimable=(copies-1)*eachBytes`, full `members`, `keep` (lexically-first stable pick).
5. `--group` → renderer lists every `member` under each set (no trimming).

`reclaimable` is the projected post-`optimize` gain (turning N independent copies into 1 + N−1 clones).

## 7. `optimize` — dry-run / apply / audit

- Default (no `--apply`) = **dry run**: build the plan from `duplicates` → `DedupeCandidate[]`-equivalent, render projected reclaim, write the plan to the **1h cache** (§8), exit 0. Mutates nothing.
- `--apply`:
  - Preflight: `isApfsCloneSupported()` false → **exit 1** with explanation (never silently skip mutation).
  - Reuse fresh (<1h, same key) cached plan unless `--no-cache`; report `planCache.hit/ageMs`.
  - **TTY confirm:** clack summary (`N files → clones · reclaim X · rewrites in place, content-verified`) then `p.text` requiring the literal token **`apply`** (`p.isCancel`/mismatch → abort, mutate nothing). **Non-TTY:** requires `--yes`; absent → error + `suggestCommand(... {add:["--apply","--yes"]})`, exit 1.
  - **Audit wrapper (does NOT extend utils):** `audit.ts` `runOptimize()` iterates candidates; per file: capture pre-state (`lstat` mode/mtime, `sha256Before`) → call utils `dedupeFile({keep,replace})` (the 14-invariant-safe primitive, unchanged) → on `cloned` re-hash → `sha256After`, assert `===sha256Before` (byte-identity; mismatch ⇒ record `op:"error" status:"integrity"` and STOP the run) → append a `ProcessOp` JSONL line. `skipped-*`/`CloneUnsupportedError` map to `op:"skip"`/`"error"` with `status`+`message`; the run continues (per-file isolation).
  - JSONL path: `~/.genesis-tools/macos-clones/process/<id>.jsonl` via `Storage("macos-clones")` (`process/` subdir). Streamed line-by-line (crash-safe partial log).
  - Tail = `renderer.processReport(report)` — identical to `--log --process <id>`. Always prints: per-op table, **skipped list with reasons**, **errors list with reasons**, totals, and `suggestCommand`: `tools macos clones optimize --rollback --process <id>`.
- `--list` → `ProcessListReport` from the `process/` dir (newest first; states; `--format json`).
- `--log --process <id>` → read JSONL → reconstruct `ProcessReport` → `renderer.processReport`. Read-only. `--format jsonl` streams raw lines. Works on `applied` and `rolled-back` (rollback ops appended to the same file).
- `--rollback --process <id>`:
  - TTY confirm token **`rollback`** (mirrors `apply`); non-TTY needs `--yes`.
  - For each `op:"clone"` in the process: re-materialise `replace` as an **independent (un-shared) copy** (plain copy, not `clonefile`) so its extents are no longer shared, then restore `modeBefore`/`mtimeBefore`. Content is already byte-identical (verified at apply) so rollback changes only physical layout, never bytes. Append `op:"rollback-uncloned"` ops to the **same JSONL** (preserves the audit chain); set process `state:"rolled-back"`. Emits its own `processReport` view (rollback ops).

Rationale (kept in spec, per design discussion): rollback exists for users who explicitly want the duplication back (e.g. isolating a volume for `df`); it is safe and a near-no-op for content.

## 8. Plan cache (1h)

`cache.ts`: `Storage("macos-clones").putCacheFile/getCacheFile` with TTL string `"1 hour"`. Key:
`plan-<sha1(SafeJSON.stringify({roots:rootsSorted, minSize, include:sortedCopy, exclude:sortedCopy, nodeModules}))>.json` — arrays sorted so equivalent invocations share a key. Stores the dry-run candidate plan. **Staleness cannot corrupt:** utils `dedupeFile` re-verifies content immediately before every clone (safety invariant #12) — a file changed/removed since the cached scan becomes `skip status:"changed"`, never a bad clone. Cache memoises *discovery* only. `--no-cache` forces a fresh scan.

## 9. Glossary (canonical footer text — printed by TableRenderer on measure/du/duplicates)

```
real      bytes freed if you delete THIS dir/file now, accounting for clones &
          snapshots (kernel ATTR_CMNEXT_PRIVATESIZE). The honest number.
du -sh    system du: sums per-inode allocated blocks → counts every clone copy
          in full → overstates.
overcount du ÷ real. "8.7×" = du claims ~9× more than you'd actually reclaim.
clone family  files sharing the same physical blocks because one was clonefile()'d
          from another (bun from its cache, or cp -c). Same content, separate
          inodes, copy-on-write — editing one never touches the other.
cross-tree the family's sharing partner is OUTSIDE the measured folder (usually
          ~/.bun/install/cache): deleting this folder frees only its private
          bytes; shared blocks stay alive in the cache. intra-tree = both copies
          inside → deleting really frees them.
```

`JsonRenderer` omits the glossary (machine consumers don't need it).

## 10. `config` subcommand

`Storage("macos-clones")` `config.json`:
`{ watchedDirs: string[]; minReal?: number; exclude?: string[]; nodeModules?: boolean }` — mutated via `storage.atomicConfigUpdate` (pattern: `src/daemon/lib/config.ts`).

- **TTY:** `@clack/prompts` — show current dirs; `select` action (Add / Remove / Toggle node_modules / Set min-real); `text`/`multiselect` accordingly; validate path existence; `p.isCancel` → abort, no write.
- **Non-TTY:** `--add-dir <paths>` / `--remove-dir <paths>` via `parseVariadic` from `@app/utils/cli` (handles repeated flags AND comma lists; dedups; resolve to absolute). `--list` prints config; no args + non-TTY → print config JSON. Add validates existence; warn+skip non-existent.

## 11. `daemon` subcommand

- `enable` → `registerTask` from `@app/daemon/lib/register`:
  ```
  { name:"macos-clones-scan",
    command:`${absBun} run ${absScanScript}`,   // BOTH absolute, resolved at enable-time
    every:"every day at 03:00", overwrite:true, notify:true,
    timeoutMs:30*60_000, retries:1,
    retention:{ maxAgeDays:14, minRuns:14 },
    description:"Clone-aware dry-run scan of watched dirs; notify reclaimable" }
  ```
  `absBun = Bun.which("bun") ?? process.execPath`; `absScanScript = fileURLToPath(new URL("../lib/clones/scan-daemon.ts", import.meta.url))` — resolved when `enable` runs so the registered command stays valid regardless of cwd.
- `scan-daemon.ts` (non-interactive): load `watchedDirs`; if empty → log+exit 0. Run **dry-run** `measure`+`duplicates` (NEVER `--apply` — unattended mutation is the one thing the safety model forbids); write the 1h plan cache; emit ONE macOS notification: *"N GB reclaimable across M dirs — run `tools macos clones optimize --apply`"*. Write a `ProcessReport` with `state:"dry-run"` to `process/` so `--list` shows it.
- `disable` → remove/disable the task via daemon lib. `status` → last run + next run + last dry-run reclaimable summary; remind `tools daemon start` if daemon not running.

## 12. Error handling & exit codes

- `WalkError`s (EPERM/ENOENT) → `MeasureReport.errors[]`; never throw. Exit `0` if any files processed, `2` if a whole root was unreadable.
- `CloneUnsupportedError` mid-`optimize` (cross-volume/non-APFS file) → per-file `op:"error"`, run continues, summarised. Off-APFS *root* preflight → exit 1 before any mutation.
- Integrity failure (`sha256After !== sha256Before`) → record error op, **abort the run immediately**, non-zero exit, surface loudly. (Cannot happen given the utils contract — defence in depth.)
- `--log`/`--rollback` with unknown `--process` → exit 1, list closest ids.

## 13. Testing strategy

Tool tests assert **orchestration & rendering**, not clonefile mechanics (covered by utils plan's 14-invariant suite):

- `render/*.test.ts`: `TableRenderer`/`JsonRenderer` against fixed `MeasureReport`/`DuplicatesReport`/`ProcessReport` (snapshot columns, glossary present in table / absent in json, `--apply` tail === `--log` render of the same object).
- `collapse.test.ts`: file→subdir→whole-dir rollup; **hard-stop never ascends above scan roots** (assert with nested temp dirs); `--group` lists all members.
- `measure` subdir keep rule (`>minReal`, deepest-kept, pass-through collapse, spread-across-small parent kept).
- `audit.test.ts` (`skip.unlessMac`): real temp clone round-trip → JSONL lines well-formed → `--log` reconstructs identical `ProcessReport` → `--rollback` appends `rollback-uncloned` ops to the same file and un-shares (post: `getCloneId` differs / private rises).
- arg/preflight: non-TTY `--apply` without `--yes` errors with exact `suggestCommand`; off-APFS `optimize` exit 1; `config --add-dir a,b` via `parseVariadic`; plan-cache key stable under arg reorder; daemon `enable` registers absolute-path command (mock `registerTask`).

## 14. Resolved decisions (one-liners)

- Names: `duplicates`, `optimize` (was dupes/dedupe). Apply token `apply`; rollback token `rollback`.
- `--breakdown` is default (`--no-breakdown` opts out). No row trimming by default.
- Renderer interface tool-local; reuses `@app/utils/table`; no `src/utils` refactor.
- One `ProcessReport` powers `--apply` tail, `--rollback` tail, and `--log` (JSONL = source of truth; rollback appends, never new process).
- Tool wraps (not extends) utils `dedupeFile`; utils 14-invariant contract untouched.
- Daemon is report-only; absolute paths resolved at `enable`-time via `import.meta.url`.
- Spec & plans live in `.claude/plans/` (repo convention), co-located with the utils plan.

## 15. Implementation order (for the tool plan)

1. **Prerequisite:** execute `2026-05-19-FsCloneAwareDiskUsage.md` fully; all tests green.
2. render/types.ts (data contracts) → JsonRenderer → TableRenderer (TDD each).
3. orchestrator + collapse (measure/du/duplicates) → wire `measure`/`du`/`duplicates` commands.
4. cache → optimize dry-run.
5. audit (ProcessReport/JSONL) → optimize `--apply` (+confirm) → `--log` → `--list` → `--rollback`.
6. store → config. 7. daemon + scan-daemon. 8. register `clones` group + hidden `apfs` alias on macos; full suite + `tsgo --noEmit`.
