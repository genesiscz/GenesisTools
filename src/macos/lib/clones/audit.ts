import {
    appendFileSync,
    chmodSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    statSync,
    utimesSync,
} from "node:fs";
import { join, relative } from "node:path";
import logger from "@app/logger";
import { copyFileStreaming, dedupeFile, freeDiskSpace, sha256File, walkFiles } from "@app/utils/fs/disk-usage";
import { SafeJSON } from "@app/utils/json";
import { CloneUnsupportedError, isApfsCloneSupported } from "@app/utils/macos/apfs";
import { Stopwatch } from "@app/utils/Stopwatch";
import { Storage } from "@app/utils/storage/storage";
import type {
    DuplicateSet,
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
 *  NOT a Storage cache helper (those write under cache/). Cached after first
 *  call to avoid re-running mkdirSync on every appendOp/writeMeta. */
let cachedProcessDir: string | null = null;
export function processDir(): string {
    if (cachedProcessDir !== null) {
        return cachedProcessDir;
    }

    const dir = join(storage.getBaseDir(), "process");
    mkdirSync(dir, { recursive: true });
    cachedProcessDir = dir;
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

/** Stream a process JSONL line-by-line as discriminated `{ meta }` / `{ op }`
 *  records. Read errors (typically ENOENT for unknown ids) end the generator
 *  silently — callers decide what to do when no meta was yielded. */
function* parseProcessLines(id: string): Generator<{ meta?: ProcessMeta; op?: ProcessOp }> {
    const path = processJsonlPath(id);
    let raw: string;
    try {
        raw = readFileSync(path, "utf8");
    } catch (err) {
        log.debug({ err, id }, "parseProcessLines read failed");
        return;
    }

    for (const line of raw.split("\n")) {
        if (line.trim().length === 0) {
            continue;
        }

        let parsed: unknown;
        try {
            parsed = SafeJSON.parse(line);
        } catch (err) {
            log.debug({ err, id, line }, "skipping unparseable jsonl line");
            continue;
        }

        if (isMetaLine(parsed)) {
            yield { meta: parsed._meta };
        } else {
            yield { op: parsed as ProcessOp };
        }
    }
}

function metaToReport(meta: ProcessMeta, ops: ProcessOp[], totals: ProcessTotals): ProcessReport {
    return {
        id: meta.id,
        state: meta.state,
        roots: meta.roots,
        startedAt: meta.startedAt,
        endedAt: meta.endedAt,
        planCache: {
            hit: meta.planCacheHit,
            ...(meta.planCacheAgeMs !== undefined ? { ageMs: meta.planCacheAgeMs } : {}),
        },
        ops,
        totals,
    };
}

/** Replay a process JSONL into a ProcessReport. Last meta line wins for
 *  state/endedAt (rollback appends a second meta). Read-only. */
export function readProcess(id: string): ProcessReport | null {
    let meta: ProcessMeta | null = null;
    const ops: ProcessOp[] = [];
    for (const rec of parseProcessLines(id)) {
        if (rec.meta) {
            meta = rec.meta;
        } else if (rec.op) {
            ops.push(rec.op);
        }
    }

    if (!meta) {
        return null;
    }

    return metaToReport(meta, ops, totalsOf(ops));
}

/** Summary-only read: same parse loop as readProcess but skips materialising
 *  the ops[] array. Totals are accumulated incrementally → constant memory
 *  per process even on huge audit logs. */
function readProcessSummary(id: string): Omit<ProcessReport, "ops"> | null {
    let meta: ProcessMeta | null = null;
    const t: ProcessTotals = { cloned: 0, skipped: 0, errors: 0, bytesReclaimed: 0 };
    for (const rec of parseProcessLines(id)) {
        if (rec.meta) {
            meta = rec.meta;
            continue;
        }

        if (!rec.op) {
            continue;
        }

        if (rec.op.op === "clone") {
            t.cloned += 1;
            t.bytesReclaimed += rec.op.bytes;
        } else if (rec.op.op === "skip") {
            t.skipped += 1;
        } else if (rec.op.op === "error") {
            t.errors += 1;
        }
    }

    if (!meta) {
        return null;
    }

    const { ops: _ops, ...rest } = metaToReport(meta, [], t);
    return rest;
}

export function listProcesses(): ProcessListReport {
    const dir = processDir();
    const entries: ProcessListEntry[] = [];
    for (const name of readdirSync(dir)) {
        if (!name.endsWith(".jsonl")) {
            continue;
        }

        const id = name.slice(0, -".jsonl".length);
        const rep = readProcessSummary(id);
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

export class IntegrityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "IntegrityError";
    }
}

// Shared with disk-usage.ts so the streaming sha256 is one implementation,
// not two parallel ones (each prone to drift). Pre-state capture + post-clone
// re-hash both call this; both must stream to handle large bundles.
const sha256 = sha256File;

export interface RunOptimizeArgs {
    roots: string[];
    sets: DuplicateSet[];
    planCacheHit: boolean;
    planCacheAgeMs?: number;
}

/** Expand a DuplicateSet into the concrete (keep, replace) FILE pairs that
 *  runOptimize will dedupe. For file-kind sets this is trivial. For dir-kind
 *  sets (produced by collapseDuplicates when whole folders are byte-identical)
 *  we walk the keeper's tree once and pair each file with the same-relative
 *  path under every other member dir. dedupeFile then handles each pair
 *  atomically with full safety-contract semantics. */
export function expandSetToPairs(set: DuplicateSet): Array<{ keep: string; replace: string }> {
    const pairs: Array<{ keep: string; replace: string }> = [];
    if (set.kind === "file") {
        for (const m of set.members) {
            if (m !== set.keep) {
                pairs.push({ keep: set.keep, replace: m });
            }
        }

        return pairs;
    }

    const keepFiles: string[] = [];
    for (const e of walkFiles(set.keep, { onError: (err) => log.debug({ err }, "DirSet walk error") })) {
        keepFiles.push(e.path);
    }

    for (const keepFile of keepFiles) {
        const rel = relative(set.keep, keepFile);
        for (const memberDir of set.members) {
            if (memberDir === set.keep) {
                continue;
            }

            pairs.push({ keep: keepFile, replace: join(memberDir, rel) });
        }
    }

    return pairs;
}

/** Audit wrapper (does NOT extend utils dedupeFile). Per file: capture
 *  pre-state → dedupeFile → on clone re-hash + assert byte-identity (abort
 *  on mismatch) → append ProcessOp JSONL. Per-file isolation for skips/errors.
 *  Preflight: off-APFS → throws (caller maps to exit 1). */
export function runOptimize({ roots, sets, planCacheHit, planCacheAgeMs }: RunOptimizeArgs): ProcessReport {
    if (!isApfsCloneSupported()) {
        throw new CloneUnsupportedError("APFS clone support unavailable on this volume — cannot --apply");
    }

    const id = newProcessId();
    const startedAt = new Date().toISOString();
    const sw = new Stopwatch();
    // dir-kind sets walk the keep tree to enumerate pairs — keep one materialised
    // copy and reuse it for both the log preamble and the per-pair loop.
    const pairsBySet = sets.map((s) => expandSetToPairs(s));
    const totalPairs = pairsBySet.reduce((s, p) => s + p.length, 0);
    log.info({ id, roots, sets: sets.length, totalPairs, planCacheHit, planCacheAgeMs }, "runOptimize starting");
    writeMeta({
        id,
        state: "applied",
        roots,
        startedAt,
        endedAt: startedAt,
        planCacheHit,
        ...(planCacheAgeMs !== undefined ? { planCacheAgeMs } : {}),
    });

    // Build the ProcessReport in-memory so we don't have to re-read the
    // JSONL we just wrote. Each recordOp() persists to disk AND accumulates
    // into the in-memory ops + totals.
    const ops: ProcessOp[] = [];
    const totals: ProcessTotals = { cloned: 0, skipped: 0, errors: 0, bytesReclaimed: 0 };
    const recordOp = (op: ProcessOp): void => {
        appendOp(id, op);
        ops.push(op);
        if (op.op === "clone") {
            totals.cloned += 1;
            totals.bytesReclaimed += op.bytes;
        } else if (op.op === "skip") {
            totals.skipped += 1;
        } else if (op.op === "error") {
            totals.errors += 1;
        }
    };

    let seq = 0;
    try {
        for (let i = 0; i < sets.length; i++) {
            const pairs = pairsBySet[i];
            for (const { keep, replace } of pairs) {
                seq += 1;
                const ts = new Date().toISOString();
                let modeBefore = 0;
                let mtimeBeforeMs = 0;
                let sha256Before = "";
                try {
                    // There's a small TOCTOU window between lstatSync and sha256(replace)
                    // here — `replace` could in theory be modified between the two reads.
                    // It is NOT a corruption risk: dedupeFile re-verifies content
                    // (byte-for-byte against `keep`) immediately before cloning, and
                    // runOptimize re-hashes `replace` AFTER the clone and asserts the
                    // sha256 matches `sha256Before` (throwing IntegrityError otherwise).
                    // The worst case is a "skipped-different" or "integrity" status —
                    // never a corrupted file.
                    const st = lstatSync(replace);
                    modeBefore = st.mode & 0o7777;
                    mtimeBeforeMs = st.mtimeMs;
                    sha256Before = sha256(replace);
                } catch (err) {
                    log.warn({ err, replace }, "pre-state capture failed");
                    recordOp({
                        seq,
                        ts,
                        op: "error",
                        status: "prestate",
                        bytes: 0,
                        keep,
                        replace,
                        modeBefore,
                        mtimeBeforeMs,
                        sha256Before,
                        message: err instanceof Error ? err.message : String(err),
                    });
                    continue;
                }

                try {
                    const res = dedupeFile({ keep, replace });
                    if (res.status === "cloned") {
                        const sha256After = sha256(replace);
                        if (sha256After !== sha256Before) {
                            recordOp({
                                seq,
                                ts,
                                op: "error",
                                status: "integrity",
                                bytes: 0,
                                keep,
                                replace,
                                modeBefore,
                                mtimeBeforeMs,
                                sha256Before,
                                sha256After,
                                message: "sha256 changed after clone — run aborted",
                            });
                            throw new IntegrityError(
                                `integrity violation cloning ${replace}: ${sha256Before} != ${sha256After}`
                            );
                        }

                        recordOp({
                            seq,
                            ts,
                            op: "clone",
                            status: "ok",
                            bytes: res.bytesReclaimed,
                            keep,
                            replace,
                            modeBefore,
                            mtimeBeforeMs,
                            sha256Before,
                            sha256After,
                        });
                    } else {
                        recordOp({
                            seq,
                            ts,
                            op: "skip",
                            status: res.status,
                            bytes: 0,
                            keep,
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
                    recordOp({
                        seq,
                        ts,
                        op: "error",
                        status: isClone ? "clone-unsupported" : "errno",
                        bytes: 0,
                        keep,
                        replace,
                        modeBefore,
                        mtimeBeforeMs,
                        sha256Before,
                        message: err instanceof Error ? err.message : String(err),
                    });
                }
            }
        }
    } catch (err) {
        if (err instanceof IntegrityError) {
            // Close the audit log with an aborted-state meta so --log shows
            // [aborted] instead of misleading [applied]. The ops trail already
            // records the integrity failure; this gives the meta the same fact.
            writeMeta({
                id,
                state: "aborted",
                roots,
                startedAt,
                endedAt: new Date().toISOString(),
                planCacheHit,
                ...(planCacheAgeMs !== undefined ? { planCacheAgeMs } : {}),
            });
        }

        throw err;
    }

    const rep: ProcessReport = {
        id,
        state: "applied",
        roots,
        startedAt,
        endedAt: startedAt,
        planCache: {
            hit: planCacheHit,
            ...(planCacheAgeMs !== undefined ? { ageMs: planCacheAgeMs } : {}),
        },
        ops,
        totals,
    };

    log.info(
        {
            id,
            state: rep.state,
            totalPairs,
            cloned: rep.totals.cloned,
            skipped: rep.totals.skipped,
            errors: rep.totals.errors,
            bytesReclaimed: rep.totals.bytesReclaimed,
            elapsedMs: Math.round(sw.elapsedMs),
        },
        "runOptimize complete"
    );
    return rep;
}

export class RollbackSpaceError extends Error {
    constructor(
        message: string,
        readonly required: number,
        readonly available: number
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

    const sw = new Stopwatch();
    const toUndo = rep.ops.filter((o) => o.op === "clone");
    const required = toUndo.reduce((s, o) => s + o.bytes, 0);
    log.info({ id, toUndo: toUndo.length, requiredBytes: required }, "rollbackProcess starting");

    // Multi-volume preflight: group required bytes by replace's volume (dev)
    // and check freeDiskSpace per distinct volume. Falls back to root[0]/cwd
    // when no replace file exists (all already removed → nothing to roll back
    // anyway, but the preflight still has to make a defensible call).
    const byVolume = new Map<number, { required: number; sample: string }>();
    for (const op of toUndo) {
        try {
            const dev = Number(statSync(op.replace).dev);
            const cur = byVolume.get(dev) ?? { required: 0, sample: op.replace };
            cur.required += op.bytes;
            byVolume.set(dev, cur);
        } catch (err) {
            log.debug({ err, replace: op.replace }, "preflight: replace stat failed");
        }
    }

    if (byVolume.size === 0) {
        const probe = rep.roots[0] ?? process.cwd();
        const free = freeDiskSpace(probe);
        if (free.available <= required * 1.1) {
            throw new RollbackSpaceError(
                `rollback needs ~${required} bytes (×1.1 headroom) but only ${free.available} available`,
                required,
                free.available
            );
        }
    } else {
        for (const info of byVolume.values()) {
            const free = freeDiskSpace(info.sample);
            if (free.available <= info.required * 1.1) {
                throw new RollbackSpaceError(
                    `rollback needs ~${info.required} bytes on volume of "${info.sample}" ` +
                        `(×1.1 headroom) but only ${free.available} available`,
                    info.required,
                    free.available
                );
            }
        }
    }

    let seq = rep.ops.reduce((m, o) => Math.max(m, o.seq), 0);
    for (const op of toUndo) {
        seq += 1;
        const ts = new Date().toISOString();
        try {
            const tmp = `${op.replace}.gtunclone.${process.pid}.${Date.now()}`;
            // Explicit chunked read/write — fs.copyFileSync may use clonefile
            // on APFS (Bun's libuv build does), which would PRESERVE the clone
            // family we're trying to break. copyFileStreaming guarantees an
            // independent inode by going through user-space buffers.
            copyFileStreaming(op.replace, tmp);
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

    const undone = final.ops.filter((o) => o.op === "rollback-uncloned").length;
    const failed = final.ops.filter((o) => o.op === "error" && o.status === "rollback-failed").length;
    log.info(
        { id, toUndo: toUndo.length, undone, failed, elapsedMs: Math.round(sw.elapsedMs) },
        "rollbackProcess complete"
    );
    return final;
}
