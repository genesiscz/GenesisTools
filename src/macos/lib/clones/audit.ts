import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
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
