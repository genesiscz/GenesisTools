import type { DedupeStatus } from "@app/utils/fs/disk-usage";

export type Format = "auto" | "table" | "json" | "jsonl";

/** Every value `ProcessOp.status` can actually take when audit.ts writes a row.
 *  Mirrors `DedupeStatus` (returned from dedupeFile and forwarded verbatim) plus
 *  the audit-only states that wrap clone / rollback / pre-state outcomes. */
export type ProcessOpStatus =
    | DedupeStatus
    | "ok"
    | "prestate"
    | "integrity"
    | "clone-unsupported"
    | "errno"
    | "rollback-failed";

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
    status: ProcessOpStatus;
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
    state: "dry-run" | "applied" | "rolled-back" | "aborted";
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
    'overcount du ÷ real. "8.7×" = du claims ~9× more than you\'d actually reclaim.',
    "clone family  files sharing the same physical blocks because one was clonefile()'d",
    "          from another (bun from its cache, or cp -c). Same content, separate",
    "          inodes, copy-on-write — editing one never touches the other.",
    "cross-tree the family's sharing partner is OUTSIDE the measured folder (usually",
    "          ~/.bun/install/cache): deleting this folder frees only its private",
    "          bytes; shared blocks stay alive in the cache. intra-tree = both copies",
    "          inside → deleting really frees them.",
].join("\n");
