import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import type { DiscoveredHome } from "@genesiscz/utils/ai/providers/account-features";
import { CLAUDE_ALL_ACCOUNT_ID, CLAUDE_ALL_ACCOUNT_NAME, UNBOUND_ACCOUNT_ID } from "@genesiscz/utils/ai/usage";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync, Storage } from "@genesiscz/utils/storage/storage";
import { accountIdForFile, resolveDriverRoots } from "./account-roots";
import {
    AGENT_IDS,
    AGENT_PLUGIN_IDS,
    type AgentId,
    type DriverUsageEvent,
    MONITOR_DRIVERS,
    type MonitorDriver,
} from "./drivers";
import { costOf, resolvePrice } from "./pricing";
import type { ModelPriceEntry, PricingTable } from "./types";

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

/**
 * One account's slice of the same today/week windows.
 *
 * Claude contributes exactly ONE row, `CLAUDE_ALL_ACCOUNT_ID`, because
 * `~/.claude/projects` carries no account marker (campaign decision D6).
 * Transcripts under a home no account claims report as `UNBOUND_ACCOUNT_ID`.
 */
export interface MonitorAccountSpend {
    accountId: string;
    accountName: string;
    /** Plugin id: `anthropic-sub`, `openai-sub`, `grok-sub`. */
    provider: string;
    source: AgentId;
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
    /**
     * Per-account split, when the caller passed accounts. Sums to the top level
     * as well, so `today.cost` never moves because this key appeared — the
     * Genesis app decodes those four leaves strictly and ignores the rest.
     */
    accounts?: MonitorAccountSpend[];
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

/** All transcripts under `roots` whose mtime is >= minMtimeMs, per the driver's file test. */
export function findRecentTranscripts(roots: string[], minMtimeMs: number, driver: MonitorDriver): string[] {
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
                if (depth < driver.maxDepth) {
                    walk(full, depth + 1);
                }

                continue;
            }

            if (!entry.isFile() || !driver.isTranscript(entry.name)) {
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
    /**
     * Account the file's root belonged to on the LAST run, re-stamped every run
     * from the current root map. Never trusted across runs: binding a home to
     * an account later must not leave the cached rows tagged unbound.
     */
    accountId?: string;
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

/**
 * Bumped to 4 when file rows gained `accountId`: a v3 row has no account tag,
 * and reporting it under "(unbound)" would be a guess. Discarding the file
 * costs one full re-parse and gets every row tagged from the live root map.
 */
interface MonitorCache {
    version: 4;
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
        version: 4,
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

        if (raw?.version === 4 && raw.agents) {
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

    // ⚠️ This block MUTATES `cache.rootChildren`, and the caller persists the
    // cache afterwards. That is deliberate: a project directory created since
    // the last sweep has to be recorded, or every later fast pass would rescan
    // it from scratch. Keep the mutation here rather than hiding it in a helper
    // that reads as pure discovery.
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

/**
 * Read the file from `offset` to EOF (append-only tail).
 *
 * Exported because the series event cache (`events-cache.ts`) needs the exact
 * same incremental read: two implementations of "parse only what was appended"
 * would drift, and the one that drifted would silently lose events.
 */
export function readTail(path: string, offset: number, size: number): string {
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

/**
 * Returns the catalog ENTRY, not a flat price. The caller resolves it against
 * the event's own timestamp and size — a dated promotion or a long-context band
 * only means something per event.
 *
 * This used to return `ModelPrice`, and because `ModelPriceEntry extends
 * ModelPrice` the rules were dropped with no type error: the monitor billed
 * every event at the list rate while aggregate.ts honoured the rules.
 */
function priceForDriver(driver: MonitorDriver, model: string, pricing: PricingTable): ModelPriceEntry | null {
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
        const when = new Date(event.timestamp);

        // Validate BEFORE the dedup bookkeeping. Recording the id first would burn
        // it on an unusable event, and a later well-formed record carrying the same
        // id (a streaming rewrite that finally has a timestamp) would be suppressed.
        if (Number.isNaN(when.getTime())) {
            logger.debug({ agent: driver.id, id: event.id }, "ai-spend monitor: event has no usable timestamp");

            return;
        }

        if (seen.has(event.id)) {
            return;
        }

        seen.add(event.id);
        entry.recentIds.push(event.id);

        const day = localDayString(when);
        const tokens = event.inputTokens + event.outputTokens + event.cacheCreationTokens + event.cacheReadTokens;
        let cost = event.recordedCostUsd;

        if (cost === undefined) {
            const entry = priceForDriver(driver, event.model, pricing);
            cost = entry
                ? costOf(
                      {
                          input: event.inputTokens,
                          output: event.outputTokens,
                          cacheWrite: event.cacheCreationTokens,
                          cacheRead: event.cacheReadTokens,
                      },
                      resolvePrice(entry, {
                          at: Number.isNaN(when.getTime()) ? undefined : when,
                          contextTokens: event.inputTokens + event.cacheReadTokens + event.cacheCreationTokens,
                      })
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
    /** Enabled accounts, so transcripts under their homes carry an account id. */
    accounts?: readonly AccountEntry[];
    /**
     * Extra homes on disk, per agent, from `--all-homes`. The caller awaits
     * `plugin.accounts.discoverHomes()` — this function stays synchronous, and
     * every reader of the monitor with it.
     */
    discoveredHomes?: Partial<Record<AgentId, readonly DiscoveredHome[]>>;
    /**
     * Report only these account rows, and only their spend. `"(unbound)"` and
     * `"claude-all"` are valid entries. Absent means every account, which is
     * what the Genesis app asks for.
     */
    accountIds?: readonly string[];
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
    accounts?: readonly AccountEntry[];
    discoveredHomes?: readonly DiscoveredHome[];
}

function scanAgent(options: ScanOptions): ScanResult {
    const { driver, cache, now, minMtimeMs, pricing, tailReader } = options;
    const driverRoots = resolveDriverRoots({
        driver,
        userHome: options.home,
        accounts: options.accounts,
        discoveredHomes: options.discoveredHomes,
    });
    const roots = driverRoots.map((root) => root.path);
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
        // A live agent appends to these files, so a stat can land mid-line. Parse
        // only through the last newline and leave the offset there: the trailing
        // fragment is re-read whole once the writer finishes it. Advancing to
        // stat.size instead would split that line across two runs, and neither
        // half would parse, so the request would never be counted.
        const lastNewline = chunk.lastIndexOf("\n");
        const complete = lastNewline >= 0 ? chunk.slice(0, lastNewline + 1) : "";
        parseChunk({ driver, file, entry, chunk: complete, pricing });
        entry.offset += Buffer.byteLength(complete, "utf8");
        entry.size = stat.size;
        entry.mtimeMs = stat.mtimeMs;
        cache.files[file] = entry;
        parsedFiles++;
    }

    // Re-stamped for every candidate, not just the parsed ones: binding a home
    // to an account does not touch the transcripts, so a cache-hit file would
    // otherwise keep yesterday's unbound tag forever.
    for (const file of files) {
        const entry = cache.files[file];

        if (entry) {
            entry.accountId = accountIdForFile(file, driverRoots);
        }
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

/**
 * Which account row a file's spend lands in.
 *
 * Claude collapses to one synthetic row: its transcripts record no login
 * (decision D6). Every other agent reports its own account, or the unbound row
 * when nothing claims that home — spend on an unbound home is still spend, so
 * it is never silently dropped.
 */
function accountRowId(agent: AgentId, fileAccountId: string | undefined): string {
    if (agent === "claude") {
        return CLAUDE_ALL_ACCOUNT_ID;
    }

    return fileAccountId ?? UNBOUND_ACCOUNT_ID;
}

function newAccountRow(agent: AgentId, rowId: string, accounts: readonly AccountEntry[]): MonitorAccountSpend {
    const provider = AGENT_PLUGIN_IDS[agent];
    const empty = { today: { cost: 0, tokens: 0 }, week: { cost: 0, tokens: 0 } };

    if (rowId === CLAUDE_ALL_ACCOUNT_ID) {
        return { accountId: rowId, accountName: CLAUDE_ALL_ACCOUNT_NAME, provider, source: agent, ...empty };
    }

    const account = accounts.find((candidate) => candidate.id === rowId);

    return {
        accountId: rowId,
        // The unbound row prints its own marker; a bound row whose account has
        // since been deleted falls back to the id rather than inventing a name.
        accountName: account?.name ?? rowId,
        provider: account?.provider ?? provider,
        source: agent,
        ...empty,
    };
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
            accounts: options.accounts,
            discoveredHomes: options.discoveredHomes?.[driver.id],
        });
        parsedFiles += result.parsedFiles;
        recentFiles += result.recentFiles;
    }

    atomicWriteFileSync(cachePath(storage), SafeJSON.stringify(cache, { strict: true }));

    const today: MonitorTotals = { cost: 0, tokens: 0 };
    const week: MonitorTotals = { cost: 0, tokens: 0 };

    // Only the agents scanned on this run may contribute. An unscanned agent still
    // has cached day sums on disk, and reporting those next to freshly refreshed
    // ones would silently mix stale and current figures.
    const scanned = new Set(drivers.map((driver) => driver.id));
    const wantedAccounts = options.accountIds ? new Set(options.accountIds) : undefined;
    // Keyed by agent AND account: the unbound codex row and the unbound grok row
    // are two different piles of money.
    const rows = new Map<string, MonitorAccountSpend>();

    for (const id of AGENT_IDS) {
        if (!scanned.has(id)) {
            continue;
        }

        const totals = agents[id];

        for (const entry of Object.values(cache.agents[id].files)) {
            const rowId = accountRowId(id, entry.accountId);

            // `--account` restricts the totals too, not just the breakdown: a
            // number labelled "one account" that summed every account would be
            // worse than no number at all. Genesis passes no filter, so its four
            // leaves stay the full sum.
            if (wantedAccounts && !wantedAccounts.has(rowId)) {
                continue;
            }

            const key = `${id}:${rowId}`;
            let row = rows.get(key);

            if (!row) {
                row = newAccountRow(id, rowId, options.accounts ?? []);
                rows.set(key, row);
            }

            for (const [day, sums] of Object.entries(entry.days)) {
                if (day >= weekStart && day <= todayDate) {
                    totals.week.cost += sums.cost;
                    totals.week.tokens += sums.tokens;
                    week.cost += sums.cost;
                    week.tokens += sums.tokens;
                    row.week.cost += sums.cost;
                    row.week.tokens += sums.tokens;
                }

                if (day === todayDate) {
                    totals.today.cost += sums.cost;
                    totals.today.tokens += sums.tokens;
                    today.cost += sums.cost;
                    today.tokens += sums.tokens;
                    row.today.cost += sums.cost;
                    row.today.tokens += sums.tokens;
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
        accounts: accountBreakdown(rows, options),
        parsedFiles,
        recentFiles,
    };
}

/**
 * The `accounts` array, or nothing at all.
 *
 * Nothing when the caller never asked about accounts: a bare `monitor` would
 * otherwise grow an "(unbound)" row that is a verbatim copy of `agents.codex`,
 * which reads like a finding and is only an artefact. Rows that earned nothing
 * this week are dropped for the same reason.
 */
function accountBreakdown(
    rows: Map<string, MonitorAccountSpend>,
    options: BuildMonitorOptions
): MonitorAccountSpend[] | undefined {
    const asked =
        (options.accounts?.length ?? 0) > 0 ||
        options.discoveredHomes !== undefined ||
        options.accountIds !== undefined;

    if (!asked) {
        return undefined;
    }

    return [...rows.values()]
        .filter((row) => row.week.tokens > 0 || row.week.cost > 0)
        .sort((a, b) => a.accountName.localeCompare(b.accountName) || a.source.localeCompare(b.source));
}
