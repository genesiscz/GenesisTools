import { createHash } from "node:crypto";
import {
    appendFileSync,
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync as readBin,
    readdirSync,
    readFileSync,
    renameSync,
    utimesSync,
    writeFileSync as writeBin,
} from "node:fs";
import { join } from "node:path";
import logger from "@app/logger";
import { dedupeFile, freeDiskSpace } from "@app/utils/fs/disk-usage";
import { SafeJSON } from "@app/utils/json";
import { CloneUnsupportedError, isApfsCloneSupported } from "@app/utils/macos/apfs";
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
        lines = readFileSync(path, "utf8")
            .split("\n")
            .filter((l) => l.trim().length > 0);
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
        planCache: {
            hit: meta.planCacheHit,
            ...(meta.planCacheAgeMs !== undefined ? { ageMs: meta.planCacheAgeMs } : {}),
        },
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
export function runOptimize({ roots, sets, planCacheHit, planCacheAgeMs }: RunOptimizeArgs): ProcessReport {
    if (!isApfsCloneSupported()) {
        throw new CloneUnsupportedError("APFS clone support unavailable on this volume — cannot --apply");
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
                            `integrity violation cloning ${replace}: ${sha256Before} != ${sha256After}`
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

    const rep = readProcess(id);
    if (!rep) {
        throw new Error(`runOptimize: process ${id} could not be read back`);
    }

    return rep;
}

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
