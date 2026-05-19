# Macos Clones Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `tools macos clones <measure|du|duplicates|optimize|config|daemon>` — a macOS-only subcommand under the existing `macos` umbrella tool (hidden alias `tools macos apfs …`) that shows the *real* APFS clone-aware reclaimable size of trees vs what `du` claims, finds content-identical files/dirs that are not yet clones, and (opt-in, audited, reversible) converts them into clones to reclaim disk. The tool is a **thin controller** over the already-implemented `@app/utils/macos/apfs` + `@app/utils/fs/disk-usage` utilities; it adds no filesystem-mutation logic of its own.

**Architecture:** Commander subcommands in `src/macos/commands/clones/` are thin controllers (parse args → call lib → render). All business logic lives in `src/macos/lib/clones/`: `orchestrator.ts` (multi-root walking → report value objects), `collapse.ts` (duplicate folder-collapse), `audit.ts` (ProcessReport build/stream/replay via JSONL), `cache.ts` (1h plan cache), `store.ts` (config schema), `scan-daemon.ts` (non-interactive daemon entry). A tool-local, swappable `CloneRenderer` interface (`render/types.ts`) with `TableRenderer` (uses `@app/utils/table`) and `JsonRenderer` (`SafeJSON`) is the single output swap-point. `@app/logger` everywhere; `commander` for args; `@clack/prompts` for interactive confirms; `parseVariadic`/`isInteractive`/`suggestCommand` from `@app/utils/cli`.

**Tech Stack:** Bun runtime (no build step — TS runs directly), `commander`, `@clack/prompts`, `picocolors`, `bun:test`, `@app/utils/fs/disk-usage` + `@app/utils/macos/apfs` (the prerequisite utils), `@app/utils/storage/storage` (`Storage("macos-clones")`), `@app/daemon/lib/register` (`registerTask`/`unregisterTask`), `@app/utils/macos/notifications` (`sendNotification`), `@app/utils/table` (`formatTable`), `node:fs`/`node:path`/`node:url`/`node:crypto`.

---

## Context

This plan implements the approved design spec `.claude/plans/2026-05-19-MacosClonesToolSpec.md` (read it — it is authoritative; every section §1–§15 maps to tasks below). bun materialises each project's `node_modules` via macOS `clonefile()` (APFS copy-on-write); `du`/Finder/`ncdu` sum per-inode blocks and massively overcount what is actually reclaimable. This tool surfaces the honest numbers and (opt-in, audited, reversible) converts non-clone duplicates into clones. All real filesystem work — clone-aware sizing, duplicate detection, the 14-invariant-safe `dedupeFile` primitive — is done by the prerequisite utils; this tool only orchestrates, renders, audits, caches, and schedules.

### ⛔ PREREQUISITE GATE — READ BEFORE TASK 1

> **The utils plan `.claude/plans/2026-05-19-FsCloneAwareDiskUsage.md` MUST be fully implemented and ALL its tests green BEFORE Task 1 of THIS plan.** It is implemented separately. **Do NOT interleave or re-derive any utils task here.** This plan ONLY builds the tool on top of the *finished* utils. Task 0 below is a hard verification gate: if the utils suites are red or the utils symbols are missing, **STOP and finish the utils plan first.** The tool tests assert orchestration & rendering — they assume `@app/utils/macos/apfs` and `@app/utils/fs/disk-usage` already export and behave per the utils plan's "Public API surface (final)".

**The exact utils API this plan consumes** (do not re-implement — import and call):

- From `@app/utils/macos/apfs`: `getPrivateSize(path): number|null`, `getCloneId(path): bigint|null`, `getExtFlags(path)`, `isApfsCloneSupported(): boolean`, `getFsType(path): string|null`, `supportsClone(path): boolean`, `cloneFile(src,dst): void`, `class CloneUnsupportedError extends Error`.
- From `@app/utils/fs/disk-usage`: `fileLogicalSize(path): number`, `fileAllocatedSize(path): number`, `filePrivateSize(path): number|null`, `walkFiles(root, {onError?}): Generator<WalkEntry>`, `measureTree(root, {exact?}): DiskUsage`, `reclaimableBytes(root): number|null`, `exactReclaimableBytes(root): number|null`, `findCloneFamilies(root): Map<string,string[]>`, `freeDiskSpace(path): {total,free,available}`, `overcountRatio(root): {allocated,private,ratio}|null`, `formatDiskUsage(u): string`, `findDuplicateFiles(root): DuplicateGroup[]`, `findDedupeCandidates(root): DedupeCandidate[]`, `dedupeFile({keep,replace}): DedupeResult`, `dedupeTree(root,{apply?}): DedupeTreeReport`.
- Utils types in scope: `WalkEntry {path,logical,allocated}`, `WalkError {path,errno}`, `DiskUsage {logical,allocated,private:number|null,exactReclaimable:number|null,fileCount,dirCount,errors:WalkError[]}`, `DuplicateGroup {size,sha256,paths:string[]}`, `DedupeCandidate {sha256,size,keep,replace:string[],reclaimable}`, `DedupeResult {status:DedupeStatus,bytesReclaimed}`, `DedupeStatus = "cloned"|"already-cloned"|"skipped-different"|"skipped-symlink"|"skipped-same-file"|"skipped-not-regular"`.

### Conventions (enforced in every task)

- Imports via `@app/*` alias. `SafeJSON` from `@app/utils/json`, never `JSON`. Block-form `if` (no one-line ifs). Blank line after a closing `}` (unless followed by `else`/`catch`/`finally`/`}`). Object params for 3+ args. No file-path comments, no obvious comments. `@app/logger` for all logging; never swallow an error (at minimum `logger.debug` it).
- Tests next to source, `import { describe, expect, it } from "bun:test"`, temp dirs via `mkdtempSync(join(tmpdir(), "gt-..."))` and removed in `finally` with `rmSync(dir, { recursive: true, force: true })`. `describe.skipIf(skip.unlessMac)(...)` (from `@app/utils/test/skip`) for any block whose behaviour depends on real clonefile.
- Non-TTY guard: `isInteractive()` / `suggestCommand()` from `@app/utils/cli` before any `@clack/prompts` call.
- Tool tests assert **orchestration & rendering**, NOT clonefile mechanics (those are covered by the utils plan's 14-invariant suite).

### Persistence model (pinned here, referenced by Tasks 12–16, 19)

- **1h plan cache:** `Storage("macos-clones").putCacheFile("plan-<sha1>.json", plan, "1 hour")` / `getCacheFile(..., "1 hour")` — matches `Storage`'s `cache/` contract (Task 10).
- **Process JSONL audit log:** lives in a `process/` subdir that is a **sibling of `cache/`** under `Storage("macos-clones").getBaseDir()` (NOT a Storage cache helper — Storage's file helpers all write under `cache/`). The audit module uses raw `node:fs`: `const processDir = join(storage.getBaseDir(), "process"); mkdirSync(processDir, { recursive: true }); appendFileSync(jsonlPath, SafeJSON.stringify(line) + "\n")`. Pinned in Task 12.
- **JSONL line format (pinned in Task 12, reused verbatim by Tasks 13–16, 19):** the FIRST line is a meta line `{"_meta":{"id","state","roots","startedAt","endedAt","planCacheHit","planCacheAgeMs"}}`; subsequent lines are `ProcessOp` objects. `--rollback` appends a SECOND meta line `{"_meta":{...,"state":"rolled-back","endedAt":...}}` followed by its `rollback-uncloned` ops to the SAME file (audit chain preserved). `--list` reads first + last meta line per file; `--log` replays the whole file (last meta line wins for `state`/`endedAt`). The scan-daemon dry-run writes only the meta line (state `"dry-run"`, no ops).

---

## File Structure (from spec §"File structure"; all paths under the worktree)

```
src/macos/commands/clones/
  index.ts              registerClonesCommand(program) — `clones` group (+ hidden alias `apfs`)
  measure.ts            `measure` + `du` actions (du = measure rooted at one folder, depth-limited)
  duplicates.ts         `duplicates` action (+ --group)
  optimize.ts           `optimize`: dry-run | --apply | --list | --log | --rollback
  config.ts             `config` action (clack TTY / parseVariadic non-TTY)
  daemon.ts             `daemon` enable|disable|status
  *.test.ts             command-level tests (arg/preflight/exit-code)
src/macos/lib/clones/
  orchestrator.ts       multi-root walking, node_modules discovery, DirNode tree, aggregation → report value objects
  collapse.ts           duplicate folder-collapse algorithm (spec §6)
  audit.ts              ProcessReport build/stream/replay; JSONL read+write; rollback ops
  cache.ts              1h plan cache (key + Storage wrappers)
  store.ts              Storage("macos-clones") config schema accessors
  scan-daemon.ts        non-interactive entry the daemon spawns (dry-run scan + ONE notification)
  render/
    types.ts            CloneRenderer interface + report value objects (the data contracts)
    table.ts            TableRenderer (formatTable + chalk headers/totals + glossary footer)
    json.ts             JsonRenderer (SafeJSON of the report objects; no glossary)
    index.ts            resolveRenderer(format) / resolveFormat(flag) — auto→table(TTY)/json(non-TTY)
  *.test.ts             lib-level tests (render snapshots, collapse, orchestrator, audit)
```

Commands are thin controllers (parse args → call lib → render). All logic in `lib/`.

---

### Task 0: Prerequisite verification (HARD GATE — do not skip)

**Files:** none (verification only — no Create/Modify/Test).

This task proves the prerequisite utils plan is fully implemented and green. **If any step is red, STOP and implement `.claude/plans/2026-05-19-FsCloneAwareDiskUsage.md` first.** Do not write a single line of this tool until all four steps below pass.

- [ ] **Step 1: Confirm the worktree & branch**

Run:
```bash
git -C /Users/Martin/Tresors/Projects/GenesisTools-apfs rev-parse --abbrev-ref HEAD
```
Expected: `feat/apfs`. All work happens in this worktree.

- [ ] **Step 2: Run the utils test suites**

Run:
```bash
bun test src/utils/fs/disk-usage.test.ts src/utils/macos/apfs.test.ts 2>&1 | tee /tmp/clones-prereq.log | tail -40
```
Expected: **0 failures.** On macOS the clone-specific blocks run and pass (clone → <256 KB private, dedupe COW-independence, dry-run/apply); off-macOS the `skip.unlessMac` blocks are skipped but the cross-platform ones still pass. **STOP if red — implement the utils plan first.**

- [ ] **Step 3: Confirm the exact utils symbols are exported**

Run:
```bash
bun -e 'import * as a from "@app/utils/macos/apfs"; import * as d from "@app/utils/fs/disk-usage"; const need=["getPrivateSize","getCloneId","getExtFlags","isApfsCloneSupported","getFsType","supportsClone","cloneFile","CloneUnsupportedError"]; const needD=["fileLogicalSize","fileAllocatedSize","filePrivateSize","walkFiles","measureTree","reclaimableBytes","exactReclaimableBytes","findCloneFamilies","freeDiskSpace","overcountRatio","formatDiskUsage","findDuplicateFiles","findDedupeCandidates","dedupeFile","dedupeTree"]; const miss=[...need.filter(k=>!(k in a)),...needD.filter(k=>!(k in d))]; if(miss.length){console.error("MISSING:",miss.join(","));process.exit(1)} console.log("all utils symbols present")'
```
Expected: `all utils symbols present`. **STOP if it prints `MISSING:` — the utils plan is incomplete.**

- [ ] **Step 4: Typecheck the utils surface**

Run:
```bash
tsgo --noEmit 2>&1 | rg "src/utils/(fs|macos)/" || echo "NO UTILS TYPE ERRORS"
```
Expected: `NO UTILS TYPE ERRORS` (no matching lines). If utils files have type errors, **STOP and fix the utils plan.**

- [ ] **Step 5: Gate decision**

All four steps green ⇒ proceed to Task 1. Any red ⇒ this plan is BLOCKED; finish the utils plan, re-run Task 0, then continue. (No commit — this task changes nothing.)

---

### Task 1: `render/types.ts` — data contracts (the backbone)

**Files:**
- Create: `src/macos/lib/clones/render/types.ts`
- Create: `src/macos/lib/clones/render/types.test.ts`

These are the report value objects every command produces and every renderer consumes (spec §3, §4). Pure types + one tiny constant — no logic.

- [x] **Step 1: Write the failing test**

`src/macos/lib/clones/render/types.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { CLONES_GLOSSARY, type CloneRenderer, type Format } from "@app/macos/lib/clones/render/types";

describe("clones render types", () => {
    it("exports the canonical glossary footer text", () => {
        expect(CLONES_GLOSSARY).toContain("ATTR_CMNEXT_PRIVATESIZE");
        expect(CLONES_GLOSSARY).toContain("du ÷ real");
        expect(CLONES_GLOSSARY).toContain("clone family");
        expect(CLONES_GLOSSARY).toContain("cross-tree");
    });

    it("CloneRenderer is structurally satisfiable", () => {
        const fmt: Format = "table";
        const r: CloneRenderer = {
            measure: () => "m",
            duplicates: () => "d",
            processReport: () => "p",
            processList: () => "l",
        };
        expect(fmt).toBe("table");
        expect(r.measure({} as never)).toBe("m");
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/macos/lib/clones/render/types.test.ts -t "clones render types"`
Expected: FAIL — `Cannot find module '@app/macos/lib/clones/render/types'`.

- [x] **Step 3: Implement `render/types.ts`**

`src/macos/lib/clones/render/types.ts`:

```typescript
export type Format = "auto" | "table" | "json" | "jsonl";

export interface DirNode {
    path: string;
    depth: number;
    logical: number;
    allocated: number;
    real: number | null;
    overcount: number | null;
    children: DirNode[];
    sharedNote?: string;
}

export interface MeasureTotals {
    logical: number;
    allocated: number;
    real: number | null;
    overcount: number | null;
}

export interface CloneAnalysis {
    families: number;
    clonedFiles: number;
    sharedBytes: number;
    crossTreePartners: string[];
    notes: string[];
}

export interface MeasureFreeSpace {
    total: number;
    free: number;
    available: number;
}

export interface MeasureError {
    path: string;
    errno: string;
}

export interface MeasureReport {
    roots: string[];
    nodeModulesMode: boolean;
    minReal: number;
    tree: DirNode[];
    totals: MeasureTotals;
    cloneAnalysis: CloneAnalysis;
    freeSpace: MeasureFreeSpace;
    errors: MeasureError[];
}

export interface DuplicateSet {
    kind: "file" | "dir";
    what: string;
    copies: number;
    eachBytes: number;
    reclaimable: number;
    members: string[];
    keep: string;
}

export interface DuplicatesReport {
    roots: string[];
    sets: DuplicateSet[];
    totalReclaimable: number;
    grouped: boolean;
    hardStop: string[];
}

export type OpKind = "clone" | "skip" | "error" | "rollback-uncloned";

export interface ProcessOp {
    seq: number;
    ts: string;
    op: OpKind;
    status: string;
    bytes: number;
    keep: string;
    replace: string;
    modeBefore: number;
    mtimeBeforeMs: number;
    sha256Before: string;
    sha256After?: string;
    message?: string;
}

export interface ProcessTotals {
    cloned: number;
    skipped: number;
    errors: number;
    bytesReclaimed: number;
}

export interface ProcessReport {
    id: string;
    state: "dry-run" | "applied" | "rolled-back";
    roots: string[];
    startedAt: string;
    endedAt: string;
    planCache: { hit: boolean; ageMs?: number };
    ops: ProcessOp[];
    totals: ProcessTotals;
}

export interface ProcessListEntry {
    id: string;
    state: ProcessReport["state"];
    roots: string[];
    totals: ProcessTotals;
    startedAt: string;
}

export interface ProcessListReport {
    processes: ProcessListEntry[];
}

export interface CloneRenderer {
    measure(r: MeasureReport): string;
    duplicates(r: DuplicatesReport): string;
    processReport(r: ProcessReport): string;
    processList(r: ProcessListReport): string;
}

/** Canonical glossary footer (spec §9). TableRenderer appends it to
 *  measure/duplicates; JsonRenderer omits it. */
export const CLONES_GLOSSARY = [
    "real      bytes freed if you delete THIS dir/file now, accounting for clones &",
    "          snapshots (kernel ATTR_CMNEXT_PRIVATESIZE). The honest number.",
    "du -sh    system du: sums per-inode allocated blocks → counts every clone copy",
    "          in full → overstates.",
    "overcount du ÷ real. \"8.7×\" = du claims ~9× more than you'd actually reclaim.",
    "clone family  files sharing the same physical blocks because one was clonefile()'d",
    "          from another (bun from its cache, or cp -c). Same content, separate",
    "          inodes, copy-on-write — editing one never touches the other.",
    "cross-tree the family's sharing partner is OUTSIDE the measured folder (usually",
    "          ~/.bun/install/cache): deleting this folder frees only its private",
    "          bytes; shared blocks stay alive in the cache. intra-tree = both copies",
    "          inside → deleting really frees them.",
].join("\n");
```

- [x] **Step 2: Run it to verify it fails**

- [x] **Step 4: Run the test**

Run: `bun test src/macos/lib/clones/render/types.test.ts -t "clones render types"`
Expected: PASS (glossary contains the four marker substrings; `CloneRenderer` is satisfiable).

- [x] **Step 5: Commit**

```bash
git add src/macos/lib/clones/render/types.ts src/macos/lib/clones/render/types.test.ts
git commit -m "feat(clones): render data contracts + glossary text"
```

---

### Task 2: `render/json.ts` — JsonRenderer

**Files:**
- Create: `src/macos/lib/clones/render/json.ts`
- Create: `src/macos/lib/clones/render/json.test.ts`

`SafeJSON.stringify(reportValueObject, null, 2)`; identical data shape across commands; **no** glossary, no chalk. The `jsonl` behaviour (one JSON object per `ProcessOp` line) is exposed as a separate `processReportJsonl()` helper used only by `optimize --log --format jsonl` (spec §3, §4).

- [ ] **Step 1: Write the failing test**

`src/macos/lib/clones/render/json.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { SafeJSON } from "@app/utils/json";
import { JsonRenderer } from "@app/macos/lib/clones/render/json";
import { CLONES_GLOSSARY, type MeasureReport, type ProcessReport } from "@app/macos/lib/clones/render/types";

const measure: MeasureReport = {
    roots: ["/r"],
    nodeModulesMode: false,
    minReal: 10485760,
    tree: [],
    totals: { logical: 1000, allocated: 38700000000, real: 2100000000, overcount: 18.43 },
    cloneAnalysis: { families: 1, clonedFiles: 3402, sharedBytes: 9e9, crossTreePartners: ["~/.bun/install/cache"], notes: ["col-fe: du 14 GB → real 3.58 GB"] },
    freeSpace: { total: 1e12, free: 5e11, available: 4.9e11 },
    errors: [],
};

const proc: ProcessReport = {
    id: "2026-05-19T14-03-22Z.41109",
    state: "applied",
    roots: ["/r"],
    startedAt: "2026-05-19T14:03:22.000Z",
    endedAt: "2026-05-19T14:03:25.000Z",
    planCache: { hit: true, ageMs: 1234 },
    ops: [
        { seq: 1, ts: "2026-05-19T14:03:23.000Z", op: "clone", status: "ok", bytes: 1024, keep: "/r/a", replace: "/r/b", modeBefore: 0o644, mtimeBeforeMs: 1, sha256Before: "ab", sha256After: "ab" },
    ],
    totals: { cloned: 1, skipped: 0, errors: 0, bytesReclaimed: 1024 },
};

describe("JsonRenderer", () => {
    it("emits parseable JSON of the exact report object, no glossary", () => {
        const r = new JsonRenderer();
        const out = r.measure(measure);
        expect(SafeJSON.parse(out)).toEqual(measure as unknown as object);
        expect(out).not.toContain(CLONES_GLOSSARY.slice(0, 20));
    });

    it("processReport round-trips; jsonl emits one op per line", () => {
        const r = new JsonRenderer();
        expect(SafeJSON.parse(r.processReport(proc))).toEqual(proc as unknown as object);

        const lines = r.processReportJsonl(proc).trim().split("\n");
        expect(lines.length).toBe(1);
        expect(SafeJSON.parse(lines[0])).toEqual(proc.ops[0] as unknown as object);
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/macos/lib/clones/render/json.test.ts -t "JsonRenderer"`
Expected: FAIL — `Cannot find module '@app/macos/lib/clones/render/json'`.

- [ ] **Step 3: Implement `render/json.ts`**

`src/macos/lib/clones/render/json.ts`:

```typescript
import { SafeJSON } from "@app/utils/json";
import type {
    CloneRenderer,
    DuplicatesReport,
    MeasureReport,
    ProcessListReport,
    ProcessReport,
} from "./types";

export class JsonRenderer implements CloneRenderer {
    measure(r: MeasureReport): string {
        return SafeJSON.stringify(r, null, 2);
    }

    duplicates(r: DuplicatesReport): string {
        return SafeJSON.stringify(r, null, 2);
    }

    processReport(r: ProcessReport): string {
        return SafeJSON.stringify(r, null, 2);
    }

    processList(r: ProcessListReport): string {
        return SafeJSON.stringify(r, null, 2);
    }

    /** `--log --format jsonl`: one ProcessOp object per line (raw stream). */
    processReportJsonl(r: ProcessReport): string {
        return r.ops.map((op) => SafeJSON.stringify(op)).join("\n");
    }
}
```

- [ ] **Step 4: Run the test**

Run: `bun test src/macos/lib/clones/render/json.test.ts -t "JsonRenderer"`
Expected: PASS (round-trips exactly; no glossary substring; jsonl = one op per line).

- [ ] **Step 5: Commit**

```bash
git add src/macos/lib/clones/render/json.ts src/macos/lib/clones/render/json.test.ts
git commit -m "feat(clones): JsonRenderer (SafeJSON report shapes + jsonl ops)"
```

---

### Task 3: `render/table.ts` — TableRenderer (+ glossary footer)

**Files:**
- Create: `src/macos/lib/clones/render/table.ts`
- Create: `src/macos/lib/clones/render/table.test.ts`

`formatTable` from `@app/utils/table` for grids; `picocolors` (`pc`) ONLY for headers/totals/section labels (picocolors auto-disables in non-TTY, so colors strip themselves when piped); appends `CLONES_GLOSSARY` to `measure`/`duplicates` (spec §3, §5, §6, §9). Tree indentation: 2 spaces per `DirNode.depth` in the first column. Uses `formatBytes` from `@app/utils/format` for human sizes.

- [ ] **Step 1: Write the failing test**

`src/macos/lib/clones/render/table.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { stripAnsi } from "@app/utils/string";
import { TableRenderer } from "@app/macos/lib/clones/render/table";
import type { DuplicatesReport, MeasureReport, ProcessReport } from "@app/macos/lib/clones/render/types";

const measure: MeasureReport = {
    roots: ["/projects"],
    nodeModulesMode: true,
    minReal: 10485760,
    tree: [
        {
            path: "/projects/app/node_modules",
            depth: 0,
            logical: 14_000_000_000,
            allocated: 14_000_000_000,
            real: 3_580_000_000,
            overcount: 3.91,
            children: [
                { path: "/projects/app/node_modules/.cache", depth: 1, logical: 2e8, allocated: 2e8, real: 198_000_000, overcount: 1.01, children: [] },
            ],
            sharedNote: "3,402 files cloned from ~/.bun/install/cache → 0 B real",
        },
    ],
    totals: { logical: 14_000_000_000, allocated: 14_000_000_000, real: 3_580_000_000, overcount: 3.91 },
    cloneAnalysis: { families: 2, clonedFiles: 3402, sharedBytes: 1e10, crossTreePartners: ["~/.bun/install/cache"], notes: ["col-fe: du 14 GB → real 3.58 GB (cross-tree)"] },
    freeSpace: { total: 1e12, free: 5e11, available: 4.9e11 },
    errors: [{ path: "/projects/locked", errno: "EPERM" }],
};

const dups: DuplicatesReport = {
    roots: ["/projects"],
    sets: [
        { kind: "dir", what: "app/node_modules/lodash", copies: 3, eachBytes: 1_400_000, reclaimable: 2_800_000, members: ["/a/lodash", "/b/lodash", "/c/lodash"], keep: "/a/lodash" },
    ],
    totalReclaimable: 2_800_000,
    grouped: false,
    hardStop: ["/projects"],
};

const proc: ProcessReport = {
    id: "2026-05-19T14-03-22Z.41109",
    state: "applied",
    roots: ["/projects"],
    startedAt: "2026-05-19T14:03:22.000Z",
    endedAt: "2026-05-19T14:03:25.000Z",
    planCache: { hit: true, ageMs: 60000 },
    ops: [
        { seq: 1, ts: "t", op: "clone", status: "ok", bytes: 1_400_000, keep: "/a/x", replace: "/b/x", modeBefore: 420, mtimeBeforeMs: 1, sha256Before: "abcd", sha256After: "abcd" },
        { seq: 2, ts: "t", op: "skip", status: "already-cloned", bytes: 0, keep: "/a/y", replace: "/b/y", modeBefore: 420, mtimeBeforeMs: 1, sha256Before: "ef" },
        { seq: 3, ts: "t", op: "error", status: "errno:EACCES", bytes: 0, keep: "/a/z", replace: "/b/z", modeBefore: 420, mtimeBeforeMs: 1, sha256Before: "12", message: "permission denied" },
    ],
    totals: { cloned: 1, skipped: 1, errors: 1, bytesReclaimed: 1_400_000 },
};

describe("TableRenderer", () => {
    it("measure: tree rows indented by depth, totals, glossary footer present", () => {
        const out = stripAnsi(new TableRenderer().measure(measure));
        expect(out).toContain("node_modules");
        expect(out).toContain("  .cache"); // depth-1 indented 2 spaces
        expect(out).toContain("cloned from ~/.bun/install/cache"); // sharedNote line
        expect(out).toContain("1 path(s) skipped"); // errors summarised
        expect(out).toContain("ATTR_CMNEXT_PRIVATESIZE"); // glossary footer
    });

    it("duplicates: set rows + reclaim total + glossary", () => {
        const out = stripAnsi(new TableRenderer().duplicates(dups));
        expect(out).toContain("app/node_modules/lodash");
        expect(out).toContain("ATTR_CMNEXT_PRIVATESIZE");
    });

    it("processReport: per-op table + skipped + errors + rollback suggestion, NO glossary", () => {
        const out = stripAnsi(new TableRenderer().processReport(proc));
        expect(out).toContain("clone");
        expect(out).toContain("Skipped");
        expect(out).toContain("already-cloned");
        expect(out).toContain("Errors");
        expect(out).toContain("permission denied");
        expect(out).toContain("tools macos clones optimize --rollback --process 2026-05-19T14-03-22Z.41109");
        expect(out).not.toContain("ATTR_CMNEXT_PRIVATESIZE"); // no glossary on process output
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/macos/lib/clones/render/table.test.ts -t "TableRenderer"`
Expected: FAIL — `Cannot find module '@app/macos/lib/clones/render/table'`.

- [ ] **Step 3: Implement `render/table.ts`**

`src/macos/lib/clones/render/table.ts`:

```typescript
import { formatBytes } from "@app/utils/format";
import { formatTable } from "@app/utils/table";
import pc from "picocolors";
import {
    CLONES_GLOSSARY,
    type CloneRenderer,
    type DirNode,
    type DuplicatesReport,
    type MeasureReport,
    type ProcessListReport,
    type ProcessOp,
    type ProcessReport,
} from "./types";

function realCell(real: number | null): string {
    return real === null ? "unavailable" : formatBytes(real);
}

function overcountCell(oc: number | null): string {
    return oc === null ? "—" : `${oc.toFixed(1)}×`;
}

function flattenTree(nodes: DirNode[], out: DirNode[] = []): DirNode[] {
    for (const n of nodes) {
        out.push(n);
        flattenTree(n.children, out);
    }

    return out;
}

export class TableRenderer implements CloneRenderer {
    measure(r: MeasureReport): string {
        const lines: string[] = [];
        lines.push(pc.bold(`clones measure — ${r.roots.join(", ")}`));
        if (r.nodeModulesMode) {
            lines.push(pc.dim("node_modules focus mode"));
        }

        const rows: string[][] = [];
        for (const n of flattenTree(r.tree)) {
            const indent = "  ".repeat(n.depth);
            const label = `${indent}${n.path.split("/").pop() ?? n.path}`;
            rows.push([
                label,
                formatBytes(n.logical),
                formatBytes(n.allocated),
                realCell(n.real),
                overcountCell(n.overcount),
            ]);
            if (n.sharedNote) {
                rows.push([`${indent}  └ ${n.sharedNote}`, "", "", "", ""]);
            }
        }

        if (rows.length > 0) {
            lines.push(
                formatTable(rows, ["path", "logical", "du -sh", "real", "overcount"], {
                    alignRight: [1, 2, 3, 4],
                    maxColWidth: 60,
                }),
            );
        }

        lines.push("");
        lines.push(
            pc.bold(
                `TOTAL  logical ${formatBytes(r.totals.logical)}  du ${formatBytes(r.totals.allocated)}  ` +
                    `real ${realCell(r.totals.real)}  overcount ${overcountCell(r.totals.overcount)}`,
            ),
        );
        lines.push(
            pc.dim(
                `free space: ${formatBytes(r.freeSpace.available)} available of ${formatBytes(r.freeSpace.total)}`,
            ),
        );

        if (r.cloneAnalysis.families > 0) {
            lines.push("");
            lines.push(pc.bold("clone analysis"));
            lines.push(
                `  ${r.cloneAnalysis.families} family(ies), ${r.cloneAnalysis.clonedFiles} cloned file(s), ` +
                    `${formatBytes(r.cloneAnalysis.sharedBytes)} shared`,
            );
            if (r.cloneAnalysis.crossTreePartners.length > 0) {
                lines.push(`  cross-tree partners: ${r.cloneAnalysis.crossTreePartners.join(", ")}`);
            }

            for (const note of r.cloneAnalysis.notes) {
                lines.push(`  ${note}`);
            }
        }

        if (r.errors.length > 0) {
            lines.push(pc.yellow(`(${r.errors.length} path(s) skipped: ${r.errors[0].errno}…)`));
        }

        lines.push("");
        lines.push(pc.dim(CLONES_GLOSSARY));
        return lines.join("\n");
    }

    duplicates(r: DuplicatesReport): string {
        const lines: string[] = [];
        lines.push(pc.bold(`clones duplicates — ${r.roots.join(", ")}`));
        if (r.sets.length === 0) {
            lines.push(pc.dim("No non-clone duplicates found."));
        } else {
            const rows = r.sets.map((s) => [
                s.kind,
                s.what,
                String(s.copies),
                formatBytes(s.eachBytes),
                formatBytes(s.reclaimable),
            ]);
            lines.push(
                formatTable(rows, ["kind", "what", "copies", "each", "reclaimable"], {
                    alignRight: [2, 3, 4],
                    maxColWidth: 60,
                }),
            );

            if (r.grouped) {
                lines.push("");
                for (const s of r.sets) {
                    lines.push(pc.bold(s.what));
                    for (const m of s.members) {
                        const tag = m === s.keep ? pc.green(" (keep)") : "";
                        lines.push(`  ${m}${tag}`);
                    }
                }
            }
        }

        lines.push("");
        lines.push(pc.bold(`projected reclaim: ${formatBytes(r.totalReclaimable)}`));
        lines.push("");
        lines.push(pc.dim(CLONES_GLOSSARY));
        return lines.join("\n");
    }

    processReport(r: ProcessReport): string {
        const lines: string[] = [];
        lines.push(pc.bold(`clones optimize [${r.state}] — process ${r.id}`));
        lines.push(
            pc.dim(
                `roots: ${r.roots.join(", ")}  plan cache: ` +
                    `${r.planCache.hit ? `hit (${Math.round((r.planCache.ageMs ?? 0) / 1000)}s old)` : "miss"}`,
            ),
        );

        const opRows = r.ops.map((op: ProcessOp) => [
            String(op.seq),
            op.op,
            op.status,
            op.bytes > 0 ? formatBytes(op.bytes) : "",
            op.replace,
        ]);
        if (opRows.length > 0) {
            lines.push(
                formatTable(opRows, ["#", "op", "status", "bytes", "replace"], {
                    alignRight: [3],
                    maxColWidth: 60,
                }),
            );
        }

        const skipped = r.ops.filter((o) => o.op === "skip");
        if (skipped.length > 0) {
            lines.push("");
            lines.push(pc.bold("Skipped:"));
            for (const o of skipped) {
                lines.push(`  ${o.replace} — ${o.status}${o.message ? ` (${o.message})` : ""}`);
            }
        }

        const errored = r.ops.filter((o) => o.op === "error");
        if (errored.length > 0) {
            lines.push("");
            lines.push(pc.red("Errors:"));
            for (const o of errored) {
                lines.push(`  ${o.replace} — ${o.status}${o.message ? ` (${o.message})` : ""}`);
            }
        }

        lines.push("");
        lines.push(
            pc.bold(
                `TOTAL  cloned ${r.totals.cloned}  skipped ${r.totals.skipped}  ` +
                    `errors ${r.totals.errors}  reclaimed ${formatBytes(r.totals.bytesReclaimed)}`,
            ),
        );
        if (r.state === "applied") {
            lines.push(pc.dim(`tools macos clones optimize --rollback --process ${r.id}`));
        }

        return lines.join("\n");
    }

    processList(r: ProcessListReport): string {
        if (r.processes.length === 0) {
            return pc.dim("No optimize runs recorded.");
        }

        const rows = r.processes.map((p) => [
            p.id,
            p.state,
            p.roots.join(","),
            String(p.totals.cloned),
            formatBytes(p.totals.bytesReclaimed),
            p.startedAt,
        ]);
        return formatTable(rows, ["id", "state", "roots", "cloned", "reclaimed", "startedAt"], {
            maxColWidth: 50,
        });
    }
}
```

- [ ] **Step 4: Run the test**

Run: `bun test src/macos/lib/clones/render/table.test.ts -t "TableRenderer"`
Expected: PASS (depth indentation, sharedNote line, error summary, glossary on measure/duplicates, NO glossary on processReport, rollback suggestion present). If `stripAnsi` is not exported from `@app/utils/string`, fall back to a local `const stripAnsi=(s:string)=>s.replace(/\[[0-9;]*m/g,"")` in the test only.

- [ ] **Step 5: Commit**

```bash
git add src/macos/lib/clones/render/table.ts src/macos/lib/clones/render/table.test.ts
git commit -m "feat(clones): TableRenderer (grids + chalk + glossary footer)"
```

---

### Task 4: `render/index.ts` — `resolveRenderer` / `resolveFormat`

**Files:**
- Create: `src/macos/lib/clones/render/index.ts`
- Create: `src/macos/lib/clones/render/index.test.ts`

The single swap point (spec §2, §3). `resolveFormat(flag)` mirrors `src/todo/lib/format.ts`'s `resolveFormat`: `auto` → `table` if `isInteractive()` else `json`. `resolveRenderer(format)` returns a `CloneRenderer` (`jsonl` maps to `JsonRenderer` — its `processReportJsonl` is used directly by `optimize --log`). Re-exports the renderer classes + all types so commands import from one place.

- [ ] **Step 1: Write the failing test**

`src/macos/lib/clones/render/index.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { JsonRenderer } from "@app/macos/lib/clones/render/json";
import { resolveFormat, resolveRenderer } from "@app/macos/lib/clones/render/index";
import { TableRenderer } from "@app/macos/lib/clones/render/table";

describe("resolveFormat", () => {
    it("passes through explicit formats", () => {
        expect(resolveFormat("table")).toBe("table");
        expect(resolveFormat("json")).toBe("json");
        expect(resolveFormat("jsonl")).toBe("jsonl");
    });

    it("auto → table or json (never stays 'auto')", () => {
        const r = resolveFormat("auto");
        expect(r === "table" || r === "json").toBe(true);
    });

    it("undefined behaves like auto", () => {
        const r = resolveFormat(undefined);
        expect(r === "table" || r === "json").toBe(true);
    });
});

describe("resolveRenderer", () => {
    it("table → TableRenderer; json/jsonl → JsonRenderer", () => {
        expect(resolveRenderer("table")).toBeInstanceOf(TableRenderer);
        expect(resolveRenderer("json")).toBeInstanceOf(JsonRenderer);
        expect(resolveRenderer("jsonl")).toBeInstanceOf(JsonRenderer);
    });

    it("auto resolves first, never returns a renderer for literal 'auto'", () => {
        const r = resolveRenderer(resolveFormat("auto"));
        expect(r instanceof TableRenderer || r instanceof JsonRenderer).toBe(true);
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/macos/lib/clones/render/index.test.ts -t "resolveRenderer"`
Expected: FAIL — `Cannot find module '@app/macos/lib/clones/render/index'`.

- [ ] **Step 3: Implement `render/index.ts`**

`src/macos/lib/clones/render/index.ts`:

```typescript
import { isInteractive } from "@app/utils/cli";
import { JsonRenderer } from "./json";
import { TableRenderer } from "./table";
import type { CloneRenderer, Format } from "./types";

export * from "./types";
export { JsonRenderer } from "./json";
export { TableRenderer } from "./table";

/** Resolve a `--format` flag to a concrete format. `auto`/undefined →
 *  `table` when interactive, else `json` (mirrors src/todo/lib/format.ts). */
export function resolveFormat(flag: string | undefined): Exclude<Format, "auto"> {
    if (flag === "table" || flag === "json" || flag === "jsonl") {
        return flag;
    }

    return isInteractive() ? "table" : "json";
}

/** The single renderer swap point. `jsonl` shares JsonRenderer; callers that
 *  need raw op streaming call `(renderer as JsonRenderer).processReportJsonl`. */
export function resolveRenderer(format: Exclude<Format, "auto">): CloneRenderer {
    if (format === "table") {
        return new TableRenderer();
    }

    return new JsonRenderer();
}
```

- [ ] **Step 4: Run the test**

Run: `bun test src/macos/lib/clones/render/index.test.ts -t "resolveRenderer"`
Expected: PASS (explicit pass-through; `auto` never leaks; correct renderer classes).

- [ ] **Step 5: Commit**

```bash
git add src/macos/lib/clones/render/index.ts src/macos/lib/clones/render/index.test.ts
git commit -m "feat(clones): resolveRenderer/resolveFormat swap point"
```

---

### Task 5: `orchestrator.ts` — DirNode tree + MeasureReport

**Files:**
- Create: `src/macos/lib/clones/orchestrator.ts`
- Create: `src/macos/lib/clones/orchestrator.test.ts`

The core builder (spec §1, §5). Builds the per-subdir `DirNode` tree from utils `walkFiles()` + per-file `getPrivateSize()` (NOT `measureTree` — that exposes no per-dir walk; it is used ONLY for per-root `totals`). Implements: roots resolution, `--node-modules` expansion via `find` (NOT `fd`), include/exclude glob filter, the deepest-significant keep rule, pass-through collapse, and `cloneAnalysis`/`freeSpace`/`errors`. Per-dir size definition (spec §5): `real(D) = Σ getPrivateSize(f) for files directly in D + Σ real(childDir)`; `logical`/`allocated` analogously; **own real** of D `= real(D) − Σ real(childDir)`.

- [ ] **Step 1: Write the failing test**

`src/macos/lib/clones/orchestrator.test.ts`:

```typescript
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { skip } from "@app/utils/test/skip";
import { buildMeasureReport, expandNodeModules, resolveRoots } from "@app/macos/lib/clones/orchestrator";

describe("resolveRoots", () => {
    it("explicit roots win; absolute-resolved; falls back to cwd", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-roots-"));
        try {
            expect(resolveRoots([dir], [])).toEqual([dir]);
            expect(resolveRoots([], ["/tmp"])).toEqual(["/tmp"]);
            const fellBack = resolveRoots([], []);
            expect(fellBack).toEqual([process.cwd()]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("expandNodeModules", () => {
    it("finds node_modules dirs and prunes nested ones", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-nm-"));
        try {
            mkdirSync(join(dir, "a", "node_modules", "x"), { recursive: true });
            mkdirSync(join(dir, "b", "node_modules"), { recursive: true });
            const found = expandNodeModules([dir]).sort();
            expect(found).toEqual(
                [join(dir, "a", "node_modules"), join(dir, "b", "node_modules")].sort(),
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe.skipIf(skip.unlessMac)("buildMeasureReport keep rule", () => {
    it("keeps dirs with real>minReal; collapses pass-through; keeps spread-across-small parent", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-meas-"));
        try {
            // big/ : a single child 'heavy' holds ~all the bytes → pass-through (big not its own row, heavy is)
            mkdirSync(join(dir, "big", "heavy"), { recursive: true });
            writeFileSync(join(dir, "big", "heavy", "f.bin"), Buffer.alloc(12 * 1024 * 1024, 1));
            // cache/ : 198 MB spread across many <minReal children → cache IS the deepest-kept
            mkdirSync(join(dir, "cache", "s1"), { recursive: true });
            mkdirSync(join(dir, "cache", "s2"), { recursive: true });
            writeFileSync(join(dir, "cache", "s1", "a"), Buffer.alloc(6 * 1024 * 1024, 2));
            writeFileSync(join(dir, "cache", "s2", "b"), Buffer.alloc(6 * 1024 * 1024, 3));
            // tiny/ : below minReal → not kept at all
            mkdirSync(join(dir, "tiny"), { recursive: true });
            writeFileSync(join(dir, "tiny", "t"), Buffer.alloc(1024, 4));

            const rep = buildMeasureReport({ roots: [dir], minReal: 10 * 1024 * 1024, breakdown: true });
            expect(rep.roots).toEqual([dir]);
            const paths = JSON.stringify(rep.tree);
            expect(paths).toContain("heavy"); // pass-through kept the deep child
            expect(paths).not.toMatch(/"path":"[^"]*\/big"/); // 'big' collapsed (single dominant child)
            expect(paths).toContain("cache"); // own-real spread keeps cache
            expect(paths).not.toContain("tiny"); // below minReal
            expect(rep.totals.real === null || rep.totals.real >= 0).toBe(true);
            expect(rep.freeSpace.total).toBeGreaterThan(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("--no-breakdown emits totals + cloneAnalysis only (empty tree)", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-nb-"));
        try {
            mkdirSync(join(dir, "sub"), { recursive: true });
            writeFileSync(join(dir, "sub", "f"), Buffer.alloc(20 * 1024 * 1024, 1));
            const rep = buildMeasureReport({ roots: [dir], minReal: 1024, breakdown: false });
            expect(rep.tree).toEqual([]);
            expect(rep.totals.logical).toBeGreaterThan(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("include/exclude globs filter by relpath OR basename; exclude wins", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-glob-"));
        try {
            mkdirSync(join(dir, "keepme"), { recursive: true });
            mkdirSync(join(dir, "dropme"), { recursive: true });
            writeFileSync(join(dir, "keepme", "a"), Buffer.alloc(20 * 1024 * 1024, 1));
            writeFileSync(join(dir, "dropme", "b"), Buffer.alloc(20 * 1024 * 1024, 2));
            const rep = buildMeasureReport({
                roots: [dir],
                minReal: 1024,
                breakdown: true,
                exclude: ["dropme"],
            });
            const s = JSON.stringify(rep.tree);
            expect(s).toContain("keepme");
            expect(s).not.toContain("dropme");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/macos/lib/clones/orchestrator.test.ts -t "resolveRoots"`
Expected: FAIL — `Cannot find module '@app/macos/lib/clones/orchestrator'`.

- [ ] **Step 3: Implement `orchestrator.ts`**

`src/macos/lib/clones/orchestrator.ts`:

```typescript
import { execFileSync } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import logger from "@app/logger";
import { getPrivateSize } from "@app/utils/macos/apfs";
import {
    type DiskUsage,
    findCloneFamilies,
    freeDiskSpace,
    measureTree,
    walkFiles,
} from "@app/utils/fs/disk-usage";
import { matchGlob } from "@app/utils/string";
import type { CloneAnalysis, DirNode, MeasureReport } from "./render/types";

const log = logger.child({ component: "clones:orchestrator" });

export interface BuildMeasureArgs {
    roots: string[];
    minReal: number;
    breakdown: boolean;
    include?: string[];
    exclude?: string[];
    sort?: "overcount" | "real" | "du";
    maxDepth?: number;
}

/** Resolve scan roots: explicit → configured watchedDirs → cwd (spec §1). */
export function resolveRoots(explicit: string[], watchedDirs: string[]): string[] {
    if (explicit.length > 0) {
        return explicit.map((p) => resolve(p));
    }

    if (watchedDirs.length > 0) {
        return watchedDirs.map((p) => resolve(p));
    }

    return [process.cwd()];
}

/** Expand each root to its node_modules dirs via `find -prune` (NOT fd —
 *  node_modules is gitignored; fd skips it). Spec §1. */
export function expandNodeModules(roots: string[]): string[] {
    const out: string[] = [];
    for (const root of roots) {
        try {
            const stdout = execFileSync(
                "find",
                [root, "-type", "d", "-name", "node_modules", "-prune"],
                { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
            );
            for (const line of stdout.split("\n")) {
                const p = line.trim();
                if (p.length > 0) {
                    out.push(p);
                }
            }
        } catch (err) {
            log.warn({ err, root }, "node_modules expansion failed");
        }
    }

    return out;
}

interface MutNode {
    path: string;
    depth: number;
    logical: number;
    allocated: number;
    real: number | null;
    realSeen: boolean;
    children: Map<string, MutNode>;
}

function emptyNode(path: string, depth: number): MutNode {
    return { path, depth, logical: 0, allocated: 0, real: 0, realSeen: false, children: new Map() };
}

function passesGlobs(rel: string, base: string, include?: string[], exclude?: string[]): boolean {
    if (exclude && exclude.some((g) => matchGlob(rel, g) || matchGlob(base, g))) {
        return false;
    }

    if (include && include.length > 0) {
        return include.some((g) => matchGlob(rel, g) || matchGlob(base, g));
    }

    return true;
}

function buildRootTree(root: string, args: BuildMeasureArgs): MutNode {
    const rootNode = emptyNode(root, 0);
    for (const e of walkFiles(root, { onError: (err) => log.debug({ err }, "walk error") })) {
        const rel = relative(root, e.path);
        if (!passesGlobs(rel, e.path.split("/").pop() ?? "", args.include, args.exclude)) {
            continue;
        }

        const parts = dirname(rel) === "." ? [] : dirname(rel).split("/");
        if (args.maxDepth !== undefined && parts.length > args.maxDepth) {
            continue;
        }

        const priv = getPrivateSize(e.path);
        let node = rootNode;
        node.logical += e.logical;
        node.allocated += e.allocated;
        if (priv !== null) {
            node.real = (node.real ?? 0) + priv;
            node.realSeen = true;
        }

        let acc = root;
        let depth = 0;
        for (const part of parts) {
            acc = `${acc}/${part}`;
            depth += 1;
            let child = node.children.get(part);
            if (!child) {
                child = emptyNode(acc, depth);
                node.children.set(part, child);
            }

            child.logical += e.logical;
            child.allocated += e.allocated;
            if (priv !== null) {
                child.real = (child.real ?? 0) + priv;
                child.realSeen = true;
            }

            node = child;
        }
    }

    return rootNode;
}

/** Deepest-significant keep rule (spec §5): keep D iff real(D) > minReal;
 *  if a single kept child C has real(C) >= 0.9*real(D), D is pass-through
 *  (its child replaces it). A dir is kept when its OWN real > minReal even
 *  if no single child is. */
function pruneTree(node: MutNode, minReal: number): DirNode[] {
    const keptChildren: DirNode[] = [];
    for (const child of node.children.values()) {
        keptChildren.push(...pruneTree(child, minReal));
    }

    const real = node.realSeen ? (node.real ?? 0) : null;
    const childRealSum = keptChildren.reduce((s, c) => s + (c.real ?? 0), 0);
    const ownReal = real === null ? null : real - childRealSum;
    const significant = real !== null && real > minReal;
    const ownSignificant = ownReal !== null && ownReal > minReal;

    if (!significant && keptChildren.length === 0) {
        return [];
    }

    const dominant =
        real !== null &&
        real > 0 &&
        keptChildren.length === 1 &&
        (keptChildren[0].real ?? 0) >= 0.9 * real;
    if (dominant && !ownSignificant) {
        return keptChildren;
    }

    if (!significant && !ownSignificant) {
        return keptChildren;
    }

    const overcount =
        real !== null && real > 0 ? node.allocated / real : real === 0 ? 1 : null;
    return [
        {
            path: node.path,
            depth: node.depth,
            logical: node.logical,
            allocated: node.allocated,
            real,
            overcount,
            children: keptChildren.map((c) => ({ ...c, depth: c.depth })),
        },
    ];
}

function buildCloneAnalysis(roots: string[]): CloneAnalysis {
    let families = 0;
    let clonedFiles = 0;
    const partners = new Set<string>();
    for (const root of roots) {
        const fams = findCloneFamilies(root);
        families += fams.size;
        for (const members of fams.values()) {
            clonedFiles += members.length;
            for (const m of members) {
                if (!roots.some((r) => m.startsWith(r))) {
                    partners.add(dirname(m));
                }
            }
        }
    }

    return {
        families,
        clonedFiles,
        sharedBytes: 0,
        crossTreePartners: [...partners],
        notes: [],
    };
}

function sortTree(nodes: DirNode[], by: "overcount" | "real" | "du"): DirNode[] {
    const key = (n: DirNode): number =>
        by === "real" ? (n.real ?? -1) : by === "du" ? n.allocated : (n.overcount ?? -1);
    return [...nodes]
        .sort((a, b) => key(b) - key(a))
        .map((n) => ({ ...n, children: sortTree(n.children, by) }));
}

export function buildMeasureReport(args: BuildMeasureArgs): MeasureReport {
    const totalsAgg: DiskUsage = {
        logical: 0,
        allocated: 0,
        private: null,
        exactReclaimable: null,
        fileCount: 0,
        dirCount: 0,
        errors: [],
    };
    let realSeen = false;
    const tree: DirNode[] = [];

    for (const root of args.roots) {
        const u = measureTree(root);
        totalsAgg.logical += u.logical;
        totalsAgg.allocated += u.allocated;
        if (u.private !== null) {
            realSeen = true;
            totalsAgg.private = (totalsAgg.private ?? 0) + u.private;
        }

        totalsAgg.errors.push(...u.errors);

        if (args.breakdown) {
            const rootMut = buildRootTree(root, args);
            tree.push(...pruneTree(rootMut, args.minReal));
        }
    }

    const totalReal = realSeen ? totalsAgg.private : null;
    const totalOvercount =
        totalReal !== null && totalReal > 0 ? totalsAgg.allocated / totalReal : null;
    const fs = freeDiskSpace(args.roots[0]);
    const sorted = args.breakdown ? sortTree(tree, args.sort ?? "overcount") : [];

    return {
        roots: args.roots,
        nodeModulesMode: false,
        minReal: args.minReal,
        tree: sorted,
        totals: {
            logical: totalsAgg.logical,
            allocated: totalsAgg.allocated,
            real: totalReal,
            overcount: totalOvercount,
        },
        cloneAnalysis: buildCloneAnalysis(args.roots),
        freeSpace: { total: fs.total, free: fs.free, available: fs.available },
        errors: totalsAgg.errors.map((e) => ({ path: e.path, errno: e.errno })),
    };
}
```

- [ ] **Step 4: Run the test**

Run: `bun test src/macos/lib/clones/orchestrator.test.ts 2>&1 | tee /tmp/clones-orch.log | tail -30`
Expected: PASS — `resolveRoots`/`expandNodeModules` pass on all platforms; the keep-rule blocks pass on macOS (pass-through collapses `big`, keeps `heavy`; spread keeps `cache`; `tiny` dropped; `--no-breakdown` → empty tree; exclude removes `dropme`). Skipped off-macOS.

- [ ] **Step 5: Commit**

```bash
git add src/macos/lib/clones/orchestrator.ts src/macos/lib/clones/orchestrator.test.ts
git commit -m "feat(clones): orchestrator — DirNode tree + MeasureReport"
```

---

### Task 6: `measure.ts` — the `measure` command

**Files:**
- Create: `src/macos/commands/clones/measure.ts`
- Create: `src/macos/commands/clones/measure.test.ts`

Thin controller (spec §1, §2, §5): parse the shared flags, resolve roots (from `store.ts` watchedDirs once Task 17 lands — until then `[]`), optionally `expandNodeModules`, call `buildMeasureReport`, render. `--node-modules`, `--min-real`, `--top`, `--no-breakdown`, `--include`, `--exclude`, `--sort`, `--format`. This task wires `createMeasureCommand()` returning a `commander` `Command` (registered by Task 20's `index.ts`).

- [ ] **Step 1: Write the failing test**

`src/macos/commands/clones/measure.test.ts`:

```typescript
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { SafeJSON } from "@app/utils/json";
import { createMeasureCommand } from "@app/macos/commands/clones/measure";

describe("createMeasureCommand", () => {
    it("is a commander command named 'measure' with the shared flags", () => {
        const cmd = createMeasureCommand();
        expect(cmd.name()).toBe("measure");
        const opts = cmd.options.map((o) => o.long);
        expect(opts).toContain("--format");
        expect(opts).toContain("--node-modules");
        expect(opts).toContain("--min-real");
        expect(opts).toContain("--top");
        expect(opts).toContain("--no-breakdown");
        expect(opts).toContain("--include");
        expect(opts).toContain("--exclude");
        expect(opts).toContain("--sort");
    });

    it("--format json prints a parseable MeasureReport for a temp dir", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-mcmd-"));
        try {
            mkdirSync(join(dir, "s"), { recursive: true });
            writeFileSync(join(dir, "s", "f"), Buffer.alloc(20 * 1024 * 1024, 1));
            const logs: string[] = [];
            const orig = console.log;
            console.log = (...a: unknown[]) => logs.push(a.join(" "));
            try {
                await createMeasureCommand().parseAsync(
                    ["node", "measure", dir, "--format", "json", "--min-real", "1024"],
                    { from: "node" },
                );
            } finally {
                console.log = orig;
            }

            const parsed = SafeJSON.parse(logs.join("\n"));
            expect(parsed).toHaveProperty("totals");
            expect(parsed).toHaveProperty("roots");
            expect((parsed as { roots: string[] }).roots[0]).toBe(dir);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/macos/commands/clones/measure.test.ts -t "createMeasureCommand"`
Expected: FAIL — `Cannot find module '@app/macos/commands/clones/measure'`.

- [ ] **Step 3: Implement `measure.ts`**

`src/macos/commands/clones/measure.ts`:

```typescript
import logger from "@app/logger";
import { buildMeasureReport, expandNodeModules, resolveRoots } from "@app/macos/lib/clones/orchestrator";
import { resolveFormat, resolveRenderer } from "@app/macos/lib/clones/render/index";
import { parseVariadic } from "@app/utils/cli";
import { Command, Option } from "commander";

const log = logger.child({ component: "clones:measure-cmd" });

function collect(value: string, previous: string[]): string[] {
    return [...previous, value];
}

interface MeasureOpts {
    format?: string;
    nodeModules?: boolean;
    minReal: string;
    top?: string;
    breakdown: boolean;
    include: string[];
    exclude: string[];
    sort?: string;
    verbose?: boolean;
    silent?: boolean;
}

export function applySharedMeasureFlags(cmd: Command): Command {
    return cmd
        .addOption(
            new Option("--format <format>", "Output format").choices(["auto", "table", "json", "jsonl"]).default("auto"),
        )
        .option("--node-modules", "Expand each root to its node_modules dirs", false)
        .option("--min-real <bytes>", "Hide subtrees whose real size is below this", "10485760")
        .option("--top <N>", "Show only the top N rows (default: unlimited)")
        .option("--no-breakdown", "Totals + clone analysis only (no per-dir tree)")
        .option("--include <glob>", "Include glob (repeatable)", collect, [])
        .option("--exclude <glob>", "Exclude glob (repeatable, wins over --include)", collect, [])
        .option("-v, --verbose", "Verbose logging", false)
        .option("--silent", "Suppress non-essential output", false);
}

export function createMeasureCommand(): Command {
    const cmd = new Command("measure")
        .description("Clone-aware sizes for one or more roots (breakdown by default)")
        .argument("[roots...]", "Roots to measure (default: configured watchedDirs, else cwd)");
    applySharedMeasureFlags(cmd).addOption(
        new Option("--sort <by>", "Sort rows").choices(["overcount", "real", "du"]).default("overcount"),
    );
    cmd.action(async (rootsArg: string[], opts: MeasureOpts) => {
        const minReal = Number.parseInt(opts.minReal, 10);
        const roots0 = resolveRoots(rootsArg ?? [], []);
        const roots = opts.nodeModules ? expandNodeModules(roots0) : roots0;
        if (roots.length === 0) {
            log.warn("no roots resolved");
            console.error("No roots to measure.");
            process.exit(2);
        }

        const report = buildMeasureReport({
            roots,
            minReal: Number.isNaN(minReal) ? 10485760 : minReal,
            breakdown: opts.breakdown,
            include: parseVariadic(opts.include),
            exclude: parseVariadic(opts.exclude),
            sort: (opts.sort as "overcount" | "real" | "du") ?? "overcount",
        });
        report.nodeModulesMode = Boolean(opts.nodeModules);

        if (opts.top) {
            const n = Number.parseInt(opts.top, 10);
            if (!Number.isNaN(n) && n > 0) {
                report.tree = report.tree.slice(0, n);
            }
        }

        const fmt = resolveFormat(opts.format);
        console.log(resolveRenderer(fmt).measure(report));

        const wholeRootUnreadable =
            report.errors.length > 0 && report.totals.logical === 0;
        process.exitCode = wholeRootUnreadable ? 2 : 0;
    });

    return cmd;
}
```

- [ ] **Step 4: Run the test**

Run: `bun test src/macos/commands/clones/measure.test.ts -t "createMeasureCommand"`
Expected: PASS (command named `measure`, all shared flags present, `--format json` prints a parseable report with `roots[0]===dir`).

- [ ] **Step 5: Commit**

```bash
git add src/macos/commands/clones/measure.ts src/macos/commands/clones/measure.test.ts
git commit -m "feat(clones): measure command (shared flags + render)"
```

---

### Task 7: `du` command (depth-limited measure rooted at one folder)

**Files:**
- Modify: `src/macos/commands/clones/measure.ts` (add `createDuCommand()`)
- Modify: `src/macos/commands/clones/measure.test.ts` (append cases)

`du` = the same `buildMeasureReport` algorithm rooted at ONE folder (default cwd) with a `--depth N` cap (default unlimited) — spec §1, §5. Shares the rendered output; reuses `applySharedMeasureFlags`. The depth cap maps to `BuildMeasureArgs.maxDepth`.

- [ ] **Step 1: Write the failing test**

Append to `src/macos/commands/clones/measure.test.ts`:

```typescript
import { createDuCommand } from "@app/macos/commands/clones/measure";

describe("createDuCommand", () => {
    it("named 'du', has --depth, single optional folder arg", () => {
        const cmd = createDuCommand();
        expect(cmd.name()).toBe("du");
        expect(cmd.options.map((o) => o.long)).toContain("--depth");
        expect(cmd.options.map((o) => o.long)).toContain("--format");
    });

    it("--depth 1 limits tree nesting; json parseable", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-du-"));
        try {
            mkdirSync(join(dir, "l1", "l2", "l3"), { recursive: true });
            writeFileSync(join(dir, "l1", "l2", "l3", "f"), Buffer.alloc(20 * 1024 * 1024, 1));
            const logs: string[] = [];
            const orig = console.log;
            console.log = (...a: unknown[]) => logs.push(a.join(" "));
            try {
                await createDuCommand().parseAsync(
                    ["node", "du", dir, "--depth", "1", "--format", "json", "--min-real", "1024"],
                    { from: "node" },
                );
            } finally {
                console.log = orig;
            }

            const parsed = SafeJSON.parse(logs.join("\n")) as { roots: string[] };
            expect(parsed.roots[0]).toBe(dir);
            // depth 1 → no path nests beyond one level below the root
            expect(logs.join("\n")).not.toContain("/l1/l2/l3");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/macos/commands/clones/measure.test.ts -t "createDuCommand"`
Expected: FAIL — `createDuCommand is not exported`.

- [ ] **Step 3: Implement `createDuCommand`**

Append to `src/macos/commands/clones/measure.ts` (add `resolve` to a new `node:path` import at top of file):

```typescript
import { resolve } from "node:path";

interface DuOpts extends MeasureOpts {
    depth?: string;
}

export function createDuCommand(): Command {
    const cmd = new Command("du")
        .description("Clone-aware du: measure one folder deeply, depth-limited")
        .argument("[folder]", "Folder to measure (default: cwd)");
    applySharedMeasureFlags(cmd)
        .addOption(
            new Option("--sort <by>", "Sort rows").choices(["overcount", "real", "du"]).default("overcount"),
        )
        .option("--depth <N>", "Max tree depth below the folder (default: unlimited)");
    cmd.action(async (folderArg: string | undefined, opts: DuOpts) => {
        const folder = resolve(folderArg ?? process.cwd());
        const minReal = Number.parseInt(opts.minReal, 10);
        const depth = opts.depth ? Number.parseInt(opts.depth, 10) : undefined;

        const report = buildMeasureReport({
            roots: [folder],
            minReal: Number.isNaN(minReal) ? 10485760 : minReal,
            breakdown: opts.breakdown,
            include: parseVariadic(opts.include),
            exclude: parseVariadic(opts.exclude),
            sort: (opts.sort as "overcount" | "real" | "du") ?? "overcount",
            maxDepth: depth !== undefined && !Number.isNaN(depth) ? depth : undefined,
        });

        if (opts.top) {
            const n = Number.parseInt(opts.top, 10);
            if (!Number.isNaN(n) && n > 0) {
                report.tree = report.tree.slice(0, n);
            }
        }

        const fmt = resolveFormat(opts.format);
        console.log(resolveRenderer(fmt).measure(report));
        process.exitCode = report.errors.length > 0 && report.totals.logical === 0 ? 2 : 0;
    });

    return cmd;
}
```

- [ ] **Step 4: Run the test**

Run: `bun test src/macos/commands/clones/measure.test.ts -t "createDuCommand"`
Expected: PASS (named `du`, `--depth` present, depth-1 tree never contains the `/l1/l2/l3` path).

- [ ] **Step 5: Commit**

```bash
git add src/macos/commands/clones/measure.ts src/macos/commands/clones/measure.test.ts
git commit -m "feat(clones): du command (depth-limited single-folder measure)"
```

---

### Task 8: `collapse.ts` — duplicate folder-collapse algorithm

**Files:**
- Create: `src/macos/lib/clones/collapse.ts`
- Create: `src/macos/lib/clones/collapse.test.ts`

The §6 algorithm. Uses utils `findDuplicateFiles(root)` for file-level groups (already clone-aware), then rolls dirs up to whole-dir duplicates. **Mandatory perf:** memoise the per-file sha (`path→sha`) from `findDuplicateFiles` — never re-hash; **cheap-reject first** by recursive file count before any dir-hash. **HARD STOP at scan roots:** never test or ascend above any path in `roots`. Emits `DuplicateSet[]` collapsed to the highest whole-dir duplicate (else deepest shared subtree, else individual files); `keep` = lexically-first stable pick; `what` = label relative to the common ancestor of roots.

- [ ] **Step 1: Write the failing test**

`src/macos/lib/clones/collapse.test.ts`:

```typescript
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { collapseDuplicates } from "@app/macos/lib/clones/collapse";

function tree(base: string, name: string): void {
    mkdirSync(join(base, name, "lib"), { recursive: true });
    writeFileSync(join(base, name, "index.js"), Buffer.alloc(50_000, 1));
    writeFileSync(join(base, name, "lib", "a.js"), Buffer.alloc(40_000, 2));
}

describe("collapseDuplicates", () => {
    it("rolls identical dirs up to the whole-dir duplicate (not per-file)", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-coll-"));
        try {
            mkdirSync(join(dir, "p1"), { recursive: true });
            mkdirSync(join(dir, "p2"), { recursive: true });
            tree(join(dir, "p1"), "dep");
            tree(join(dir, "p2"), "dep");

            const report = collapseDuplicates({ roots: [dir] });
            expect(report.sets.length).toBe(1);
            const set = report.sets[0];
            expect(set.kind).toBe("dir");
            expect(set.copies).toBe(2);
            expect(set.what).toContain("dep");
            expect(set.members.sort()).toEqual([join(dir, "p1", "dep"), join(dir, "p2", "dep")].sort());
            expect(set.keep).toBe([join(dir, "p1", "dep"), join(dir, "p2", "dep")].sort()[0]);
            expect(set.reclaimable).toBe(set.eachBytes); // (2-1)*each
            expect(report.totalReclaimable).toBe(set.reclaimable);
            expect(report.hardStop).toEqual([dir]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("HARD STOP: never ascends above a scan root even when parent dirs match", () => {
        const outer = mkdtempSync(join(tmpdir(), "gt-cl-hs-"));
        try {
            // outer/shared/{r1,r2} where r1 and r2 are byte-identical subtrees.
            // Scanning r1 and r2 as roots must NOT collapse up to outer/shared.
            mkdirSync(join(outer, "shared", "r1"), { recursive: true });
            mkdirSync(join(outer, "shared", "r2"), { recursive: true });
            tree(join(outer, "shared", "r1"), "x");
            tree(join(outer, "shared", "r2"), "x");
            const r1 = join(outer, "shared", "r1");
            const r2 = join(outer, "shared", "r2");

            const report = collapseDuplicates({ roots: [r1, r2] });
            const allPaths = report.sets.flatMap((s) => [s.what, ...s.members]).join("|");
            // no emitted path is the scan root itself or an ancestor of it
            expect(allPaths).not.toContain(`${join(outer, "shared")}|`);
            for (const s of report.sets) {
                for (const m of s.members) {
                    expect(m.startsWith(r1) || m.startsWith(r2)).toBe(true);
                }
            }
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("count cheap-reject: dirs with different file counts are never whole-dir dupes", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-cr-"));
        try {
            mkdirSync(join(dir, "a"), { recursive: true });
            mkdirSync(join(dir, "b"), { recursive: true });
            writeFileSync(join(dir, "a", "f1"), Buffer.alloc(30_000, 9));
            writeFileSync(join(dir, "b", "f1"), Buffer.alloc(30_000, 9)); // same content
            writeFileSync(join(dir, "b", "extra"), Buffer.alloc(10, 1));   // b has +1 file
            const report = collapseDuplicates({ roots: [dir] });
            // a/ and b/ differ in count → not a dir set; only the file f1 collapses
            const dirSets = report.sets.filter((s) => s.kind === "dir");
            expect(dirSets.length).toBe(0);
            expect(report.sets.some((s) => s.kind === "file")).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/macos/lib/clones/collapse.test.ts -t "collapseDuplicates"`
Expected: FAIL — `Cannot find module '@app/macos/lib/clones/collapse'`.

- [ ] **Step 3: Implement `collapse.ts`**

`src/macos/lib/clones/collapse.ts`:

```typescript
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import logger from "@app/logger";
import { findDuplicateFiles } from "@app/utils/fs/disk-usage";
import type { DuplicateSet, DuplicatesReport } from "./render/types";

const log = logger.child({ component: "clones:collapse" });

export interface CollapseArgs {
    roots: string[];
}

interface DirInfo {
    fileCount: number;
    hash: string | null;
    bytes: number;
}

function commonAncestor(paths: string[]): string {
    if (paths.length === 0) {
        return "/";
    }

    const split = paths.map((p) => p.split(sep));
    const first = split[0];
    let i = 0;
    for (; i < first.length; i++) {
        if (!split.every((s) => s[i] === first[i])) {
            break;
        }
    }

    return first.slice(0, i).join(sep) || "/";
}

/** Recursively gather every regular file under `dir` (no symlinks), with a
 *  memoised sha map reused from findDuplicateFiles. */
function listFiles(dir: string): string[] {
    const out: string[] = [];
    let entries: ReturnType<typeof readdirSync>;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        log.debug({ err, dir }, "listFiles read failed");
        return out;
    }

    for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isSymbolicLink()) {
            continue;
        }

        if (e.isDirectory()) {
            out.push(...listFiles(p));
        } else if (e.isFile()) {
            out.push(p);
        }
    }

    return out;
}

function dirInfo(dir: string, shaOf: Map<string, string>, sizeOf: Map<string, number>): DirInfo {
    const files = listFiles(dir).sort();
    let bytes = 0;
    const h = createHash("sha256");
    for (const f of files) {
        const sha = shaOf.get(f);
        if (sha === undefined) {
            return { fileCount: files.length, hash: null, bytes };
        }

        const size = sizeOf.get(f) ?? statSync(f).size;
        bytes += size;
        h.update(relative(dir, f));
        h.update("\0");
        h.update(sha);
        h.update("\0");
    }

    return { fileCount: files.length, hash: h.digest("hex"), bytes };
}

function isAtOrAboveRoot(dir: string, roots: string[]): boolean {
    return roots.some((root) => dir === root || !relative(dir, root).startsWith(".."));
}

export function collapseDuplicates({ roots }: CollapseArgs): DuplicatesReport {
    const shaOf = new Map<string, string>();
    const sizeOf = new Map<string, number>();
    const fileGroups: { sha256: string; size: number; paths: string[] }[] = [];

    for (const root of roots) {
        for (const g of findDuplicateFiles(root)) {
            for (const p of g.paths) {
                shaOf.set(p, g.sha256);
                sizeOf.set(p, g.size);
            }

            fileGroups.push({ sha256: g.sha256, size: g.size, paths: g.paths });
        }
    }

    const dirCache = new Map<string, DirInfo>();
    const infoFor = (dir: string): DirInfo => {
        const cached = dirCache.get(dir);
        if (cached) {
            return cached;
        }

        const info = dirInfo(dir, shaOf, sizeOf);
        dirCache.set(dir, info);
        return info;
    };

    const consumed = new Set<string>();
    const sets: DuplicateSet[] = [];
    const ancestor = commonAncestor(roots);

    // Try to roll each duplicate-file pair up to the highest whole-dir dup.
    for (const g of fileGroups) {
        if (g.paths.some((p) => consumed.has(p))) {
            continue;
        }

        let bestDirs: string[] | null = null;
        let bestInfo: DirInfo | null = null;
        let cursor = g.paths.map((p) => dirname(p));

        while (cursor.every((d) => !isAtOrAboveRoot(d, roots))) {
            const infos = cursor.map(infoFor);
            const counts = new Set(infos.map((i) => i.fileCount));
            const hashes = new Set(infos.map((i) => i.hash ?? `__null:${Math.random()}`));
            // cheap reject: counts must all match before trusting hashes
            if (counts.size === 1 && hashes.size === 1 && infos[0].hash !== null) {
                bestDirs = [...cursor];
                bestInfo = infos[0];
                cursor = cursor.map((d) => dirname(d));
                continue;
            }

            break;
        }

        if (bestDirs && bestInfo) {
            const members = [...new Set(bestDirs)].sort();
            if (members.length >= 2) {
                for (const m of members) {
                    for (const f of listFiles(m)) {
                        consumed.add(f);
                    }
                }

                sets.push({
                    kind: "dir",
                    what: relative(ancestor, members[0]) || members[0],
                    copies: members.length,
                    eachBytes: bestInfo.bytes,
                    reclaimable: (members.length - 1) * bestInfo.bytes,
                    members,
                    keep: members[0],
                });
                continue;
            }
        }
    }

    // Remaining duplicate files that did not collapse into a whole-dir set.
    for (const g of fileGroups) {
        const remaining = g.paths.filter((p) => !consumed.has(p)).sort();
        if (remaining.length < 2) {
            continue;
        }

        for (const p of remaining) {
            consumed.add(p);
        }

        sets.push({
            kind: "file",
            what: relative(ancestor, remaining[0]) || remaining[0],
            copies: remaining.length,
            eachBytes: g.size,
            reclaimable: (remaining.length - 1) * g.size,
            members: remaining,
            keep: remaining[0],
        });
    }

    const totalReclaimable = sets.reduce((s, x) => s + x.reclaimable, 0);
    return { roots, sets, totalReclaimable, grouped: false, hardStop: roots };
}
```

- [ ] **Step 4: Run the test**

Run: `bun test src/macos/lib/clones/collapse.test.ts -t "collapseDuplicates"`
Expected: PASS — whole-dir `dep` collapses to one `kind:"dir"` set with `reclaimable=eachBytes`; HARD STOP keeps every member under a scan root (never `outer/shared`); count-mismatch dirs never become a dir set (only the shared file collapses).

- [ ] **Step 5: Commit**

```bash
git add src/macos/lib/clones/collapse.ts src/macos/lib/clones/collapse.test.ts
git commit -m "feat(clones): collapse — folder rollup, hard-stop, count cheap-reject"
```

---

### Task 9: `duplicates.ts` — the `duplicates` command (+ `--group`)

**Files:**
- Create: `src/macos/commands/clones/duplicates.ts`
- Create: `src/macos/commands/clones/duplicates.test.ts`

Thin controller (spec §1, §2, §6): resolve roots, optionally `expandNodeModules`, `collapseDuplicates`, set `grouped` from `--group`, render. Reuses the shared `--format`/`--node-modules`/`--include`/`--exclude`/`--top`/`--silent`/`-v` flags (a subset is enough — `duplicates` has no `--min-real`/`--breakdown`/`--sort`). `--group` makes the renderer list every member.

- [ ] **Step 1: Write the failing test**

`src/macos/commands/clones/duplicates.test.ts`:

```typescript
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { SafeJSON } from "@app/utils/json";
import { createDuplicatesCommand } from "@app/macos/commands/clones/duplicates";

describe("createDuplicatesCommand", () => {
    it("named 'duplicates' with --group and --format", () => {
        const cmd = createDuplicatesCommand();
        expect(cmd.name()).toBe("duplicates");
        const longs = cmd.options.map((o) => o.long);
        expect(longs).toContain("--group");
        expect(longs).toContain("--format");
        expect(longs).toContain("--node-modules");
    });

    it("--group json sets grouped:true and emits members", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-dupcmd-"));
        try {
            mkdirSync(join(dir, "a"), { recursive: true });
            mkdirSync(join(dir, "b"), { recursive: true });
            writeFileSync(join(dir, "a", "f"), Buffer.alloc(70_000, 1));
            writeFileSync(join(dir, "b", "f"), Buffer.alloc(70_000, 1));
            const logs: string[] = [];
            const orig = console.log;
            console.log = (...a: unknown[]) => logs.push(a.join(" "));
            try {
                await createDuplicatesCommand().parseAsync(
                    ["node", "duplicates", dir, "--group", "--format", "json"],
                    { from: "node" },
                );
            } finally {
                console.log = orig;
            }

            const parsed = SafeJSON.parse(logs.join("\n")) as {
                grouped: boolean;
                sets: { members: string[] }[];
            };
            expect(parsed.grouped).toBe(true);
            expect(parsed.sets.length).toBeGreaterThan(0);
            expect(parsed.sets[0].members.length).toBe(2);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/macos/commands/clones/duplicates.test.ts -t "createDuplicatesCommand"`
Expected: FAIL — `Cannot find module '@app/macos/commands/clones/duplicates'`.

- [ ] **Step 3: Implement `duplicates.ts`**

`src/macos/commands/clones/duplicates.ts`:

```typescript
import logger from "@app/logger";
import { collapseDuplicates } from "@app/macos/lib/clones/collapse";
import { expandNodeModules, resolveRoots } from "@app/macos/lib/clones/orchestrator";
import { resolveFormat, resolveRenderer } from "@app/macos/lib/clones/render/index";
import { Command, Option } from "commander";

const log = logger.child({ component: "clones:duplicates-cmd" });

function collect(value: string, previous: string[]): string[] {
    return [...previous, value];
}

interface DuplicatesOpts {
    format?: string;
    group?: boolean;
    nodeModules?: boolean;
    include: string[];
    exclude: string[];
    top?: string;
    verbose?: boolean;
    silent?: boolean;
}

export function createDuplicatesCommand(): Command {
    const cmd = new Command("duplicates")
        .description("Content-identical files/dirs that are NOT yet clones (folder-collapsed)")
        .argument("[roots...]", "Roots to scan (default: configured watchedDirs, else cwd)")
        .addOption(
            new Option("--format <format>", "Output format").choices(["auto", "table", "json", "jsonl"]).default("auto"),
        )
        .option("--group", "List every member path under each set", false)
        .option("--node-modules", "Expand each root to its node_modules dirs", false)
        .option("--include <glob>", "Include glob (repeatable)", collect, [])
        .option("--exclude <glob>", "Exclude glob (repeatable, wins over --include)", collect, [])
        .option("--top <N>", "Show only the top N sets (default: unlimited)")
        .option("-v, --verbose", "Verbose logging", false)
        .option("--silent", "Suppress non-essential output", false)
        .action(async (rootsArg: string[], opts: DuplicatesOpts) => {
            const roots0 = resolveRoots(rootsArg ?? [], []);
            const roots = opts.nodeModules ? expandNodeModules(roots0) : roots0;
            if (roots.length === 0) {
                log.warn("no roots resolved");
                console.error("No roots to scan.");
                process.exit(2);
            }

            const report = collapseDuplicates({ roots });
            report.grouped = Boolean(opts.group);

            if (opts.top) {
                const n = Number.parseInt(opts.top, 10);
                if (!Number.isNaN(n) && n > 0) {
                    report.sets = report.sets.slice(0, n);
                    report.totalReclaimable = report.sets.reduce((s, x) => s + x.reclaimable, 0);
                }
            }

            const fmt = resolveFormat(opts.format);
            console.log(resolveRenderer(fmt).duplicates(report));
            process.exitCode = 0;
        });

    return cmd;
}
```

- [ ] **Step 4: Run the test**

Run: `bun test src/macos/commands/clones/duplicates.test.ts -t "createDuplicatesCommand"`
Expected: PASS (named `duplicates`, `--group`/`--format`/`--node-modules` present; `--group` → `grouped:true` and the set has 2 members).

- [ ] **Step 5: Commit**

```bash
git add src/macos/commands/clones/duplicates.ts src/macos/commands/clones/duplicates.test.ts
git commit -m "feat(clones): duplicates command (+ --group)"
```

---

> The `--include`/`--exclude` flags are declared on `duplicates` for surface symmetry with `measure` but `collapseDuplicates` (spec §6) walks via utils `findDuplicateFiles` and does not filter by glob — glob-filtering of duplicate sets is an explicit later refinement, out of scope here. That is why `duplicates.ts` does NOT import `parseVariadic` (no consumer). Keep `tsgo --noEmit | rg "src/macos/"` clean before committing.

---

### Task 10: `cache.ts` — 1h plan cache

**Files:**
- Create: `src/macos/lib/clones/cache.ts`
- Create: `src/macos/lib/clones/cache.test.ts`

The §8 plan cache. Key = `plan-<sha1(SafeJSON.stringify({roots:rootsSorted, minSize, include:sortedCopy, exclude:sortedCopy, nodeModules}))>.json` — arrays sorted so equivalent invocations share a key. Stores the dry-run candidate plan. Wraps `Storage("macos-clones").putCacheFile/getCacheFile` with TTL string `"1 hour"`. Staleness cannot corrupt (utils `dedupeFile` re-verifies content before every clone — safety invariant #12). `getCachedPlan` also returns the cache file's age in ms.

- [ ] **Step 1: Write the failing test**

`src/macos/lib/clones/cache.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { cachePlan, getCachedPlan, planCacheKey } from "@app/macos/lib/clones/cache";
import type { DuplicateSet } from "@app/macos/lib/clones/render/types";

const params = {
    roots: ["/b", "/a"],
    minSize: 10485760,
    include: ["z", "a"],
    exclude: ["x"],
    nodeModules: true,
};

const sets: DuplicateSet[] = [
    { kind: "file", what: "a", copies: 2, eachBytes: 100, reclaimable: 100, members: ["/a", "/b"], keep: "/a" },
];

describe("planCacheKey", () => {
    it("is stable under root/include/exclude reordering", () => {
        const k1 = planCacheKey(params);
        const k2 = planCacheKey({
            roots: ["/a", "/b"],
            minSize: 10485760,
            include: ["a", "z"],
            exclude: ["x"],
            nodeModules: true,
        });
        expect(k1).toBe(k2);
        expect(k1).toMatch(/^plan-[0-9a-f]{40}\.json$/);
    });

    it("differs when a meaningful param changes", () => {
        expect(planCacheKey(params)).not.toBe(planCacheKey({ ...params, nodeModules: false }));
        expect(planCacheKey(params)).not.toBe(planCacheKey({ ...params, minSize: 1 }));
    });
});

describe("cachePlan / getCachedPlan round-trip", () => {
    it("stores and retrieves the plan with a non-negative age", async () => {
        const uniq = { ...params, roots: [`/tmp/gt-cache-test-${Date.now()}`] };
        await cachePlan(uniq, sets);
        const hit = await getCachedPlan(uniq);
        expect(hit).not.toBeNull();
        expect(hit?.plan).toEqual(sets);
        expect(hit?.ageMs).toBeGreaterThanOrEqual(0);
    });

    it("returns null for an unknown key", async () => {
        const miss = await getCachedPlan({ ...params, roots: [`/never-${Date.now()}-${Math.random()}`] });
        expect(miss).toBeNull();
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/macos/lib/clones/cache.test.ts -t "planCacheKey"`
Expected: FAIL — `Cannot find module '@app/macos/lib/clones/cache'`.

- [ ] **Step 3: Implement `cache.ts`**

`src/macos/lib/clones/cache.ts`:

```typescript
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { Storage } from "@app/utils/storage/storage";
import type { DuplicateSet } from "./render/types";

const storage = new Storage("macos-clones");
const TTL = "1 hour";

export interface PlanCacheParams {
    roots: string[];
    minSize: number;
    include: string[];
    exclude: string[];
    nodeModules: boolean;
}

export interface CachedPlan {
    plan: DuplicateSet[];
    ageMs: number;
}

/** Stable key: arrays sorted so equivalent invocations share a cache file. */
export function planCacheKey(p: PlanCacheParams): string {
    const normalized = {
        roots: [...p.roots].sort(),
        minSize: p.minSize,
        include: [...p.include].sort(),
        exclude: [...p.exclude].sort(),
        nodeModules: p.nodeModules,
    };
    const sha1 = createHash("sha1").update(SafeJSON.stringify(normalized)).digest("hex");
    return `plan-${sha1}.json`;
}

export async function cachePlan(p: PlanCacheParams, plan: DuplicateSet[]): Promise<void> {
    await storage.putCacheFile(planCacheKey(p), plan, TTL);
}

/** Returns the cached plan + its file age in ms, or null if absent/expired. */
export async function getCachedPlan(p: PlanCacheParams): Promise<CachedPlan | null> {
    const key = planCacheKey(p);
    const plan = await storage.getCacheFile<DuplicateSet[]>(key, TTL);
    if (plan === null) {
        return null;
    }

    const filePath = join(storage.getCacheDir(), key);
    const ageMs = existsSync(filePath) ? Date.now() - statSync(filePath).mtimeMs : 0;
    return { plan, ageMs };
}
```

- [ ] **Step 4: Run the test**

Run: `bun test src/macos/lib/clones/cache.test.ts -t "planCacheKey"`
Expected: PASS (key stable under reorder, matches `plan-<40hex>.json`, changes on meaningful param change; round-trip stores/retrieves with `ageMs >= 0`; unknown key → null).

- [ ] **Step 5: Commit**

```bash
git add src/macos/lib/clones/cache.ts src/macos/lib/clones/cache.test.ts
git commit -m "feat(clones): 1h plan cache (stable sorted-param sha1 key)"
```

---

### Task 11: `optimize.ts` — dry-run (default)

**Files:**
- Create: `src/macos/commands/clones/optimize.ts`
- Create: `src/macos/commands/clones/optimize.test.ts`

The §7 default path: no `--apply` ⇒ **dry run**. Build the plan from `collapseDuplicates` → render projected reclaim as a `ProcessReport` with `state:"dry-run"` (zero ops, totals = projected), write the plan to the 1h cache, exit 0, **mutate nothing**. This task creates `createOptimizeCommand()` with ALL optimize flags declared (`--apply`/`--rollback`/`--list`/`--log`/`--process`/`--no-cache`/`--yes` + shared flags) but only the dry-run branch implemented; later tasks (12–16) fill the other branches. The `ProcessReport` is built by a local `dryRunReport()` helper.

- [ ] **Step 1: Write the failing test**

`src/macos/commands/clones/optimize.test.ts`:

```typescript
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { SafeJSON } from "@app/utils/json";
import { createOptimizeCommand } from "@app/macos/commands/clones/optimize";

describe("createOptimizeCommand (dry-run default)", () => {
    it("declares apply/rollback/list/log/process/no-cache/yes flags", () => {
        const longs = createOptimizeCommand().options.map((o) => o.long);
        for (const f of ["--apply", "--rollback", "--list", "--log", "--process", "--no-cache", "--yes", "--format"]) {
            expect(longs).toContain(f);
        }
    });

    it("no --apply → dry-run ProcessReport (state dry-run, 0 ops), mutates nothing", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-optdry-"));
        try {
            mkdirSync(join(dir, "a"), { recursive: true });
            mkdirSync(join(dir, "b"), { recursive: true });
            const payload = Buffer.alloc(64_000, 7);
            writeFileSync(join(dir, "a", "f"), payload);
            writeFileSync(join(dir, "b", "f"), payload);
            const logs: string[] = [];
            const orig = console.log;
            console.log = (...x: unknown[]) => logs.push(x.join(" "));
            try {
                await createOptimizeCommand().parseAsync(
                    ["node", "optimize", dir, "--format", "json"],
                    { from: "node" },
                );
            } finally {
                console.log = orig;
            }

            const rep = SafeJSON.parse(logs.join("\n")) as {
                state: string;
                ops: unknown[];
                totals: { bytesReclaimed: number };
            };
            expect(rep.state).toBe("dry-run");
            expect(rep.ops).toEqual([]);
            expect(rep.totals.bytesReclaimed).toBeGreaterThanOrEqual(64_000);
            // both files still present & independent (nothing mutated)
            expect(SafeJSON.parse(`${require("node:fs").readdirSync(join(dir, "b")).length}`)).toBe(1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/macos/commands/clones/optimize.test.ts -t "dry-run default"`
Expected: FAIL — `Cannot find module '@app/macos/commands/clones/optimize'`.

- [ ] **Step 3: Implement `optimize.ts` (dry-run branch only; other branches stubbed to throw "not yet wired" so later tasks replace them)**

`src/macos/commands/clones/optimize.ts`:

```typescript
import logger from "@app/logger";
import { cachePlan } from "@app/macos/lib/clones/cache";
import { collapseDuplicates } from "@app/macos/lib/clones/collapse";
import { expandNodeModules, resolveRoots } from "@app/macos/lib/clones/orchestrator";
import { resolveFormat, resolveRenderer } from "@app/macos/lib/clones/render/index";
import type { DuplicateSet, ProcessReport } from "@app/macos/lib/clones/render/types";
import { parseVariadic } from "@app/utils/cli";
import { Command, Option } from "commander";

const log = logger.child({ component: "clones:optimize-cmd" });

function collect(value: string, previous: string[]): string[] {
    return [...previous, value];
}

export interface OptimizeOpts {
    format?: string;
    apply?: boolean;
    rollback?: boolean;
    list?: boolean;
    log?: boolean;
    process?: string;
    cache: boolean;
    yes?: boolean;
    nodeModules?: boolean;
    minReal: string;
    include: string[];
    exclude: string[];
    verbose?: boolean;
    silent?: boolean;
}

export function dryRunReport(roots: string[], sets: DuplicateSet[]): ProcessReport {
    const now = new Date().toISOString();
    const projected = sets.reduce((s, x) => s + x.reclaimable, 0);
    return {
        id: `${now.replace(/[:.]/g, "-")}.${process.pid}`,
        state: "dry-run",
        roots,
        startedAt: now,
        endedAt: now,
        planCache: { hit: false },
        ops: [],
        totals: { cloned: 0, skipped: 0, errors: 0, bytesReclaimed: projected },
    };
}

export function createOptimizeCommand(): Command {
    const cmd = new Command("optimize")
        .description("Dry-run by default; --apply to clone duplicates (audited, reversible)")
        .argument("[roots...]", "Roots to optimize (default: configured watchedDirs, else cwd)")
        .addOption(
            new Option("--format <format>", "Output format").choices(["auto", "table", "json", "jsonl"]).default("auto"),
        )
        .option("--apply", "Actually convert duplicates into clones (requires confirm)", false)
        .option("--rollback", "Un-share a previous process's clones (requires --process)", false)
        .option("--list", "List recorded optimize runs", false)
        .option("--log", "Replay a process's JSONL audit log (requires --process)", false)
        .option("--process <id>", "Target process id for --log / --rollback")
        .option("--no-cache", "Ignore the 1h plan cache; force a fresh scan")
        .option("--yes", "Non-interactive confirm (required for --apply/--rollback in non-TTY)", false)
        .option("--node-modules", "Expand each root to its node_modules dirs", false)
        .option("--min-real <bytes>", "Minimum real size to consider", "10485760")
        .option("--include <glob>", "Include glob (repeatable)", collect, [])
        .option("--exclude <glob>", "Exclude glob (repeatable, wins over --include)", collect, [])
        .option("-v, --verbose", "Verbose logging", false)
        .option("--silent", "Suppress non-essential output", false)
        .action(async (rootsArg: string[], opts: OptimizeOpts) => {
            if (opts.list || opts.log || opts.rollback || opts.apply) {
                throw new Error(
                    "optimize: --apply/--rollback/--list/--log are wired in later tasks (12–16)",
                );
            }

            const roots0 = resolveRoots(rootsArg ?? [], []);
            const roots = opts.nodeModules ? expandNodeModules(roots0) : roots0;
            if (roots.length === 0) {
                log.warn("no roots resolved");
                console.error("No roots to optimize.");
                process.exit(2);
            }

            const sets = collapseDuplicates({ roots }).sets;
            await cachePlan(
                {
                    roots,
                    minSize: Number.parseInt(opts.minReal, 10) || 10485760,
                    include: parseVariadic(opts.include),
                    exclude: parseVariadic(opts.exclude),
                    nodeModules: Boolean(opts.nodeModules),
                },
                sets,
            );

            const report = dryRunReport(roots, sets);
            const fmt = resolveFormat(opts.format);
            console.log(resolveRenderer(fmt).processReport(report));
            process.exitCode = 0;
        });

    return cmd;
}
```

- [ ] **Step 4: Run the test**

Run: `bun test src/macos/commands/clones/optimize.test.ts -t "dry-run default"`
Expected: PASS (all flags declared; no `--apply` → `state:"dry-run"`, `ops:[]`, projected ≥ 64 000, both copies of `b/f` still present).

- [ ] **Step 5: Commit**

```bash
git add src/macos/commands/clones/optimize.ts src/macos/commands/clones/optimize.test.ts
git commit -m "feat(clones): optimize dry-run (plan cache write, mutate nothing)"
```

---

### Task 12: `audit.ts` — ProcessReport build / stream / replay (JSONL source of truth)

**Files:**
- Create: `src/macos/lib/clones/audit.ts`
- Create: `src/macos/lib/clones/audit.test.ts`

The §4/§7 audit core. **Pins the JSONL format** (see Context "Persistence model"): the `process/` dir is a sibling of `cache/` under `Storage("macos-clones").getBaseDir()`; raw `node:fs` (`mkdirSync` + `appendFileSync`); first line is a `_meta` line, then `ProcessOp` lines; `--rollback` appends a second `_meta` line + rollback ops to the SAME file. This task implements: `processPaths()`, `newProcessId()`, `writeMeta()`, `appendOp()`, `readProcess()` (replay → `ProcessReport`, last meta wins), `listProcesses()` (→ `ProcessListReport`, newest first), `closestProcessIds()` (for unknown-id errors). NO clonefile here — the `--apply` clone loop lives in Task 13 (wraps utils `dedupeFile`).

- [ ] **Step 1: Write the failing test**

`src/macos/lib/clones/audit.test.ts`:

```typescript
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import {
    appendOp,
    closestProcessIds,
    listProcesses,
    newProcessId,
    processJsonlPath,
    readProcess,
    writeMeta,
} from "@app/macos/lib/clones/audit";
import type { ProcessOp } from "@app/macos/lib/clones/render/types";

function op(seq: number, kind: ProcessOp["op"]): ProcessOp {
    return {
        seq,
        ts: new Date().toISOString(),
        op: kind,
        status: kind === "clone" ? "ok" : "already-cloned",
        bytes: kind === "clone" ? 1024 : 0,
        keep: "/k",
        replace: `/r${seq}`,
        modeBefore: 0o644,
        mtimeBeforeMs: 1,
        sha256Before: "abc",
        ...(kind === "clone" ? { sha256After: "abc" } : {}),
    };
}

describe("audit JSONL lifecycle", () => {
    it("meta line + ops replay into a ProcessReport; rollback meta wins for state", () => {
        const id = newProcessId();
        const roots = ["/tmp/x"];
        const startedAt = new Date().toISOString();
        writeMeta({ id, state: "applied", roots, startedAt, endedAt: startedAt, planCacheHit: true, planCacheAgeMs: 50 });
        appendOp(id, op(1, "clone"));
        appendOp(id, op(2, "skip"));

        const path = processJsonlPath(id);
        expect(existsSync(path)).toBe(true);
        expect(readFileSync(path, "utf8").trim().split("\n").length).toBe(3); // meta + 2 ops

        let rep = readProcess(id);
        expect(rep).not.toBeNull();
        expect(rep?.state).toBe("applied");
        expect(rep?.id).toBe(id);
        expect(rep?.roots).toEqual(roots);
        expect(rep?.planCache).toEqual({ hit: true, ageMs: 50 });
        expect(rep?.ops.length).toBe(2);
        expect(rep?.totals).toEqual({ cloned: 1, skipped: 1, errors: 0, bytesReclaimed: 1024 });

        // rollback: second meta line + rollback op appended to the SAME file
        const endedAt = new Date().toISOString();
        writeMeta({ id, state: "rolled-back", roots, startedAt, endedAt, planCacheHit: true, planCacheAgeMs: 50 });
        appendOp(id, op(3, "rollback-uncloned"));
        rep = readProcess(id);
        expect(rep?.state).toBe("rolled-back"); // last meta wins
        expect(rep?.endedAt).toBe(endedAt);
        expect(rep?.ops.length).toBe(3);
    });

    it("listProcesses returns newest-first list entries; closestProcessIds suggests near matches", () => {
        const a = newProcessId();
        writeMeta({ id: a, state: "dry-run", roots: ["/a"], startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), planCacheHit: false });
        const list = listProcesses();
        expect(list.processes.some((p) => p.id === a)).toBe(true);
        expect(list.processes[0].startedAt >= list.processes[list.processes.length - 1].startedAt).toBe(true);

        const near = closestProcessIds("zzzz-not-a-real-id");
        expect(Array.isArray(near)).toBe(true);
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/macos/lib/clones/audit.test.ts -t "audit JSONL lifecycle"`
Expected: FAIL — `Cannot find module '@app/macos/lib/clones/audit'`.

- [ ] **Step 3: Implement `audit.ts`**

`src/macos/lib/clones/audit.ts`:

```typescript
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import logger from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { Storage } from "@app/utils/storage/storage";
import type {
    ProcessListEntry,
    ProcessListReport,
    ProcessOp,
    ProcessReport,
    ProcessTotals,
} from "./render/types";

const log = logger.child({ component: "clones:audit" });
const storage = new Storage("macos-clones");

export interface ProcessMeta {
    id: string;
    state: ProcessReport["state"];
    roots: string[];
    startedAt: string;
    endedAt: string;
    planCacheHit: boolean;
    planCacheAgeMs?: number;
}

interface MetaLine {
    _meta: ProcessMeta;
}

function isMetaLine(v: unknown): v is MetaLine {
    return typeof v === "object" && v !== null && "_meta" in v;
}

/** The process/ audit dir — sibling of cache/ under the tool's base dir.
 *  NOT a Storage cache helper (those write under cache/). */
export function processDir(): string {
    const dir = join(storage.getBaseDir(), "process");
    mkdirSync(dir, { recursive: true });
    return dir;
}

export function processJsonlPath(id: string): string {
    return join(processDir(), `${id}.jsonl`);
}

/** Filename-safe UTC id + pid suffix (collision-proof for same-second runs). */
export function newProcessId(): string {
    return `${new Date().toISOString().replace(/[:.]/g, "-")}.${process.pid}`;
}

export function writeMeta(meta: ProcessMeta): void {
    appendFileSync(processJsonlPath(meta.id), `${SafeJSON.stringify({ _meta: meta })}\n`);
}

export function appendOp(id: string, op: ProcessOp): void {
    appendFileSync(processJsonlPath(id), `${SafeJSON.stringify(op)}\n`);
}

function totalsOf(ops: ProcessOp[]): ProcessTotals {
    const t: ProcessTotals = { cloned: 0, skipped: 0, errors: 0, bytesReclaimed: 0 };
    for (const op of ops) {
        if (op.op === "clone") {
            t.cloned += 1;
            t.bytesReclaimed += op.bytes;
        } else if (op.op === "skip") {
            t.skipped += 1;
        } else if (op.op === "error") {
            t.errors += 1;
        }
    }

    return t;
}

/** Replay a process JSONL into a ProcessReport. Last meta line wins for
 *  state/endedAt (rollback appends a second meta). Read-only. */
export function readProcess(id: string): ProcessReport | null {
    const path = processJsonlPath(id);
    if (!existsSync(path)) {
        return null;
    }

    let lines: string[];
    try {
        lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
    } catch (err) {
        log.warn({ err, id }, "readProcess failed");
        return null;
    }

    let meta: ProcessMeta | null = null;
    const ops: ProcessOp[] = [];
    for (const line of lines) {
        let parsed: unknown;
        try {
            parsed = SafeJSON.parse(line);
        } catch (err) {
            log.debug({ err, id, line }, "skipping unparseable jsonl line");
            continue;
        }

        if (isMetaLine(parsed)) {
            meta = parsed._meta;
        } else {
            ops.push(parsed as ProcessOp);
        }
    }

    if (!meta) {
        return null;
    }

    return {
        id: meta.id,
        state: meta.state,
        roots: meta.roots,
        startedAt: meta.startedAt,
        endedAt: meta.endedAt,
        planCache: { hit: meta.planCacheHit, ...(meta.planCacheAgeMs !== undefined ? { ageMs: meta.planCacheAgeMs } : {}) },
        ops,
        totals: totalsOf(ops),
    };
}

function firstMeta(path: string): ProcessMeta | null {
    try {
        for (const line of readFileSync(path, "utf8").split("\n")) {
            if (line.trim().length === 0) {
                continue;
            }

            const parsed: unknown = SafeJSON.parse(line);
            if (isMetaLine(parsed)) {
                return parsed._meta;
            }
        }
    } catch (err) {
        log.debug({ err, path }, "firstMeta read failed");
    }

    return null;
}

export function listProcesses(): ProcessListReport {
    const dir = processDir();
    const entries: ProcessListEntry[] = [];
    for (const name of readdirSync(dir)) {
        if (!name.endsWith(".jsonl")) {
            continue;
        }

        const id = name.slice(0, -".jsonl".length);
        const rep = readProcess(id);
        if (!rep) {
            continue;
        }

        entries.push({
            id: rep.id,
            state: rep.state,
            roots: rep.roots,
            totals: rep.totals,
            startedAt: rep.startedAt,
        });
    }

    entries.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
    return { processes: entries };
}

/** Up to 5 recorded ids sharing the longest common prefix with `wanted`
 *  (for "unknown --process" errors). */
export function closestProcessIds(wanted: string): string[] {
    const dir = processDir();
    const ids = readdirSync(dir)
        .filter((n) => n.endsWith(".jsonl"))
        .map((n) => n.slice(0, -".jsonl".length));
    const score = (id: string): number => {
        let i = 0;
        while (i < id.length && i < wanted.length && id[i] === wanted[i]) {
            i += 1;
        }

        return i;
    };

    return ids.sort((a, b) => score(b) - score(a)).slice(0, 5);
}

export { firstMeta };
```

- [ ] **Step 4: Run the test**

Run: `bun test src/macos/lib/clones/audit.test.ts -t "audit JSONL lifecycle"`
Expected: PASS — meta + 2 ops = 3 lines; replay totals `{cloned:1,skipped:1,errors:0,bytesReclaimed:1024}`; second meta flips `state` to `rolled-back` and `endedAt`; `listProcesses` newest-first; `closestProcessIds` returns an array.

- [ ] **Step 5: Commit**

```bash
git add src/macos/lib/clones/audit.ts src/macos/lib/clones/audit.test.ts
git commit -m "feat(clones): audit JSONL (meta+ops, replay, list, closest-ids)"
```

---

### Task 13: `optimize --apply` — audit wrapper around utils `dedupeFile`

**Files:**
- Modify: `src/macos/lib/clones/audit.ts` (add `runOptimize()`)
- Modify: `src/macos/commands/clones/optimize.ts` (wire `--apply` branch + confirm)
- Modify: `src/macos/lib/clones/audit.test.ts` (append `skip.unlessMac` round-trip)
- Modify: `src/macos/commands/clones/optimize.test.ts` (append non-TTY `--apply` guard)

The §7 `--apply`. `runOptimize()` (in `audit.ts`, does NOT extend utils): preflight `isApfsCloneSupported()` → exit 1 if false; iterate the plan's `keep`→`replace[]` pairs; per file capture pre-state (`lstat` mode/mtime, streamed `sha256Before`) → call utils `dedupeFile({keep,replace})` → on `cloned` re-hash `replace` → `sha256After`, assert `===sha256Before` (mismatch ⇒ record `op:"error" status:"integrity"` and **STOP the run**, throw `IntegrityError`); `already-cloned`/`skipped-*` map to `op:"skip"`; `CloneUnsupportedError` → `op:"error"` (run continues, per-file isolation). Stream each `ProcessOp` JSONL line (crash-safe). TTY confirm = clack summary + `p.text` requiring literal token `apply`; non-TTY requires `--yes`, else `suggestCommand(...{add:["--apply","--yes"]})` + exit 1.

- [ ] **Step 1: Write the failing tests**

Append to `src/macos/lib/clones/audit.test.ts`:

```typescript
import { mkdtempSync, readFileSync as rf, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as j } from "node:path";
import { skip } from "@app/utils/test/skip";
import { processJsonlPath, runOptimize } from "@app/macos/lib/clones/audit";
import type { DuplicateSet } from "@app/macos/lib/clones/render/types";

describe.skipIf(skip.unlessMac)("runOptimize apply round-trip", () => {
    it("clones replace files, captures sha-before/after, writes JSONL", () => {
        const dir = mkdtempSync(j(tmpdir(), "gt-cl-apply-"));
        try {
            const payload = Buffer.alloc(512 * 1024, 0x42);
            writeFileSync(j(dir, "keep"), payload);
            writeFileSync(j(dir, "dupA"), payload);
            writeFileSync(j(dir, "dupB"), payload);
            const sets: DuplicateSet[] = [
                {
                    kind: "file",
                    what: "keep",
                    copies: 3,
                    eachBytes: 512 * 1024,
                    reclaimable: 1024 * 1024,
                    members: [j(dir, "keep"), j(dir, "dupA"), j(dir, "dupB")],
                    keep: j(dir, "keep"),
                },
            ];

            const rep = runOptimize({ roots: [dir], sets, planCacheHit: false });
            expect(rep.state).toBe("applied");
            expect(rep.totals.cloned).toBe(2);
            const cloneOps = rep.ops.filter((o) => o.op === "clone");
            expect(cloneOps.length).toBe(2);
            for (const o of cloneOps) {
                expect(o.sha256After).toBe(o.sha256Before); // byte-identity proof
                expect(o.bytes).toBeGreaterThan(0);
            }

            // JSONL on disk: 1 meta + 2 clone ops
            const onDisk = rf(processJsonlPath(rep.id), "utf8").trim().split("\n");
            expect(onDisk.length).toBe(3);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
```

Append to `src/macos/commands/clones/optimize.test.ts`:

```typescript
import { suggestCommand } from "@app/utils/cli";

describe("optimize --apply non-TTY guard", () => {
    it("non-TTY --apply without --yes errors with the exact suggestCommand and exits 1", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-applyguard-"));
        try {
            const errs: string[] = [];
            const origErr = console.error;
            const origExit = process.exit;
            let code: number | undefined;
            console.error = (...x: unknown[]) => errs.push(x.join(" "));
            // @ts-expect-error test stub
            process.exit = (c?: number) => {
                code = c;
                throw new Error("__exit__");
            };
            try {
                await createOptimizeCommand().parseAsync(
                    ["node", "optimize", dir, "--apply"],
                    { from: "node" },
                );
            } catch (e) {
                if (!(e instanceof Error) || e.message !== "__exit__") {
                    throw e;
                }
            } finally {
                console.error = origErr;
                process.exit = origExit;
            }

            expect(code).toBe(1);
            expect(errs.join("\n")).toContain("--yes");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/macos/lib/clones/audit.test.ts -t "runOptimize apply" && bun test src/macos/commands/clones/optimize.test.ts -t "non-TTY guard"`
Expected: FAIL — `runOptimize is not exported`; the command test fails because `--apply` currently throws "wired in later tasks".

- [ ] **Step 3a: Implement `runOptimize` in `audit.ts`**

Append to `src/macos/lib/clones/audit.ts` (add to imports: `createHash` from `node:crypto`; `lstatSync, readFileSync as readBin` from `node:fs`; `isApfsCloneSupported` + `CloneUnsupportedError` from `@app/utils/macos/apfs`; `dedupeFile` from `@app/utils/fs/disk-usage`):

```typescript
import { createHash } from "node:crypto";
import { lstatSync, readFileSync as readBin } from "node:fs";
import { dedupeFile } from "@app/utils/fs/disk-usage";
import { CloneUnsupportedError, isApfsCloneSupported } from "@app/utils/macos/apfs";
import type { DuplicateSet } from "./render/types";

export class IntegrityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "IntegrityError";
    }
}

function sha256(path: string): string {
    return createHash("sha256").update(readBin(path)).digest("hex");
}

export interface RunOptimizeArgs {
    roots: string[];
    sets: DuplicateSet[];
    planCacheHit: boolean;
    planCacheAgeMs?: number;
}

/** Audit wrapper (does NOT extend utils dedupeFile). Per file: capture
 *  pre-state → dedupeFile → on clone re-hash + assert byte-identity (abort
 *  on mismatch) → append ProcessOp JSONL. Per-file isolation for skips/errors.
 *  Preflight: off-APFS → throws (caller maps to exit 1). */
export function runOptimize({
    roots,
    sets,
    planCacheHit,
    planCacheAgeMs,
}: RunOptimizeArgs): ProcessReport {
    if (!isApfsCloneSupported()) {
        throw new CloneUnsupportedError(
            "APFS clone support unavailable on this volume — cannot --apply",
        );
    }

    const id = newProcessId();
    const startedAt = new Date().toISOString();
    writeMeta({
        id,
        state: "applied",
        roots,
        startedAt,
        endedAt: startedAt,
        planCacheHit,
        ...(planCacheAgeMs !== undefined ? { planCacheAgeMs } : {}),
    });

    let seq = 0;
    for (const set of sets) {
        for (const replace of set.members.filter((m) => m !== set.keep)) {
            seq += 1;
            const ts = new Date().toISOString();
            let modeBefore = 0;
            let mtimeBeforeMs = 0;
            let sha256Before = "";
            try {
                const st = lstatSync(replace);
                modeBefore = st.mode & 0o7777;
                mtimeBeforeMs = st.mtimeMs;
                sha256Before = sha256(replace);
            } catch (err) {
                log.warn({ err, replace }, "pre-state capture failed");
                appendOp(id, {
                    seq,
                    ts,
                    op: "error",
                    status: "prestate",
                    bytes: 0,
                    keep: set.keep,
                    replace,
                    modeBefore,
                    mtimeBeforeMs,
                    sha256Before,
                    message: err instanceof Error ? err.message : String(err),
                });
                continue;
            }

            try {
                const res = dedupeFile({ keep: set.keep, replace });
                if (res.status === "cloned") {
                    const sha256After = sha256(replace);
                    if (sha256After !== sha256Before) {
                        appendOp(id, {
                            seq,
                            ts,
                            op: "error",
                            status: "integrity",
                            bytes: 0,
                            keep: set.keep,
                            replace,
                            modeBefore,
                            mtimeBeforeMs,
                            sha256Before,
                            sha256After,
                            message: "sha256 changed after clone — run aborted",
                        });
                        throw new IntegrityError(
                            `integrity violation cloning ${replace}: ${sha256Before} != ${sha256After}`,
                        );
                    }

                    appendOp(id, {
                        seq,
                        ts,
                        op: "clone",
                        status: "ok",
                        bytes: res.bytesReclaimed,
                        keep: set.keep,
                        replace,
                        modeBefore,
                        mtimeBeforeMs,
                        sha256Before,
                        sha256After,
                    });
                } else {
                    appendOp(id, {
                        seq,
                        ts,
                        op: "skip",
                        status: res.status,
                        bytes: 0,
                        keep: set.keep,
                        replace,
                        modeBefore,
                        mtimeBeforeMs,
                        sha256Before,
                    });
                }
            } catch (err) {
                if (err instanceof IntegrityError) {
                    throw err;
                }

                const isClone = err instanceof CloneUnsupportedError;
                appendOp(id, {
                    seq,
                    ts,
                    op: "error",
                    status: isClone ? "clone-unsupported" : "errno",
                    bytes: 0,
                    keep: set.keep,
                    replace,
                    modeBefore,
                    mtimeBeforeMs,
                    sha256Before,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        }
    }

    const endedAt = new Date().toISOString();
    writeMeta({
        id,
        state: "applied",
        roots,
        startedAt,
        endedAt,
        planCacheHit,
        ...(planCacheAgeMs !== undefined ? { planCacheAgeMs } : {}),
    });
    const rep = readProcess(id);
    if (!rep) {
        throw new Error(`runOptimize: process ${id} could not be read back`);
    }

    return rep;
}
```

- [ ] **Step 3b: Wire the `--apply` branch in `optimize.ts`**

In `src/macos/commands/clones/optimize.ts`, add imports (`* as p` from `@clack/prompts`, `pc` from `picocolors`, `isInteractive`/`suggestCommand` from `@app/utils/cli`, `getCachedPlan` from the cache module, `runOptimize` + `IntegrityError` from the audit module, `formatBytes` from `@app/utils/format`, `CloneUnsupportedError` from `@app/utils/macos/apfs`). Replace the early `if (opts.list || opts.log || opts.rollback || opts.apply) throw …` guard with a router that still throws ONLY for the not-yet-wired branches and add an `--apply` handler:

```typescript
            if (opts.list || opts.log || opts.rollback) {
                throw new Error("optimize: --list/--log/--rollback are wired in Tasks 14–16");
            }

            const roots0 = resolveRoots(rootsArg ?? [], []);
            const roots = opts.nodeModules ? expandNodeModules(roots0) : roots0;
            if (roots.length === 0) {
                console.error("No roots to optimize.");
                process.exit(2);
            }

            const cacheParams = {
                roots,
                minSize: Number.parseInt(opts.minReal, 10) || 10485760,
                include: parseVariadic(opts.include),
                exclude: parseVariadic(opts.exclude),
                nodeModules: Boolean(opts.nodeModules),
            };

            if (opts.apply) {
                const cached = opts.cache === false ? null : await getCachedPlan(cacheParams);
                const sets = cached?.plan ?? collapseDuplicates({ roots }).sets;
                const projected = sets.reduce((s, x) => s + x.reclaimable, 0);

                if (isInteractive()) {
                    p.intro(pc.bgCyan(pc.black(" clones optimize --apply ")));
                    p.log.info(
                        `${sets.length} set(s) → clones · reclaim ${formatBytes(projected)} · ` +
                            "rewrites in place, content-verified",
                    );
                    const token = await p.text({
                        message: 'Type "apply" to proceed',
                        validate: (v) => (v === "apply" ? undefined : 'Type exactly "apply" or Ctrl-C'),
                    });

                    if (p.isCancel(token) || token !== "apply") {
                        p.cancel("Aborted — nothing was changed.");
                        process.exit(0);
                    }
                } else if (!opts.yes) {
                    console.error("optimize --apply requires confirmation. In non-interactive mode pass --yes.");
                    console.error(
                        suggestCommand("tools macos clones optimize", {
                            add: ["--apply", "--yes"],
                            subcommand: ["macos", "clones", "optimize"],
                        }),
                    );
                    process.exit(1);
                }

                try {
                    const rep = runOptimize({
                        roots,
                        sets,
                        planCacheHit: Boolean(cached),
                        ...(cached ? { planCacheAgeMs: cached.ageMs } : {}),
                    });
                    rep.planCache = { hit: Boolean(cached), ...(cached ? { ageMs: cached.ageMs } : {}) };
                    console.log(resolveRenderer(resolveFormat(opts.format)).processReport(rep));
                    process.exitCode = rep.totals.errors > 0 ? 1 : 0;
                } catch (err) {
                    if (err instanceof IntegrityError) {
                        console.error(`INTEGRITY ABORT: ${err.message}`);
                        process.exit(1);
                    }

                    if (err instanceof CloneUnsupportedError) {
                        console.error(`Cannot --apply: ${err.message}`);
                        process.exit(1);
                    }

                    throw err;
                }

                return;
            }

            const sets = collapseDuplicates({ roots }).sets;
            await cachePlan(cacheParams, sets);
            console.log(resolveRenderer(resolveFormat(opts.format)).processReport(dryRunReport(roots, sets)));
            process.exitCode = 0;
```

- [ ] **Step 4: Run the tests**

Run: `bun test src/macos/lib/clones/audit.test.ts -t "runOptimize apply" && bun test src/macos/commands/clones/optimize.test.ts -t "non-TTY guard"`
Expected: PASS — macOS: 2 files cloned, every clone op has `sha256After===sha256Before`, JSONL = meta+2 ops; non-TTY `--apply` without `--yes` exits 1 with a message containing `--yes`. (`runOptimize` block skipped off-macOS.)

- [ ] **Step 5: Commit**

```bash
git add src/macos/lib/clones/audit.ts src/macos/lib/clones/audit.test.ts src/macos/commands/clones/optimize.ts src/macos/commands/clones/optimize.test.ts
git commit -m "feat(clones): optimize --apply (audit wrapper, sha-verify, confirm)"
```

---

### Task 14: `optimize --list`

**Files:**
- Modify: `src/macos/commands/clones/optimize.ts` (wire `--list` branch)
- Modify: `src/macos/commands/clones/optimize.test.ts` (append `--list` case)

The §7 `--list`: `ProcessListReport` from the `process/` dir (newest first; states), rendered via `renderer.processList`. Read-only. Honors `--format json`.

- [ ] **Step 1: Write the failing test**

Append to `src/macos/commands/clones/optimize.test.ts`:

```typescript
import { newProcessId, writeMeta } from "@app/macos/lib/clones/audit";

describe("optimize --list", () => {
    it("--list --format json lists recorded processes newest-first", async () => {
        const id = newProcessId();
        writeMeta({
            id,
            state: "dry-run",
            roots: ["/tmp/list-test"],
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
            planCacheHit: false,
        });
        const logs: string[] = [];
        const orig = console.log;
        console.log = (...x: unknown[]) => logs.push(x.join(" "));
        try {
            await createOptimizeCommand().parseAsync(
                ["node", "optimize", "--list", "--format", "json"],
                { from: "node" },
            );
        } finally {
            console.log = orig;
        }

        const parsed = SafeJSON.parse(logs.join("\n")) as { processes: { id: string }[] };
        expect(parsed.processes.some((pr) => pr.id === id)).toBe(true);
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/macos/commands/clones/optimize.test.ts -t "optimize --list"`
Expected: FAIL — `--list/--log/--rollback are wired in Tasks 14–16` thrown.

- [ ] **Step 3: Wire `--list`**

In `src/macos/commands/clones/optimize.ts`, add `listProcesses` to the audit import, and change the not-yet-wired guard + add the `--list` handler BEFORE the roots resolution (it needs no roots):

```typescript
            if (opts.log || opts.rollback) {
                throw new Error("optimize: --log/--rollback are wired in Tasks 15–16");
            }

            if (opts.list) {
                console.log(resolveRenderer(resolveFormat(opts.format)).processList(listProcesses()));
                process.exitCode = 0;
                return;
            }
```

(Place this block immediately after the `.action(async (rootsArg, opts) => {` line, before `resolveRoots`. The remaining `--apply`/dry-run code stays unchanged below it.)

- [ ] **Step 4: Run the test**

Run: `bun test src/macos/commands/clones/optimize.test.ts -t "optimize --list"`
Expected: PASS (the just-written process id appears in `processes`; JSON parseable).

- [ ] **Step 5: Commit**

```bash
git add src/macos/commands/clones/optimize.ts src/macos/commands/clones/optimize.test.ts
git commit -m "feat(clones): optimize --list (ProcessListReport)"
```

---

### Task 15: `optimize --log --process <id>` (render == apply tail)

**Files:**
- Modify: `src/macos/commands/clones/optimize.ts` (wire `--log` branch)
- Modify: `src/macos/commands/clones/optimize.test.ts` (append `--log` cases)

The §7 `--log`: read the JSONL → `readProcess` → `renderer.processReport` (READ-ONLY; **byte-identical to the `--apply` tail of the same id** — that is the §4 invariant). `--format jsonl` streams the raw op lines via `JsonRenderer.processReportJsonl`. Unknown `--process` → exit 1 listing the closest ids (§12).

- [ ] **Step 1: Write the failing tests**

Append to `src/macos/commands/clones/optimize.test.ts`:

```typescript
import { appendOp } from "@app/macos/lib/clones/audit";
import { JsonRenderer } from "@app/macos/lib/clones/render/json";

describe("optimize --log", () => {
    it("--log json === JsonRenderer.processReport of the replayed process (apply-tail parity)", async () => {
        const id = newProcessId();
        const started = new Date().toISOString();
        writeMeta({ id, state: "applied", roots: ["/tmp/log-test"], startedAt: started, endedAt: started, planCacheHit: false });
        appendOp(id, {
            seq: 1,
            ts: started,
            op: "clone",
            status: "ok",
            bytes: 2048,
            keep: "/tmp/log-test/k",
            replace: "/tmp/log-test/r",
            modeBefore: 0o644,
            mtimeBeforeMs: 1,
            sha256Before: "deadbeef",
            sha256After: "deadbeef",
        });

        const logs: string[] = [];
        const orig = console.log;
        console.log = (...x: unknown[]) => logs.push(x.join(" "));
        try {
            await createOptimizeCommand().parseAsync(
                ["node", "optimize", "--log", "--process", id, "--format", "json"],
                { from: "node" },
            );
        } finally {
            console.log = orig;
        }

        const { readProcess } = await import("@app/macos/lib/clones/audit");
        const expected = new JsonRenderer().processReport(readProcess(id)!);
        expect(logs.join("\n").trim()).toBe(expected.trim());
    });

    it("unknown --process exits 1 and lists closest ids", async () => {
        const errs: string[] = [];
        const origErr = console.error;
        const origExit = process.exit;
        let code: number | undefined;
        console.error = (...x: unknown[]) => errs.push(x.join(" "));
        // @ts-expect-error stub
        process.exit = (c?: number) => {
            code = c;
            throw new Error("__exit__");
        };
        try {
            await createOptimizeCommand().parseAsync(
                ["node", "optimize", "--log", "--process", "definitely-not-real-zzz"],
                { from: "node" },
            );
        } catch (e) {
            if (!(e instanceof Error) || e.message !== "__exit__") {
                throw e;
            }
        } finally {
            console.error = origErr;
            process.exit = origExit;
        }

        expect(code).toBe(1);
        expect(errs.join("\n").toLowerCase()).toContain("process");
    });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/macos/commands/clones/optimize.test.ts -t "optimize --log"`
Expected: FAIL — `--log/--rollback are wired in Tasks 15–16` thrown.

- [ ] **Step 3: Wire `--log`**

In `src/macos/commands/clones/optimize.ts`, add `readProcess`, `closestProcessIds` to the audit import; add `JsonRenderer` to the render-index import. Replace the not-yet-wired guard and add the `--log` handler BEFORE roots resolution:

```typescript
            if (opts.rollback) {
                throw new Error("optimize: --rollback is wired in Task 16");
            }

            if (opts.log) {
                if (!opts.process) {
                    console.error("optimize --log requires --process <id>.");
                    process.exit(1);
                }

                const rep = readProcess(opts.process);
                if (!rep) {
                    console.error(`Unknown process "${opts.process}".`);
                    const near = closestProcessIds(opts.process);
                    if (near.length > 0) {
                        console.error(`Closest: ${near.join(", ")}`);
                    }

                    process.exit(1);
                }

                const fmt = resolveFormat(opts.format);
                if (fmt === "jsonl") {
                    console.log(new JsonRenderer().processReportJsonl(rep));
                } else {
                    console.log(resolveRenderer(fmt).processReport(rep));
                }

                process.exitCode = 0;
                return;
            }
```

(Place after the `--list` block from Task 14, still before `resolveRoots`.)

- [ ] **Step 4: Run the tests**

Run: `bun test src/macos/commands/clones/optimize.test.ts -t "optimize --log"`
Expected: PASS — `--log --format json` output is byte-identical to `JsonRenderer.processReport(readProcess(id))` (apply-tail parity); unknown `--process` exits 1 mentioning "process".

- [ ] **Step 5: Commit**

```bash
git add src/macos/commands/clones/optimize.ts src/macos/commands/clones/optimize.test.ts
git commit -m "feat(clones): optimize --log (replay; apply-tail parity; jsonl)"
```

---

### Task 16: `optimize --rollback --process <id>`

**Files:**
- Modify: `src/macos/lib/clones/audit.ts` (add `rollbackProcess()`)
- Modify: `src/macos/commands/clones/optimize.ts` (wire `--rollback` branch + token confirm)
- Modify: `src/macos/lib/clones/audit.test.ts` (append `skip.unlessMac` rollback round-trip)

The §7 `--rollback`: **free-space preflight (mandatory)** — `total = Σ bytes of op:"clone"` not yet rolled back; if `freeDiskSpace(<vol of process roots>).available <= total * 1.1` → exit 1 (print required-vs-available, mutate nothing). TTY confirm token `rollback` (mirrors `apply`); non-TTY needs `--yes`. For each `op:"clone"`: re-materialise `replace` as an independent (un-shared) **plain copy** (read bytes → write a fresh tmp in the same dir → `renameSync`), restore `modeBefore`/`mtimeBefore`; append `op:"rollback-uncloned"` to the SAME JSONL; write a second meta line with `state:"rolled-back"`. Content is byte-identical (verified at apply) — rollback changes only physical layout. Emits its own `processReport`.

- [ ] **Step 1: Write the failing test**

Append to `src/macos/lib/clones/audit.test.ts`:

```typescript
import { statSync as statS } from "node:fs";
import { getCloneId } from "@app/utils/macos/apfs";
import { rollbackProcess } from "@app/macos/lib/clones/audit";

describe.skipIf(skip.unlessMac)("rollbackProcess un-shares clones", () => {
    it("apply then rollback: replace no longer shares keep's clone id, content unchanged, audit chained", () => {
        const dir = mkdtempSync(j(tmpdir(), "gt-cl-rb-"));
        try {
            const payload = Buffer.alloc(256 * 1024, 0x77);
            writeFileSync(j(dir, "keep"), payload);
            writeFileSync(j(dir, "dup"), payload);
            const sets: DuplicateSet[] = [
                {
                    kind: "file",
                    what: "keep",
                    copies: 2,
                    eachBytes: 256 * 1024,
                    reclaimable: 256 * 1024,
                    members: [j(dir, "keep"), j(dir, "dup")],
                    keep: j(dir, "keep"),
                },
            ];
            const applied = runOptimize({ roots: [dir], sets, planCacheHit: false });
            expect(applied.totals.cloned).toBe(1);
            expect(getCloneId(j(dir, "dup"))).toBe(getCloneId(j(dir, "keep"))); // shared now

            const rolled = rollbackProcess(applied.id);
            expect(rolled.state).toBe("rolled-back");
            expect(rolled.ops.some((o) => o.op === "rollback-uncloned")).toBe(true);
            // un-shared: clone ids now differ; content still identical
            expect(getCloneId(j(dir, "dup"))).not.toBe(getCloneId(j(dir, "keep")));
            expect(rf(j(dir, "dup"), "utf8")).toBe(rf(j(dir, "keep"), "utf8"));
            expect(statS(j(dir, "dup")).mode & 0o7777).toBe(applied.ops[0].modeBefore);

            // same JSONL holds apply + rollback (audit chain preserved)
            const lines = rf(processJsonlPath(applied.id), "utf8").trim().split("\n");
            expect(lines.length).toBeGreaterThanOrEqual(4); // 2 meta + clone + rollback
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/macos/lib/clones/audit.test.ts -t "rollbackProcess"`
Expected: FAIL — `rollbackProcess is not exported`.

- [ ] **Step 3a: Implement `rollbackProcess` in `audit.ts`**

Append to `src/macos/lib/clones/audit.ts` (add to imports: `chmodSync, renameSync, utimesSync, writeFileSync as writeBin` from `node:fs`; `freeDiskSpace` from `@app/utils/fs/disk-usage`). The rollback tmp file is intentionally a sibling of `replace` (same directory ⇒ same volume ⇒ `renameSync` is atomic — mirrors the utils `dedupeFile` invariant #3):

```typescript
import { chmodSync, renameSync, utimesSync, writeFileSync as writeBin } from "node:fs";
import { freeDiskSpace } from "@app/utils/fs/disk-usage";

export class RollbackSpaceError extends Error {
    constructor(
        message: string,
        readonly required: number,
        readonly available: number,
    ) {
        super(message);
        this.name = "RollbackSpaceError";
    }
}

/** Re-materialise every cloned `replace` of `id` as an independent (plain,
 *  un-shared) copy. Free-space preflight is MANDATORY (rollback physically
 *  re-allocates the shared bytes). Appends rollback ops + a rolled-back meta
 *  line to the SAME JSONL. Content is byte-identical (verified at apply). */
export function rollbackProcess(id: string): ProcessReport {
    const rep = readProcess(id);
    if (!rep) {
        throw new Error(`rollbackProcess: unknown process "${id}"`);
    }

    const toUndo = rep.ops.filter((o) => o.op === "clone");
    const required = toUndo.reduce((s, o) => s + o.bytes, 0);
    const probe = rep.roots[0] ?? process.cwd();
    const free = freeDiskSpace(probe);
    if (free.available <= required * 1.1) {
        throw new RollbackSpaceError(
            `rollback needs ~${required} bytes (×1.1 headroom) but only ${free.available} available`,
            required,
            free.available,
        );
    }

    let seq = rep.ops.reduce((m, o) => Math.max(m, o.seq), 0);
    for (const op of toUndo) {
        seq += 1;
        const ts = new Date().toISOString();
        try {
            const data = readBin(op.replace);
            const tmp = `${op.replace}.gtunclone.${process.pid}.${Date.now()}`;
            writeBin(tmp, data);
            renameSync(tmp, op.replace);
            chmodSync(op.replace, op.modeBefore & 0o7777);
            const mtime = new Date(op.mtimeBeforeMs);
            utimesSync(op.replace, mtime, mtime);
            appendOp(id, {
                seq,
                ts,
                op: "rollback-uncloned",
                status: "ok",
                bytes: op.bytes,
                keep: op.keep,
                replace: op.replace,
                modeBefore: op.modeBefore,
                mtimeBeforeMs: op.mtimeBeforeMs,
                sha256Before: op.sha256Before,
                ...(op.sha256After ? { sha256After: op.sha256After } : {}),
            });
        } catch (err) {
            log.warn({ err, replace: op.replace }, "rollback un-clone failed");
            appendOp(id, {
                seq,
                ts,
                op: "error",
                status: "rollback-failed",
                bytes: 0,
                keep: op.keep,
                replace: op.replace,
                modeBefore: op.modeBefore,
                mtimeBeforeMs: op.mtimeBeforeMs,
                sha256Before: op.sha256Before,
                message: err instanceof Error ? err.message : String(err),
            });
        }
    }

    const endedAt = new Date().toISOString();
    writeMeta({
        id,
        state: "rolled-back",
        roots: rep.roots,
        startedAt: rep.startedAt,
        endedAt,
        planCacheHit: rep.planCache.hit,
        ...(rep.planCache.ageMs !== undefined ? { planCacheAgeMs: rep.planCache.ageMs } : {}),
    });
    const final = readProcess(id);
    if (!final) {
        throw new Error(`rollbackProcess: ${id} unreadable after rollback`);
    }

    return final;
}
```

- [ ] **Step 3b: Wire the `--rollback` branch in `optimize.ts`**

In `src/macos/commands/clones/optimize.ts`, add `rollbackProcess`, `RollbackSpaceError` to the audit import. Remove the `if (opts.rollback) throw …` guard entirely and add the handler BEFORE roots resolution (after the `--log` block):

```typescript
            if (opts.rollback) {
                if (!opts.process) {
                    console.error("optimize --rollback requires --process <id>.");
                    process.exit(1);
                }

                const existing = readProcess(opts.process);
                if (!existing) {
                    console.error(`Unknown process "${opts.process}".`);
                    const near = closestProcessIds(opts.process);
                    if (near.length > 0) {
                        console.error(`Closest: ${near.join(", ")}`);
                    }

                    process.exit(1);
                }

                if (isInteractive()) {
                    p.intro(pc.bgCyan(pc.black(" clones optimize --rollback ")));
                    p.log.warn(
                        `Will re-allocate shared bytes for ${existing.totals.cloned} clone(s) in ${opts.process}.`,
                    );
                    const token = await p.text({
                        message: 'Type "rollback" to proceed',
                        validate: (v) => (v === "rollback" ? undefined : 'Type exactly "rollback" or Ctrl-C'),
                    });

                    if (p.isCancel(token) || token !== "rollback") {
                        p.cancel("Aborted — nothing was changed.");
                        process.exit(0);
                    }
                } else if (!opts.yes) {
                    console.error("optimize --rollback requires confirmation. In non-interactive mode pass --yes.");
                    console.error(
                        suggestCommand("tools macos clones optimize", {
                            add: ["--rollback", "--process", opts.process, "--yes"],
                            subcommand: ["macos", "clones", "optimize"],
                        }),
                    );
                    process.exit(1);
                }

                try {
                    const rolled = rollbackProcess(opts.process);
                    console.log(resolveRenderer(resolveFormat(opts.format)).processReport(rolled));
                    process.exitCode = rolled.totals.errors > 0 ? 1 : 0;
                } catch (err) {
                    if (err instanceof RollbackSpaceError) {
                        console.error(
                            `Cannot rollback: needs ~${err.required} bytes (×1.1), only ${err.available} available.`,
                        );
                        process.exit(1);
                    }

                    throw err;
                }

                return;
            }
```

- [ ] **Step 4: Run the test**

Run: `bun test src/macos/lib/clones/audit.test.ts -t "rollbackProcess"`
Expected: PASS on macOS — apply shares clone ids; rollback un-shares (ids differ), content byte-identical, mode restored, JSONL holds apply+rollback (≥4 lines). Skipped off-macOS.

- [ ] **Step 5: Commit**

```bash
git add src/macos/lib/clones/audit.ts src/macos/lib/clones/audit.test.ts src/macos/commands/clones/optimize.ts
git commit -m "feat(clones): optimize --rollback (free-space preflight, un-share, audit chain)"
```

---

### Task 17: `store.ts` — `Storage("macos-clones")` config schema

**Files:**
- Create: `src/macos/lib/clones/store.ts`
- Create: `src/macos/lib/clones/store.test.ts`

The §10 config accessors. Schema: `{ watchedDirs: string[]; minReal?: number; exclude?: string[]; nodeModules?: boolean }`. Mutated via `storage.atomicConfigUpdate` (pattern: `src/daemon/lib/config.ts`). After landing this, `resolveRoots` callers (measure/du/duplicates/optimize) should source `watchedDirs` from `loadClonesConfig()` instead of `[]` (wired in Task 21's final pass).

- [ ] **Step 1: Write the failing test**

`src/macos/lib/clones/store.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import {
    addWatchedDirs,
    loadClonesConfig,
    removeWatchedDirs,
    setMinReal,
    setNodeModules,
} from "@app/macos/lib/clones/store";

describe("clones store", () => {
    it("defaults to an empty config; add/remove watched dirs dedups & persists", async () => {
        const c0 = await loadClonesConfig();
        expect(Array.isArray(c0.watchedDirs)).toBe(true);

        const dir = process.cwd();
        const after = await addWatchedDirs([dir, dir]); // dedup
        expect(after.watchedDirs.filter((d) => d === dir).length).toBe(1);

        const removed = await removeWatchedDirs([dir]);
        expect(removed.watchedDirs.includes(dir)).toBe(false);
    });

    it("setMinReal / setNodeModules persist scalar settings", async () => {
        const a = await setMinReal(5_000_000);
        expect(a.minReal).toBe(5_000_000);
        const b = await setNodeModules(true);
        expect(b.nodeModules).toBe(true);
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/macos/lib/clones/store.test.ts -t "clones store"`
Expected: FAIL — `Cannot find module '@app/macos/lib/clones/store'`.

- [ ] **Step 3: Implement `store.ts`**

`src/macos/lib/clones/store.ts`:

```typescript
import { resolve } from "node:path";
import { Storage } from "@app/utils/storage/storage";

export interface ClonesConfig {
    watchedDirs: string[];
    minReal?: number;
    exclude?: string[];
    nodeModules?: boolean;
}

const storage = new Storage("macos-clones");

function normalize(config: Partial<ClonesConfig>): ClonesConfig {
    return {
        watchedDirs: Array.isArray(config.watchedDirs) ? config.watchedDirs : [],
        ...(typeof config.minReal === "number" ? { minReal: config.minReal } : {}),
        ...(Array.isArray(config.exclude) ? { exclude: config.exclude } : {}),
        ...(typeof config.nodeModules === "boolean" ? { nodeModules: config.nodeModules } : {}),
    };
}

export async function loadClonesConfig(): Promise<ClonesConfig> {
    const raw = await storage.getConfig<Partial<ClonesConfig>>();
    return normalize(raw ?? {});
}

export async function addWatchedDirs(dirs: string[]): Promise<ClonesConfig> {
    const abs = dirs.map((d) => resolve(d));
    const updated = await storage.atomicConfigUpdate<ClonesConfig>((c) => {
        c.watchedDirs = [...new Set([...(c.watchedDirs ?? []), ...abs])];
    });
    return normalize(updated);
}

export async function removeWatchedDirs(dirs: string[]): Promise<ClonesConfig> {
    const abs = new Set(dirs.map((d) => resolve(d)));
    const updated = await storage.atomicConfigUpdate<ClonesConfig>((c) => {
        c.watchedDirs = (c.watchedDirs ?? []).filter((d) => !abs.has(d));
    });
    return normalize(updated);
}

export async function setMinReal(bytes: number): Promise<ClonesConfig> {
    const updated = await storage.atomicConfigUpdate<ClonesConfig>((c) => {
        c.minReal = bytes;
    });
    return normalize(updated);
}

export async function setNodeModules(on: boolean): Promise<ClonesConfig> {
    const updated = await storage.atomicConfigUpdate<ClonesConfig>((c) => {
        c.nodeModules = on;
    });
    return normalize(updated);
}

export async function setExclude(globs: string[]): Promise<ClonesConfig> {
    const updated = await storage.atomicConfigUpdate<ClonesConfig>((c) => {
        c.exclude = [...new Set(globs)];
    });
    return normalize(updated);
}
```

- [ ] **Step 4: Run the test**

Run: `bun test src/macos/lib/clones/store.test.ts -t "clones store"`
Expected: PASS (empty default; add dedups to 1; remove drops it; `setMinReal`/`setNodeModules` persist).

- [ ] **Step 5: Commit**

```bash
git add src/macos/lib/clones/store.ts src/macos/lib/clones/store.test.ts
git commit -m "feat(clones): store — Storage('macos-clones') config schema"
```

---

### Task 18: `config.ts` — the `config` command

**Files:**
- Create: `src/macos/commands/clones/config.ts`
- Create: `src/macos/commands/clones/config.test.ts`

The §10 config command. **No `--format`** (prompt/flag flow). **Non-TTY:** `--add-dir <paths>` / `--remove-dir <paths>` via `parseVariadic` (handles repeated flags AND comma lists; dedups; resolved absolute by `store.ts`), `--set-min-real <bytes>`, `--node-modules <on|off>`, `--list`; no args + non-TTY → print config JSON; add validates existence (warn+skip non-existent). **TTY:** `@clack/prompts` — show current dirs; `select` action (Add / Remove / Toggle node_modules / Set min-real); `p.isCancel` → abort, no write.

- [ ] **Step 1: Write the failing test**

`src/macos/commands/clones/config.test.ts`:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { SafeJSON } from "@app/utils/json";
import { createConfigCommand } from "@app/macos/commands/clones/config";
import { loadClonesConfig } from "@app/macos/lib/clones/store";

describe("createConfigCommand (non-TTY)", () => {
    it("has no --format; declares --add-dir/--remove-dir/--list/--set-min-real/--node-modules", () => {
        const longs = createConfigCommand().options.map((o) => o.long);
        expect(longs).not.toContain("--format");
        expect(longs).toContain("--add-dir");
        expect(longs).toContain("--remove-dir");
        expect(longs).toContain("--list");
        expect(longs).toContain("--set-min-real");
        expect(longs).toContain("--node-modules");
    });

    it("--add-dir a,b via parseVariadic persists both (existing dirs); --list prints JSON", async () => {
        const d1 = mkdtempSync(join(tmpdir(), "gt-cl-cfg1-"));
        const d2 = mkdtempSync(join(tmpdir(), "gt-cl-cfg2-"));
        try {
            await createConfigCommand().parseAsync(
                ["node", "config", "--add-dir", `${d1},${d2}`],
                { from: "node" },
            );
            const cfg = await loadClonesConfig();
            expect(cfg.watchedDirs).toContain(d1);
            expect(cfg.watchedDirs).toContain(d2);

            const logs: string[] = [];
            const orig = console.log;
            console.log = (...x: unknown[]) => logs.push(x.join(" "));
            try {
                await createConfigCommand().parseAsync(["node", "config", "--list"], { from: "node" });
            } finally {
                console.log = orig;
            }

            const parsed = SafeJSON.parse(logs.join("\n")) as { watchedDirs: string[] };
            expect(parsed.watchedDirs).toContain(d1);

            await createConfigCommand().parseAsync(
                ["node", "config", "--remove-dir", `${d1},${d2}`],
                { from: "node" },
            );
        } finally {
            rmSync(d1, { recursive: true, force: true });
            rmSync(d2, { recursive: true, force: true });
        }
    });

    it("warns and skips a non-existent --add-dir path", async () => {
        const errs: string[] = [];
        const orig = console.error;
        console.error = (...x: unknown[]) => errs.push(x.join(" "));
        try {
            await createConfigCommand().parseAsync(
                ["node", "config", "--add-dir", "/no/such/dir/xyz-123"],
                { from: "node" },
            );
        } finally {
            console.error = orig;
        }

        const cfg = await loadClonesConfig();
        expect(cfg.watchedDirs).not.toContain("/no/such/dir/xyz-123");
        expect(errs.join("\n")).toContain("/no/such/dir/xyz-123");
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/macos/commands/clones/config.test.ts -t "createConfigCommand"`
Expected: FAIL — `Cannot find module '@app/macos/commands/clones/config'`.

- [ ] **Step 3: Implement `config.ts`**

`src/macos/commands/clones/config.ts`:

```typescript
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import logger from "@app/logger";
import {
    addWatchedDirs,
    loadClonesConfig,
    removeWatchedDirs,
    setMinReal,
    setNodeModules,
} from "@app/macos/lib/clones/store";
import { isInteractive, parseVariadic } from "@app/utils/cli";
import { SafeJSON } from "@app/utils/json";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";

const log = logger.child({ component: "clones:config-cmd" });

function collect(value: string, previous: string[]): string[] {
    return [...previous, value];
}

interface ConfigOpts {
    addDir: string[];
    removeDir: string[];
    list?: boolean;
    setMinReal?: string;
    nodeModules?: string;
}

function validateExisting(paths: string[]): string[] {
    const ok: string[] = [];
    for (const raw of paths) {
        const abs = resolve(raw);
        if (existsSync(abs)) {
            ok.push(abs);
        } else {
            console.error(`Skipping non-existent path: ${raw}`);
            log.warn({ path: raw }, "config add: path does not exist");
        }
    }

    return ok;
}

export function createConfigCommand(): Command {
    return new Command("config")
        .description("Manage watched dirs + filters for clone scans")
        .option("--add-dir <paths>", "Add watched dir(s) (repeatable / comma list)", collect, [])
        .option("--remove-dir <paths>", "Remove watched dir(s) (repeatable / comma list)", collect, [])
        .option("--list", "Print the current config as JSON", false)
        .option("--set-min-real <bytes>", "Default min-real threshold")
        .option("--node-modules <on|off>", "Default node_modules focus mode")
        .action(async (opts: ConfigOpts) => {
            const adds = parseVariadic(opts.addDir);
            const removes = parseVariadic(opts.removeDir);
            const mutating =
                adds.length > 0 ||
                removes.length > 0 ||
                opts.setMinReal !== undefined ||
                opts.nodeModules !== undefined;

            if (!isInteractive() || mutating || opts.list) {
                if (adds.length > 0) {
                    const valid = validateExisting(adds);
                    if (valid.length > 0) {
                        await addWatchedDirs(valid);
                    }
                }

                if (removes.length > 0) {
                    await removeWatchedDirs(removes);
                }

                if (opts.setMinReal !== undefined) {
                    const n = Number.parseInt(opts.setMinReal, 10);
                    if (!Number.isNaN(n)) {
                        await setMinReal(n);
                    }
                }

                if (opts.nodeModules !== undefined) {
                    await setNodeModules(opts.nodeModules === "on" || opts.nodeModules === "true");
                }

                console.log(SafeJSON.stringify(await loadClonesConfig(), null, 2));
                return;
            }

            p.intro(pc.bgCyan(pc.black(" clones config ")));
            const cfg = await loadClonesConfig();
            p.log.info(
                `watched dirs:\n${cfg.watchedDirs.length ? cfg.watchedDirs.map((d) => `  ${d}`).join("\n") : "  (none)"}`,
            );
            p.log.info(
                `minReal: ${cfg.minReal ?? "default (10 MB)"}  nodeModules: ${cfg.nodeModules ? "on" : "off"}`,
            );

            const action = await p.select({
                message: "Action",
                options: [
                    { value: "add", label: "Add a watched dir" },
                    { value: "remove", label: "Remove a watched dir" },
                    { value: "toggle-nm", label: "Toggle node_modules focus" },
                    { value: "min-real", label: "Set min-real threshold" },
                    { value: "quit", label: "Quit (no changes)" },
                ],
            });

            if (p.isCancel(action) || action === "quit") {
                p.cancel("No changes.");
                return;
            }

            if (action === "add") {
                const dir = await p.text({ message: "Directory to add", placeholder: "/path/to/projects" });
                if (p.isCancel(dir)) {
                    p.cancel("No changes.");
                    return;
                }

                const valid = validateExisting([dir]);
                if (valid.length > 0) {
                    await addWatchedDirs(valid);
                    p.log.success(`Added ${valid[0]}`);
                }
            } else if (action === "remove") {
                if (cfg.watchedDirs.length === 0) {
                    p.log.warn("No watched dirs to remove.");
                } else {
                    const sel = await p.select({
                        message: "Remove which?",
                        options: cfg.watchedDirs.map((d) => ({ value: d, label: d })),
                    });

                    if (p.isCancel(sel)) {
                        p.cancel("No changes.");
                        return;
                    }

                    await removeWatchedDirs([sel]);
                    p.log.success(`Removed ${sel}`);
                }
            } else if (action === "toggle-nm") {
                const next = !cfg.nodeModules;
                await setNodeModules(next);
                p.log.success(`node_modules focus → ${next ? "on" : "off"}`);
            } else if (action === "min-real") {
                const v = await p.text({ message: "min-real bytes", placeholder: "10485760" });
                if (p.isCancel(v)) {
                    p.cancel("No changes.");
                    return;
                }

                const n = Number.parseInt(v, 10);
                if (!Number.isNaN(n)) {
                    await setMinReal(n);
                    p.log.success(`min-real → ${n}`);
                }
            }

            p.outro("Done!");
        });
}
```

- [ ] **Step 4: Run the test**

Run: `bun test src/macos/commands/clones/config.test.ts -t "createConfigCommand"`
Expected: PASS (no `--format`; all config flags present; `--add-dir a,b` persists both, `--list` prints JSON containing them; non-existent path warned + skipped).

- [ ] **Step 5: Commit**

```bash
git add src/macos/commands/clones/config.ts src/macos/commands/clones/config.test.ts
git commit -m "feat(clones): config command (clack TTY / parseVariadic non-TTY)"
```

---

### Task 19: `daemon.ts` (enable|disable|status) + `scan-daemon.ts`

**Files:**
- Create: `src/macos/lib/clones/scan-daemon.ts`
- Create: `src/macos/commands/clones/daemon.ts`
- Create: `src/macos/commands/clones/daemon.test.ts`
- Create: `src/macos/lib/clones/scan-daemon.test.ts`

The §11 daemon (report-only). `daemon enable` → `registerTask` from `@app/daemon/lib/register` with **absolute** `command` resolved at enable-time: `absBun = Bun.which("bun") ?? process.execPath`; `absScanScript = fileURLToPath(new URL("../lib/clones/scan-daemon.ts", import.meta.url))`. `scan-daemon.ts` (non-interactive): load `watchedDirs`; empty → log + exit 0; run **dry-run** `buildMeasureReport` + `collapseDuplicates` (NEVER `--apply`); write the 1h plan cache; write a `state:"dry-run"` `ProcessReport` (meta line) to `process/`; emit ONE macOS notification. `disable` → `unregisterTask`. `status` → filter `tools daemon status` for `macos-clones-scan` + last dry-run summary; remind `tools daemon start` if not running.

- [ ] **Step 1: Write the failing tests**

`src/macos/lib/clones/scan-daemon.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { runDaemonScan } from "@app/macos/lib/clones/scan-daemon";

describe("runDaemonScan", () => {
    it("empty watchedDirs → returns scanned:false, writes nothing, no throw", async () => {
        const res = await runDaemonScan({ watchedDirs: [], notify: false });
        expect(res.scanned).toBe(false);
    });
});
```

`src/macos/commands/clones/daemon.test.ts`:

```typescript
import { describe, expect, it, mock } from "bun:test";

const registerSpy = mock(async () => true);
const unregisterSpy = mock(async () => true);
mock.module("@app/daemon/lib/register", () => ({
    registerTask: registerSpy,
    unregisterTask: unregisterSpy,
}));

const { createDaemonCommand } = await import("@app/macos/commands/clones/daemon");

describe("createDaemonCommand", () => {
    it("has enable/disable/status subcommands", () => {
        const subs = createDaemonCommand().commands.map((c) => c.name()).sort();
        expect(subs).toEqual(["disable", "enable", "status"]);
    });

    it("enable registers an ABSOLUTE-path command for macos-clones-scan", async () => {
        await createDaemonCommand().parseAsync(["node", "daemon", "enable"], { from: "node" });
        expect(registerSpy).toHaveBeenCalled();
        const arg = registerSpy.mock.calls[0][0] as { name: string; command: string; every: string };
        expect(arg.name).toBe("macos-clones-scan");
        expect(arg.command.split(" ")[0]).toMatch(/^\//); // absolute bun path
        expect(arg.command).toContain("scan-daemon.ts");
        expect(arg.command).toMatch(/^\/.*\/scan-daemon\.ts$|^\/\S+ run \/.*scan-daemon\.ts$/);
        expect(arg.every).toBe("every day at 03:00");
    });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test src/macos/lib/clones/scan-daemon.test.ts src/macos/commands/clones/daemon.test.ts -t "runDaemonScan|createDaemonCommand"`
Expected: FAIL — both modules missing.

- [ ] **Step 3a: Implement `scan-daemon.ts`**

`src/macos/lib/clones/scan-daemon.ts`:

```typescript
import logger from "@app/logger";
import { cachePlan } from "@app/macos/lib/clones/cache";
import { collapseDuplicates } from "@app/macos/lib/clones/collapse";
import { buildMeasureReport } from "@app/macos/lib/clones/orchestrator";
import { newProcessId, writeMeta } from "@app/macos/lib/clones/audit";
import { loadClonesConfig } from "@app/macos/lib/clones/store";
import { formatBytes } from "@app/utils/format";
import { sendNotification } from "@app/utils/macos/notifications";

const log = logger.child({ component: "clones:scan-daemon" });

export interface DaemonScanArgs {
    watchedDirs?: string[];
    notify?: boolean;
}

export interface DaemonScanResult {
    scanned: boolean;
    reclaimable: number;
    dirs: number;
    processId?: string;
}

/** Unattended dry-run scan (NEVER --apply). Writes the 1h plan cache + a
 *  dry-run ProcessReport meta line, emits ONE notification. */
export async function runDaemonScan(args: DaemonScanArgs = {}): Promise<DaemonScanResult> {
    const cfg = await loadClonesConfig();
    const roots = args.watchedDirs ?? cfg.watchedDirs;
    if (!roots || roots.length === 0) {
        log.info("scan-daemon: no watchedDirs configured — nothing to do");
        return { scanned: false, reclaimable: 0, dirs: 0 };
    }

    const minReal = cfg.minReal ?? 10485760;
    buildMeasureReport({ roots, minReal, breakdown: false });
    const sets = collapseDuplicates({ roots }).sets;
    const reclaimable = sets.reduce((s, x) => s + x.reclaimable, 0);

    await cachePlan(
        { roots, minSize: minReal, include: [], exclude: cfg.exclude ?? [], nodeModules: Boolean(cfg.nodeModules) },
        sets,
    );

    const id = newProcessId();
    const now = new Date().toISOString();
    writeMeta({ id, state: "dry-run", roots, startedAt: now, endedAt: now, planCacheHit: false });

    if (args.notify !== false) {
        await sendNotification({
            title: "macos clones",
            message: `${formatBytes(reclaimable)} reclaimable across ${roots.length} dir(s) — run \`tools macos clones optimize --apply\``,
        });
    }

    log.info({ reclaimable, dirs: roots.length, id }, "scan-daemon dry-run complete");
    return { scanned: true, reclaimable, dirs: roots.length, processId: id };
}

if (import.meta.main) {
    runDaemonScan({ notify: true })
        .then((r) => {
            process.exitCode = r.scanned ? 0 : 0;
        })
        .catch((err) => {
            log.error({ err }, "scan-daemon failed");
            process.exitCode = 1;
        });
}
```

- [ ] **Step 3b: Implement `daemon.ts`**

`src/macos/commands/clones/daemon.ts`:

```typescript
import { fileURLToPath } from "node:url";
import { registerTask, unregisterTask } from "@app/daemon/lib/register";
import logger from "@app/logger";
import { Executor } from "@app/utils/cli";
import { Command } from "commander";

const log = logger.child({ component: "clones:daemon-cmd" });
const TASK_NAME = "macos-clones-scan";

function resolveScanCommand(): string {
    const absBun = Bun.which("bun") ?? process.execPath;
    const absScanScript = fileURLToPath(new URL("../../lib/clones/scan-daemon.ts", import.meta.url));
    return `${absBun} run ${absScanScript}`;
}

export function createDaemonCommand(): Command {
    const daemon = new Command("daemon").description("Once/24h clone-aware dry-run scan + notify (report-only)");

    daemon
        .command("enable")
        .description("Register the daily clone-scan task with `tools daemon`")
        .option("--overwrite", "Overwrite an existing registration", true)
        .action(async (opts: { overwrite?: boolean }) => {
            const created = await registerTask({
                name: TASK_NAME,
                command: resolveScanCommand(),
                every: "every day at 03:00",
                overwrite: opts.overwrite !== false,
                notify: true,
                timeoutMs: 30 * 60_000,
                retries: 1,
                retention: { maxAgeDays: 14, minRuns: 14 },
                description: "Clone-aware dry-run scan of watched dirs; notify reclaimable",
            });
            console.log(
                created ? `registered ${TASK_NAME}` : `${TASK_NAME} already registered (use --overwrite)`,
            );
        });

    daemon
        .command("disable")
        .description("Unregister the clone-scan task")
        .action(async () => {
            const removed = await unregisterTask(TASK_NAME);
            console.log(removed ? `unregistered ${TASK_NAME}` : `${TASK_NAME} was not registered`);
        });

    daemon
        .command("status")
        .description("Show the clone-scan task via `tools daemon status`")
        .action(async () => {
            const result = await new Executor().exec(["tools", "daemon", "status"]);
            const filtered = result.stdout
                .split("\n")
                .filter((line) => line.includes(TASK_NAME) || line.startsWith("name") || line.trim() === "")
                .join("\n");
            console.log(filtered || `${TASK_NAME}: no status (is the daemon running? \`tools daemon start\`)`);
            if (result.exitCode !== 0) {
                log.warn({ exitCode: result.exitCode }, "daemon status returned non-zero");
            }
        });

    return daemon;
}
```

> Path rationale: `daemon.ts` is at `src/macos/commands/clones/daemon.ts` and `scan-daemon.ts` at `src/macos/lib/clones/scan-daemon.ts`, so `commands/clones/` → `lib/clones/` is exactly `../../lib/clones/scan-daemon.ts` (`commands/clones/` up two = `src/macos/`, then down `lib/clones/`). The daemon test's `expect(arg.command).toContain("scan-daemon.ts")` + absolute-path assertion proves this resolves correctly.

- [ ] **Step 4: Run the tests**

Run: `bun test src/macos/lib/clones/scan-daemon.test.ts src/macos/commands/clones/daemon.test.ts -t "runDaemonScan|createDaemonCommand"`
Expected: PASS — empty watchedDirs → `scanned:false`; daemon has enable/disable/status; `enable` calls the mocked `registerTask` with `name:"macos-clones-scan"`, an absolute bun-path command containing `scan-daemon.ts`, `every:"every day at 03:00"`.

- [ ] **Step 5: Commit**

```bash
git add src/macos/lib/clones/scan-daemon.ts src/macos/lib/clones/scan-daemon.test.ts src/macos/commands/clones/daemon.ts src/macos/commands/clones/daemon.test.ts
git commit -m "feat(clones): daemon enable|disable|status + scan-daemon (report-only)"
```

---

### Task 20: Register `clones` group + hidden `apfs` alias on `src/macos/index.ts`

**Files:**
- Create: `src/macos/commands/clones/index.ts`
- Create: `src/macos/commands/clones/index.test.ts`
- Modify: `src/macos/index.ts`

The §1/§14 wiring. `registerClonesCommand(program)` builds a `clones` command group, adds the six subcommands, and ALSO registers a **hidden** `apfs` alias command that shares the exact same subcommands (so `tools macos apfs measure …` works but `apfs` does not appear in `tools macos --help`). After this, `resolveRoots`-calling commands still pass `[]` for watchedDirs — Task 21 wires the config source. Mirrors `registerSwapCommand`/`registerMailCommand` registration on the macos umbrella.

- [ ] **Step 1: Write the failing test**

`src/macos/commands/clones/index.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { Command } from "commander";
import { registerClonesCommand } from "@app/macos/commands/clones/index";

describe("registerClonesCommand", () => {
    it("adds a 'clones' group with the six subcommands", () => {
        const program = new Command();
        registerClonesCommand(program);
        const clones = program.commands.find((c) => c.name() === "clones");
        expect(clones).toBeDefined();
        const subs = clones?.commands.map((c) => c.name()).sort();
        expect(subs).toEqual(["config", "daemon", "du", "duplicates", "measure", "optimize"]);
    });

    it("adds a hidden 'apfs' alias group with the same subcommands", () => {
        const program = new Command();
        registerClonesCommand(program);
        const apfs = program.commands.find((c) => c.name() === "apfs");
        expect(apfs).toBeDefined();
        // hidden: commander marks it so it is omitted from help output
        expect((apfs as unknown as { _hidden?: boolean })._hidden).toBe(true);
        const subs = apfs?.commands.map((c) => c.name()).sort();
        expect(subs).toEqual(["config", "daemon", "du", "duplicates", "measure", "optimize"]);
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/macos/commands/clones/index.test.ts -t "registerClonesCommand"`
Expected: FAIL — `Cannot find module '@app/macos/commands/clones/index'`.

- [ ] **Step 3a: Implement `commands/clones/index.ts`**

`src/macos/commands/clones/index.ts`:

```typescript
import { createConfigCommand } from "@app/macos/commands/clones/config";
import { createDaemonCommand } from "@app/macos/commands/clones/daemon";
import { createDuplicatesCommand } from "@app/macos/commands/clones/duplicates";
import { createDuCommand, createMeasureCommand } from "@app/macos/commands/clones/measure";
import { createOptimizeCommand } from "@app/macos/commands/clones/optimize";
import { Command } from "commander";

function buildGroup(name: string): Command {
    const group = new Command(name).description(
        "Clone-aware disk usage: real reclaimable size, duplicates, safe dedupe (macOS/APFS)",
    );
    group.addCommand(createMeasureCommand());
    group.addCommand(createDuCommand());
    group.addCommand(createDuplicatesCommand());
    group.addCommand(createOptimizeCommand());
    group.addCommand(createConfigCommand());
    group.addCommand(createDaemonCommand());
    return group;
}

export function registerClonesCommand(program: Command): void {
    program.addCommand(buildGroup("clones"));
    // Hidden alias: `tools macos apfs …` works but does not show in --help.
    program.addCommand(buildGroup("apfs"), { hidden: true });
}
```

- [ ] **Step 3b: Wire it into `src/macos/index.ts`**

In `src/macos/index.ts`, add the import next to the other `register*` imports and call it next to the other `register*` calls:

```typescript
import { registerClonesCommand } from "@app/macos/commands/clones/index";
```

and, after `registerSwapCommand(program);` (keep alphabetical-ish grouping consistent with the existing block):

```typescript
registerClonesCommand(program);
```

- [ ] **Step 4: Run the test + smoke the help**

Run:
```bash
bun test src/macos/commands/clones/index.test.ts -t "registerClonesCommand"
bun run src/macos/index.ts clones --help 2>&1 | tee /tmp/clones-help.log | head -30
bun run src/macos/index.ts --help 2>&1 | rg -c "apfs" || echo "apfs hidden from macos --help (expected 0)"
```
Expected: test PASS (`clones` + hidden `apfs`, both with the six subcommands); `clones --help` lists measure/du/duplicates/optimize/config/daemon; `apfs` does NOT appear in `tools macos --help` (the `rg -c` prints `0` → the `|| echo` fires).

- [ ] **Step 5: Commit**

```bash
git add src/macos/commands/clones/index.ts src/macos/commands/clones/index.test.ts src/macos/index.ts
git commit -m "feat(clones): register clones group + hidden apfs alias on macos"
```

---

### Task 21: Wire config source + full suite + tsgo + manual smoke

**Files:**
- Modify: `src/macos/commands/clones/measure.ts` (use `loadClonesConfig().watchedDirs`)
- Modify: `src/macos/commands/clones/duplicates.ts` (same)
- Modify: `src/macos/commands/clones/optimize.ts` (same)
- Modify: `src/macos/commands/clones/measure.test.ts` (append config-fallback case)

Until now every command passed `[]` as the `watchedDirs` arg to `resolveRoots`. This task sources real `watchedDirs` from `store.ts` so "no explicit roots → configured dirs → cwd" (spec §1) actually works, then runs the entire suite + typecheck + an end-to-end manual smoke.

- [ ] **Step 1: Write the failing test**

Append to `src/macos/commands/clones/measure.test.ts`:

```typescript
import { addWatchedDirs, removeWatchedDirs } from "@app/macos/lib/clones/store";

describe("measure roots fall back to configured watchedDirs", () => {
    it("no explicit roots → uses watchedDirs from config", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-cl-cfgroot-"));
        try {
            mkdirSync(join(dir, "s"), { recursive: true });
            writeFileSync(join(dir, "s", "f"), Buffer.alloc(20 * 1024 * 1024, 1));
            await addWatchedDirs([dir]);
            const logs: string[] = [];
            const orig = console.log;
            console.log = (...a: unknown[]) => logs.push(a.join(" "));
            try {
                await createMeasureCommand().parseAsync(
                    ["node", "measure", "--format", "json", "--min-real", "1024"],
                    { from: "node" },
                );
            } finally {
                console.log = orig;
                await removeWatchedDirs([dir]);
            }

            const parsed = SafeJSON.parse(logs.join("\n")) as { roots: string[] };
            expect(parsed.roots).toContain(dir);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/macos/commands/clones/measure.test.ts -t "fall back to configured"`
Expected: FAIL — `measure` currently passes `[]` so it falls back to `process.cwd()`, not `dir`; `parsed.roots` will not contain `dir`.

- [ ] **Step 3: Wire `loadClonesConfig` into the three commands**

In each of `measure.ts`, `duplicates.ts`, `optimize.ts`:

1. Add the import: `import { loadClonesConfig } from "@app/macos/lib/clones/store";`
2. Make the action async-load the config and pass its `watchedDirs` to `resolveRoots`. Replace every `resolveRoots(rootsArg ?? [], [])` call with:

```typescript
            const cfg = await loadClonesConfig();
            const roots0 = resolveRoots(rootsArg ?? [], cfg.watchedDirs);
```

(For `du.ts`'s `createDuCommand` there is no `resolveRoots` call — it roots at a single explicit folder/cwd; leave it unchanged.) In `optimize.ts` the `--apply`/dry-run paths both call `resolveRoots` — update both. Where a default `minReal` is read, prefer `cfg.minReal ?? <parsed flag> ?? 10485760` so the configured default applies when the flag is absent (optional polish — keep behaviour identical if it complicates the diff; the load-config + watchedDirs wiring is the required part).

- [ ] **Step 4: Run the targeted test, then the FULL suite + typecheck**

```bash
bun test src/macos/commands/clones/measure.test.ts -t "fall back to configured"
bun test src/macos/lib/clones src/macos/commands/clones 2>&1 | tee /tmp/clones-full.log | tail -50
tsgo --noEmit 2>&1 | rg "src/macos/(commands|lib)/clones/" || echo "NO CLONES TYPE ERRORS"
```
Expected: the fall-back test PASS; the whole `clones` suite green (clone-behaviour blocks skipped off-macOS, all orchestration/render/audit/collapse/cache/store/daemon/command tests pass); `NO CLONES TYPE ERRORS`.

- [ ] **Step 5: Manual end-to-end smoke (macOS) — exercise the whole tool**

```bash
set -e
WORK=$(mktemp -d /tmp/gt-clones-smoke.XXXXXX)
mkdir -p "$WORK/projA/node_modules/dep/lib" "$WORK/projB/node_modules/dep/lib"
dd if=/dev/urandom of="$WORK/projA/node_modules/dep/index.js" bs=1m count=12 2>/dev/null
cp "$WORK/projA/node_modules/dep/index.js" "$WORK/projA/node_modules/dep/lib/a.js"
# projB is a plain (NON-clone) copy of projA → real duplicates
cp -R "$WORK/projA/node_modules" "$WORK/projB/node_modules"

echo "== measure =="
bun run src/macos/index.ts clones measure "$WORK" --min-real 1024
echo "== du --depth 2 =="
bun run src/macos/index.ts clones du "$WORK" --depth 2 --min-real 1024
echo "== duplicates --group =="
bun run src/macos/index.ts clones duplicates "$WORK" --group
echo "== optimize dry-run =="
bun run src/macos/index.ts clones optimize "$WORK" --format json | tools json
echo "== optimize --apply --yes (real clone on the temp tree) =="
bun run src/macos/index.ts clones optimize "$WORK" --apply --yes --format json > /tmp/clones-apply.json
ID=$(bun -e 'import {SafeJSON} from "@app/utils/json"; console.log(SafeJSON.parse(require("node:fs").readFileSync("/tmp/clones-apply.json","utf8")).id)')
echo "process id: $ID"
echo "== optimize --list =="
bun run src/macos/index.ts clones optimize --list
echo "== optimize --log (must equal the --apply tail) =="
bun run src/macos/index.ts clones optimize --log --process "$ID" --format json | tools json
echo "== optimize --rollback =="
bun run src/macos/index.ts clones optimize --rollback --process "$ID" --yes --format json | tools json
echo "== config round-trip =="
bun run src/macos/index.ts clones config --add-dir "$WORK"
bun run src/macos/index.ts clones config --list
bun run src/macos/index.ts clones config --remove-dir "$WORK"
echo "== daemon status =="
bun run src/macos/index.ts clones daemon status || true
echo "== hidden apfs alias works =="
bun run src/macos/index.ts apfs measure "$WORK" --min-real 1024 | head -3
# cleanup: self-created temp dir (untracked → git rm N/A; mv to /tmp-of-tmp not needed, it IS /tmp)
echo "Smoke tree: $WORK (remove with: rm -rf \"$WORK\" — self-created, untracked)"
```
Expected: `measure`/`du` show du≫real for the cloned-then-duplicated tree; `duplicates --group` lists the whole-`node_modules` (or `dep`) collapsed set with both members; dry-run `state:"dry-run"` & nonzero projected; `--apply` clones the duplicates (`state:"applied"`, `totals.cloned>0`, every clone op `sha256After===sha256Before`); `--list` shows the run; `--log` JSON is byte-identical to `/tmp/clones-apply.json`'s render; `--rollback` un-shares (`state:"rolled-back"`); config add/list/remove round-trips; `daemon status` prints the task line or the "is the daemon running" hint; the hidden `apfs` alias produces the same measure output. Then remove the temp dir per the printed hint.

- [ ] **Step 6: Final commit**

```bash
git add src/macos/commands/clones/measure.ts src/macos/commands/clones/duplicates.ts src/macos/commands/clones/optimize.ts src/macos/commands/clones/measure.test.ts
git commit -m "feat(clones): source watchedDirs from config; full suite green"
```

---

## Public API / spec-coverage map

| Spec section | Implemented by |
|---|---|
| §1 Command surface (`measure du duplicates optimize config daemon` + roots resolution + `--node-modules`) | Tasks 6, 7, 9, 11–16, 18, 19, 20, 21 (`resolveRoots`/`expandNodeModules` in Task 5) |
| §2 Shared flags & `--format` contract | Task 6 (`applySharedMeasureFlags`), Task 4 (`resolveFormat`), Tasks 9/11/18 (per-command flag sets) |
| §3 Renderer interface (tool-local, swappable) | Tasks 1 (`CloneRenderer`), 2 (`JsonRenderer`), 3 (`TableRenderer`), 4 (`resolveRenderer`) |
| §4 Report value objects (data contracts) | Task 1 (all types); JSONL source-of-truth pinned in Task 12; apply-tail==`--log` parity proven in Task 15 |
| §5 `measure`/`du` semantics (per-dir real defn, keep rule, pass-through, breakdown, off-APFS) | Task 5 (`buildMeasureReport`/`pruneTree`), Tasks 6 & 7 (commands) |
| §6 `duplicates` folder-collapse (sha reuse, count cheap-reject, HARD STOP) | Task 8 (`collapseDuplicates`), Task 9 (command + `--group`) |
| §7 `optimize` dry-run/apply/audit/list/log/rollback | Tasks 11 (dry-run), 12 (audit core), 13 (`--apply`), 14 (`--list`), 15 (`--log`), 16 (`--rollback`) |
| §8 Plan cache (1h, sorted-param sha1 key) | Task 10 (`cache.ts`), consumed by Tasks 11 & 13 & 19 |
| §9 Glossary (canonical footer) | Task 1 (`CLONES_GLOSSARY`), Task 3 (TableRenderer appends; JsonRenderer omits) |
| §10 `config` subcommand | Task 17 (`store.ts`), Task 18 (`config` command), Task 21 (wire into commands) |
| §11 `daemon` subcommand + `scan-daemon` | Task 19 (`daemon.ts` + `scan-daemon.ts`, absolute paths via `fileURLToPath(import.meta.url)`) |
| §12 Error handling & exit codes | Tasks 6/7/9/11 (exit 2 unreadable root), 13 (off-APFS exit 1, integrity abort, per-file isolation), 15/16 (unknown `--process` exit 1 + closest ids), 16 (rollback free-space exit 1) |
| §13 Testing strategy (orchestration/render, not clonefile mechanics) | Every task's `*.test.ts`; `skip.unlessMac` on clone-behaviour blocks; render snapshots in Tasks 2/3; collapse hard-stop in Task 8; keep-rule in Task 5; audit round-trip in Tasks 12/13/16 |
| §14 Resolved decisions | Names (`duplicates`/`optimize`, tokens `apply`/`rollback`) in Tasks 9/11/13/16; breakdown-default in Task 6; tool-local renderer in Tasks 1–4; one ProcessReport powering apply/rollback/log in Tasks 12–16; wrap-not-extend utils `dedupeFile` in Task 13; report-only daemon w/ absolute paths in Task 19; hidden `apfs` alias in Task 20 |

## Verification (run the whole tool end-to-end)

After Task 21, the full tool is exercisable. The canonical verification commands (also embedded in Task 21 Step 5):

```bash
# full automated suite + typecheck
bun test src/macos/lib/clones src/macos/commands/clones 2>&1 | tee /tmp/clones-full.log | tail -40
tsgo --noEmit 2>&1 | rg "src/macos/(commands|lib)/clones/" || echo "NO CLONES TYPE ERRORS"

# end-to-end on a temp clone tree (see Task 21 Step 5 for the full scripted smoke):
WORK=$(mktemp -d /tmp/gt-clones-verify.XXXXXX)
mkdir -p "$WORK/a/node_modules/dep" "$WORK/b/node_modules"
dd if=/dev/urandom of="$WORK/a/node_modules/dep/x" bs=1m count=10 2>/dev/null
cp -R "$WORK/a/node_modules" "$WORK/b/node_modules"   # plain copy → real (non-clone) duplicates

tools macos clones measure "$WORK" --min-real 1024
tools macos clones du "$WORK" --depth 2 --min-real 1024
tools macos clones duplicates "$WORK" --group
tools macos clones optimize "$WORK"                       # dry-run, mutates nothing
tools macos clones optimize "$WORK" --apply --yes --format json > /tmp/v-apply.json
ID=$(bun -e 'import {SafeJSON} from "@app/utils/json"; console.log(SafeJSON.parse(require("node:fs").readFileSync("/tmp/v-apply.json","utf8")).id)')
tools macos clones optimize --log --process "$ID"         # must equal the --apply tail
tools macos clones optimize --rollback --process "$ID" --yes
tools macos clones config --add-dir "$WORK"
tools macos clones config --list
tools macos clones config --remove-dir "$WORK"
tools macos clones daemon status
tools macos apfs measure "$WORK" --min-real 1024          # hidden alias
echo "verify tree: $WORK — remove with: rm -rf \"$WORK\" (self-created, untracked)"
```

**Pass criteria:** suite green (off-macOS skips the clone blocks); `NO CLONES TYPE ERRORS`; `measure`/`du` show du≫real; `duplicates --group` lists the collapsed set with all members; dry-run mutates nothing; `--apply` reports `state:"applied"` with every clone op `sha256After===sha256Before`; `--log` output byte-identical to the `--apply` tail; `--rollback` flips to `state:"rolled-back"` and un-shares; config + daemon + hidden alias all work. Then remove the temp tree per the printed hint.
