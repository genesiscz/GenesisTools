import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync, Storage } from "@genesiscz/utils/storage/storage";
import { parseTranscriptLine } from "./parse";
import { costOf, priceFor } from "./pricing";
import type { PricingTable } from "./types";

/**
 * `ai-spend monitor` — today + current week (local timezone, Monday start)
 * in well under a second. Two tricks keep it fast:
 *
 * 1. mtime pruning: a transcript whose mtime predates the local week start
 *    cannot contain events inside the week (transcripts are append-only), so
 *    it is never opened.
 * 2. incremental cache: per file we persist (size, mtime, byte offset, per-day
 *    sums). An unchanged file is never re-read; a grown file is parsed only
 *    from the previous end-of-file offset.
 *
 * The walker touches ONLY the fixed transcript roots (~/.claude/projects and
 * ~/.config/claude/projects, recursively — subagent transcripts nest deeper).
 * It never lists process.cwd() or $HOME.
 */

export interface MonitorTotals {
    cost: number;
    tokens: number;
}

export interface MonitorReport {
    today: MonitorTotals;
    week: MonitorTotals;
    todayDate: string;
    weekStart: string;
    timezone: string;
    /** Files parsed (fully or incrementally) on this run — cache misses. */
    parsedFiles: number;
    /** Recent files considered (mtime within the week). */
    recentFiles: number;
}

/** Local-clock YYYY-MM-DD (NOT the UTC slice of toISOString). */
export function localDayString(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");

    return `${y}-${m}-${d}`;
}

/** Local midnight of the Monday of `date`'s week. */
export function mondayOfWeek(date: Date): Date {
    const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    // getDay(): Sunday=0 … Saturday=6; Monday-start offset.
    const offset = (midnight.getDay() + 6) % 7;
    midnight.setDate(midnight.getDate() - offset);

    return midnight;
}

export function transcriptRoots(home: string): string[] {
    const roots = [join(home, ".claude", "projects"), join(home, ".config", "claude", "projects")];
    const configDir = env.paths.getClaudeConfigDir();

    if (configDir) {
        const extra = join(configDir, "projects");

        if (!roots.includes(extra)) {
            roots.push(extra);
        }
    }

    return roots;
}

const MAX_WALK_DEPTH = 6;

/** All *.jsonl under the fixed roots whose mtime is >= minMtimeMs. */
export function findRecentTranscripts(roots: string[], minMtimeMs: number): string[] {
    const out: string[] = [];

    const walk = (dir: string, depth: number): void => {
        let entries: import("node:fs").Dirent[];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch (err) {
            logger.debug({ err, dir }, "ai-spend monitor: unreadable dir skipped");

            return;
        }

        for (const entry of entries) {
            const full = join(dir, entry.name);

            if (entry.isDirectory()) {
                if (depth < MAX_WALK_DEPTH) {
                    walk(full, depth + 1);
                }

                continue;
            }

            if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
                continue;
            }

            try {
                if (statSync(full).mtimeMs >= minMtimeMs) {
                    out.push(full);
                }
            } catch (err) {
                logger.debug({ err, file: full }, "ai-spend monitor: stat failed");
            }
        }
    };

    for (const root of roots) {
        if (existsSync(root)) {
            walk(root, 0);
        }
    }

    return out;
}

interface DaySums {
    cost: number;
    tokens: number;
}

interface FileCacheEntry {
    size: number;
    mtimeMs: number;
    /** Byte offset already parsed (== size unless the file shrank). */
    offset: number;
    days: Record<string, DaySums>;
    /**
     * Message-id dedup frontier: transcript duplicates of one message id sit
     * adjacent (streaming rewrites), so a bounded tail window is enough.
     */
    recentIds: string[];
}

interface MonitorCache {
    version: 2;
    /** Epoch ms of the last FULL tree sweep. */
    sweepAt: number;
    /** First-level children (project dirs) of the roots at the last sweep. */
    rootChildren: string[];
    files: Record<string, FileCacheEntry>;
}

const RECENT_ID_WINDOW = 50;

/**
 * A full walk of ~/.claude/projects costs seconds on a large tree (11k+ files;
 * even warm `find` takes ~6s on this class of machine), so it runs at most
 * once per TTL. Between sweeps the fast path stats only the known-recent files
 * and readdirs their parent dirs — appends, new sibling transcripts and brand
 * new project dirs are caught immediately; a genuinely new file in a
 * previously-quiet DEEP directory waits for the next sweep.
 */
const SWEEP_TTL_MS = 10 * 60 * 1000;

function cachePath(storage: Storage): string {
    return join(storage.getCacheDir(), "monitor-cache.json");
}

function freshCache(): MonitorCache {
    return { version: 2, sweepAt: 0, rootChildren: [], files: {} };
}

function loadCache(storage: Storage): MonitorCache {
    const path = cachePath(storage);

    if (!existsSync(path)) {
        return freshCache();
    }

    try {
        const raw = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }) as MonitorCache;

        if (raw?.version === 2 && raw.files) {
            return raw;
        }
    } catch (err) {
        logger.debug({ err, path }, "ai-spend monitor: cache unreadable, rebuilding");
    }

    return freshCache();
}

function listRootChildren(roots: string[]): string[] {
    const children: string[] = [];

    for (const root of roots) {
        if (!existsSync(root)) {
            continue;
        }

        try {
            for (const entry of readdirSync(root, { withFileTypes: true })) {
                if (entry.isDirectory()) {
                    children.push(join(root, entry.name));
                }
            }
        } catch (err) {
            logger.debug({ err, root }, "ai-spend monitor: root unreadable");
        }
    }

    return children;
}

/** Between sweeps: known files + new siblings in hot dirs + fully-walked new project dirs. */
function fastCandidates(roots: string[], cache: MonitorCache, minMtimeMs: number): string[] {
    const out = new Set(Object.keys(cache.files));
    const hotDirs = new Set<string>();

    for (const file of out) {
        hotDirs.add(join(file, ".."));
    }

    const knownChildren = new Set(cache.rootChildren);

    for (const child of listRootChildren(roots)) {
        if (knownChildren.has(child)) {
            continue;
        }

        for (const file of findRecentTranscripts([child], minMtimeMs)) {
            out.add(file);
        }

        cache.rootChildren.push(child);
    }

    for (const dir of hotDirs) {
        let entries: import("node:fs").Dirent[];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch (err) {
            logger.debug({ err, dir }, "ai-spend monitor: hot dir unreadable");
            continue;
        }

        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
                continue;
            }

            const full = join(dir, entry.name);

            if (out.has(full)) {
                continue;
            }

            try {
                if (statSync(full).mtimeMs >= minMtimeMs) {
                    out.add(full);
                }
            } catch (err) {
                logger.debug({ err, file: full }, "ai-spend monitor: sibling stat failed");
            }
        }
    }

    return [...out];
}

/** Read the file from `offset` to EOF (append-only tail). */
function readTail(path: string, offset: number, size: number): string {
    const length = size - offset;
    const fd = openSync(path, "r");

    try {
        const buffer = Buffer.alloc(length);
        let read = 0;

        while (read < length) {
            const n = readSync(fd, buffer, read, length - read, offset + read);

            if (n <= 0) {
                break;
            }

            read += n;
        }

        return buffer.subarray(0, read).toString("utf8");
    } finally {
        closeSync(fd);
    }
}

function parseChunk(entry: FileCacheEntry, chunk: string, pricing: PricingTable): void {
    const seen = new Set(entry.recentIds);

    for (const line of chunk.split("\n")) {
        const ev = parseTranscriptLine(line);

        if (!ev || seen.has(ev.messageId)) {
            continue;
        }

        seen.add(ev.messageId);
        entry.recentIds.push(ev.messageId);

        const when = new Date(ev.timestamp);

        if (Number.isNaN(when.getTime())) {
            continue;
        }

        const day = localDayString(when);
        const price = priceFor(ev.model, pricing);
        const tokens = ev.inputTokens + ev.outputTokens + ev.cacheCreationTokens + ev.cacheReadTokens;
        const cost = price
            ? costOf(
                  {
                      input: ev.inputTokens,
                      output: ev.outputTokens,
                      cacheWrite: ev.cacheCreationTokens,
                      cacheRead: ev.cacheReadTokens,
                  },
                  price
              )
            : 0;
        let sums = entry.days[day];

        if (!sums) {
            sums = { cost: 0, tokens: 0 };
            entry.days[day] = sums;
        }

        sums.cost += cost;
        sums.tokens += tokens;
    }

    if (entry.recentIds.length > RECENT_ID_WINDOW) {
        entry.recentIds = entry.recentIds.slice(-RECENT_ID_WINDOW);
    }
}

export interface BuildMonitorOptions {
    home?: string;
    now?: Date;
    storage?: Storage;
    pricing: PricingTable;
    /** Injectable readers (tests spy on which files get opened). */
    readTailFn?: typeof readTail;
    /** Full-sweep interval override (tests; 0 = sweep every run). */
    sweepTtlMs?: number;
}

export function buildMonitorReport(options: BuildMonitorOptions): MonitorReport {
    const now = options.now ?? new Date();
    const home = options.home ?? homedir();
    const storage = options.storage ?? new Storage("ai-spend");
    const tailReader = options.readTailFn ?? readTail;
    const weekStartDate = mondayOfWeek(now);
    const todayDate = localDayString(now);
    const weekStart = localDayString(weekStartDate);
    const cache = loadCache(storage);
    const roots = transcriptRoots(home);
    const minMtimeMs = weekStartDate.getTime();
    const sweepDue = now.getTime() - cache.sweepAt >= (options.sweepTtlMs ?? SWEEP_TTL_MS);
    let files: string[];

    if (sweepDue) {
        files = findRecentTranscripts(roots, minMtimeMs);
        cache.sweepAt = now.getTime();
        cache.rootChildren = listRootChildren(roots);
    } else {
        files = fastCandidates(roots, cache, minMtimeMs);
    }

    let parsedFiles = 0;

    for (const file of files) {
        let stat: import("node:fs").Stats;
        try {
            stat = statSync(file);
        } catch (err) {
            logger.debug({ err, file }, "ai-spend monitor: file vanished mid-run");
            delete cache.files[file];
            continue;
        }

        const cached = cache.files[file];

        if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
            continue;
        }

        let entry: FileCacheEntry;

        if (cached && stat.size >= cached.offset && cached.offset > 0) {
            // Append-only growth: parse just the tail.
            entry = cached;
        } else {
            entry = { size: 0, mtimeMs: 0, offset: 0, days: {}, recentIds: [] };
        }

        const chunk = tailReader(file, entry.offset, stat.size);
        parseChunk(entry, chunk, options.pricing);
        entry.size = stat.size;
        entry.mtimeMs = stat.mtimeMs;
        entry.offset = stat.size;
        cache.files[file] = entry;
        parsedFiles++;
    }

    if (sweepDue) {
        // Drop cache rows for files that fell out of the window (or were deleted).
        const live = new Set(files);

        for (const key of Object.keys(cache.files)) {
            if (!live.has(key)) {
                delete cache.files[key];
            }
        }
    }

    atomicWriteFileSync(cachePath(storage), SafeJSON.stringify(cache, { strict: true }));

    const today: MonitorTotals = { cost: 0, tokens: 0 };
    const week: MonitorTotals = { cost: 0, tokens: 0 };

    for (const entry of Object.values(cache.files)) {
        for (const [day, sums] of Object.entries(entry.days)) {
            if (day >= weekStart && day <= todayDate) {
                week.cost += sums.cost;
                week.tokens += sums.tokens;
            }

            if (day === todayDate) {
                today.cost += sums.cost;
                today.tokens += sums.tokens;
            }
        }
    }

    return {
        today,
        week,
        todayDate,
        weekStart,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        parsedFiles,
        recentFiles: files.length,
    };
}
