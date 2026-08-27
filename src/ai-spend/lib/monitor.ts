import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync, Storage } from "@genesiscz/utils/storage/storage";
import {
    AGENT_IDS,
    type AgentId,
    claudeDriver,
    type DriverUsageEvent,
    MONITOR_DRIVERS,
    type MonitorDriver,
} from "./drivers";
import { costOf } from "./pricing";
import type { ModelPrice, PricingTable } from "./types";

/**
 * `ai-spend monitor` — today + current week (local timezone, Monday start)
 * in well under a second, across every agent that leaves usage on disk.
 * Two tricks keep it fast:
 *
 * 1. mtime pruning: a transcript whose mtime predates the local week start
 *    cannot contain events inside the week (transcripts are append-only), so
 *    it is never opened.
 * 2. incremental cache: per file we persist (size, mtime, byte offset, per-day
 *    sums, driver resume state). An unchanged file is never re-read; a grown
 *    file is parsed only from the previous end-of-file offset.
 *
 * The walker touches ONLY each driver's fixed roots (~/.claude/projects,
 * ~/.codex/sessions, ~/.grok/sessions and their documented overrides). It never
 * lists process.cwd() or $HOME. Which files and which line shapes each agent
 * contributes lives in `drivers/`, never here.
 */

export interface MonitorTotals {
    cost: number;
    tokens: number;
}

export interface AgentTotals {
    today: MonitorTotals;
    week: MonitorTotals;
}

export interface MonitorReport {
    today: MonitorTotals;
    week: MonitorTotals;
    todayDate: string;
    weekStart: string;
    timezone: string;
    /** Per-agent split of the same today/week windows. Sums to the top level. */
    agents: Record<AgentId, AgentTotals>;
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

/** Claude Code transcript roots. Kept exported: the claude driver owns the list. */
export function transcriptRoots(home: string): string[] {
    return claudeDriver.roots(home);
}

/** All transcripts under `roots` whose mtime is >= minMtimeMs, per the driver's file test. */
export function findRecentTranscripts(roots: string[], minMtimeMs: number, driver?: MonitorDriver): string[] {
    const activeDriver = driver ?? claudeDriver;
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
                if (depth < activeDriver.maxDepth) {
                    walk(full, depth + 1);
                }

                continue;
            }

            if (!entry.isFile() || !activeDriver.isTranscript(entry.name)) {
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
     * Event-id dedup frontier: transcript duplicates of one event sit
     * adjacent (streaming rewrites), so a bounded tail window is enough.
     */
    recentIds: string[];
    /** Driver resume state (codex's sticky model and cumulative totals). */
    state?: unknown;
}

interface AgentCache {
    /** Epoch ms of the last FULL tree sweep. */
    sweepAt: number;
    /** First-level children (project dirs) of the roots at the last sweep. */
    rootChildren: string[];
    files: Record<string, FileCacheEntry>;
}

interface MonitorCache {
    version: 3;
    agents: Record<AgentId, AgentCache>;
}

const RECENT_ID_WINDOW = 50;

/**
 * A full walk of the transcript trees costs seconds on this class of machine
 * (~11.5k Claude files, ~33k Grok directory entries), so it runs at most once
 * per TTL. Between sweeps the fast path stats only the known-recent files and
 * readdirs their parent dirs — appends, new sibling transcripts and brand new
 * project dirs are caught immediately; a genuinely new file in a
 * previously-quiet DEEP directory waits for the next sweep.
 */
const SWEEP_TTL_MS = 10 * 60 * 1000;

function cachePath(storage: Storage): string {
    return join(storage.getCacheDir(), "monitor-cache.json");
}

function freshAgentCache(): AgentCache {
    return { sweepAt: 0, rootChildren: [], files: {} };
}

function freshCache(): MonitorCache {
    return {
        version: 3,
        agents: { claude: freshAgentCache(), codex: freshAgentCache(), grok: freshAgentCache() },
    };
}

function loadCache(storage: Storage): MonitorCache {
    const path = cachePath(storage);

    if (!existsSync(path)) {
        return freshCache();
    }

    try {
        const raw = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }) as MonitorCache;

        if (raw?.version === 3 && raw.agents) {
            const cache = freshCache();

            for (const id of AGENT_IDS) {
                const agent = raw.agents[id];

                if (agent?.files) {
                    cache.agents[id] = agent;
                }
            }

            return cache;
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
function fastCandidates(driver: MonitorDriver, roots: string[], cache: AgentCache, minMtimeMs: number): string[] {
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

        for (const file of findRecentTranscripts([child], minMtimeMs, driver)) {
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
            if (!entry.isFile() || !driver.isTranscript(entry.name)) {
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

function priceForDriver(driver: MonitorDriver, model: string, pricing: PricingTable): ModelPrice | null {
    for (const candidate of driver.priceCandidates(model)) {
        const price = pricing[candidate];

        if (price) {
            return price;
        }
    }

    return null;
}

interface ParseChunkOptions {
    driver: MonitorDriver;
    file: string;
    entry: FileCacheEntry;
    chunk: string;
    pricing: PricingTable;
}

function parseChunk(options: ParseChunkOptions): void {
    const { driver, entry, chunk, pricing } = options;
    const parser = driver.createParser({ file: options.file, state: entry.state });
    const seen = new Set(entry.recentIds);

    const emit = (event: DriverUsageEvent): void => {
        if (seen.has(event.id)) {
            return;
        }

        seen.add(event.id);
        entry.recentIds.push(event.id);

        const when = new Date(event.timestamp);

        if (Number.isNaN(when.getTime())) {
            return;
        }

        const day = localDayString(when);
        const tokens = event.inputTokens + event.outputTokens + event.cacheCreationTokens + event.cacheReadTokens;
        let cost = event.recordedCostUsd;

        if (cost === undefined) {
            const price = priceForDriver(driver, event.model, pricing);
            cost = price
                ? costOf(
                      {
                          input: event.inputTokens,
                          output: event.outputTokens,
                          cacheWrite: event.cacheCreationTokens,
                          cacheRead: event.cacheReadTokens,
                      },
                      price
                  )
                : 0;
        }

        let sums = entry.days[day];

        if (!sums) {
            sums = { cost: 0, tokens: 0 };
            entry.days[day] = sums;
        }

        sums.cost += cost;
        sums.tokens += tokens;
    };

    for (const line of chunk.split("\n")) {
        parser.parseLine(line, emit);
    }

    entry.state = parser.snapshot();

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
    /** Subset of agents to read. Defaults to all of them. */
    drivers?: readonly MonitorDriver[];
}

interface ScanResult {
    parsedFiles: number;
    recentFiles: number;
}

interface ScanOptions {
    driver: MonitorDriver;
    cache: AgentCache;
    home: string;
    now: Date;
    minMtimeMs: number;
    sweepTtlMs: number;
    pricing: PricingTable;
    tailReader: typeof readTail;
}

function scanAgent(options: ScanOptions): ScanResult {
    const { driver, cache, now, minMtimeMs, pricing, tailReader } = options;
    const roots = driver.roots(options.home);
    const sweepDue = now.getTime() - cache.sweepAt >= options.sweepTtlMs;
    let files: string[];

    if (sweepDue) {
        files = findRecentTranscripts(roots, minMtimeMs, driver);
        cache.sweepAt = now.getTime();
        cache.rootChildren = listRootChildren(roots);
    } else {
        files = fastCandidates(driver, roots, cache, minMtimeMs);
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
        parseChunk({ driver, file, entry, chunk, pricing });
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

    logger.debug(
        { agent: driver.id, roots, sweepDue, files: files.length, parsedFiles },
        "ai-spend monitor: agent scanned"
    );

    return { parsedFiles, recentFiles: files.length };
}

function emptyAgentTotals(): AgentTotals {
    return { today: { cost: 0, tokens: 0 }, week: { cost: 0, tokens: 0 } };
}

export function buildMonitorReport(options: BuildMonitorOptions): MonitorReport {
    const now = options.now ?? new Date();
    const home = options.home ?? homedir();
    const storage = options.storage ?? new Storage("ai-spend");
    const tailReader = options.readTailFn ?? readTail;
    const drivers = options.drivers ?? MONITOR_DRIVERS;
    const weekStartDate = mondayOfWeek(now);
    const todayDate = localDayString(now);
    const weekStart = localDayString(weekStartDate);
    const cache = loadCache(storage);
    const minMtimeMs = weekStartDate.getTime();
    const sweepTtlMs = options.sweepTtlMs ?? SWEEP_TTL_MS;
    const agents: Record<AgentId, AgentTotals> = {
        claude: emptyAgentTotals(),
        codex: emptyAgentTotals(),
        grok: emptyAgentTotals(),
    };
    let parsedFiles = 0;
    let recentFiles = 0;

    for (const driver of drivers) {
        const result = scanAgent({
            driver,
            cache: cache.agents[driver.id],
            home,
            now,
            minMtimeMs,
            sweepTtlMs,
            pricing: options.pricing,
            tailReader,
        });
        parsedFiles += result.parsedFiles;
        recentFiles += result.recentFiles;
    }

    atomicWriteFileSync(cachePath(storage), SafeJSON.stringify(cache, { strict: true }));

    const today: MonitorTotals = { cost: 0, tokens: 0 };
    const week: MonitorTotals = { cost: 0, tokens: 0 };

    for (const id of AGENT_IDS) {
        const totals = agents[id];

        for (const entry of Object.values(cache.agents[id].files)) {
            for (const [day, sums] of Object.entries(entry.days)) {
                if (day >= weekStart && day <= todayDate) {
                    totals.week.cost += sums.cost;
                    totals.week.tokens += sums.tokens;
                    week.cost += sums.cost;
                    week.tokens += sums.tokens;
                }

                if (day === todayDate) {
                    totals.today.cost += sums.cost;
                    totals.today.tokens += sums.tokens;
                    today.cost += sums.cost;
                    today.tokens += sums.tokens;
                }
            }
        }
    }

    return {
        today,
        week,
        todayDate,
        weekStart,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        agents,
        parsedFiles,
        recentFiles,
    };
}
