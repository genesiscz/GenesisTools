import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import type { DiscoveredHome } from "@genesiscz/utils/ai/providers/account-features";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync, type Storage } from "@genesiscz/utils/storage/storage";
import { accountIdForFile, resolveDriverRoots } from "./account-roots";
import { type AgentId, MONITOR_DRIVERS, type MonitorDriver } from "./drivers";
import { findRecentTranscripts, readTail } from "./monitor";
import { priceFor } from "./pricing";
import { totalTokensOf } from "./reports/cost";
import { pricedEventCost } from "./reports/load";
import { parseNativeChunk } from "./reports/native";
import type { PricingTable } from "./types";

/**
 * Incremental event store behind `buildSpendSeries`.
 *
 * `reports/` has no caching at all: every `daily`/`session` run re-reads every
 * transcript in the window. A dashboard polling a series would pay that on each
 * refresh, so this keeps per-file `{ size, mtimeMs, offset, events }` and reads
 * only appended bytes, exactly like `monitor.ts` does for its day sums.
 *
 * What it caches is COMPACTED: timestamp, cost, tokens, model, source. The cost
 * is priced once, at parse time, from the table the caller passed. A user
 * pricing override therefore only affects events parsed after it, which is the
 * same trade the monitor cache already makes.
 */

/** Rolling window the cache keeps. Older events are dropped on every write. */
export const AI_SPEND_SERIES_RETENTION_DAYS = 90;

const CACHE_VERSION = 1;

/** Same bound as the monitor: duplicates of one event sit adjacent in a transcript. */
const RECENT_ID_WINDOW = 50;

export interface CompactEvent {
    /** ISO-8601 instant of the event. */
    t: string;
    costUsd: number;
    tokens: number;
    /** Stamped fresh on every read from the current root map, never from disk. */
    accountId?: string;
    model?: string;
    source: AgentId;
    /**
     * No rate was known, so `costUsd` is 0 by absence rather than by price.
     * Surfaced as `unpriced` on the series so a total can say how much of
     * itself is missing.
     */
    unpriced?: boolean;
}

interface FileEntry {
    size: number;
    mtimeMs: number;
    offset: number;
    events: CompactEvent[];
    recentIds: string[];
    state?: unknown;
}

interface EventsCache {
    version: number;
    files: Record<string, FileEntry>;
}

export interface CollectSeriesEventsOptions {
    storage: Storage;
    pricing: PricingTable;
    /** User home directory the default roots hang off. */
    home: string;
    sources: readonly AgentId[];
    /** Transcripts older than this are never opened (append-only files). */
    minMtimeMs: number;
    accounts?: readonly AccountEntry[];
    discoveredHomes?: Partial<Record<AgentId, readonly DiscoveredHome[]>>;
    /** Injectable, so a test can assert an unchanged file is never re-read. */
    readTailFn?: typeof readTail;
    /** Driver subset; tests supply fixture drivers that bind roots to accounts. */
    drivers?: readonly MonitorDriver[];
    now?: Date;
}

function cachePath(storage: Storage): string {
    return join(storage.getCacheDir(), "events-cache.json");
}

function freshCache(): EventsCache {
    return { version: CACHE_VERSION, files: {} };
}

function loadCache(storage: Storage): EventsCache {
    const path = cachePath(storage);

    if (!existsSync(path)) {
        return freshCache();
    }

    try {
        const raw = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }) as EventsCache;

        if (raw?.version === CACHE_VERSION && raw.files) {
            return raw;
        }

        logger.debug({ path, version: raw?.version }, "ai-spend series: cache version mismatch, rebuilding");
    } catch (err) {
        logger.debug({ err, path }, "ai-spend series: cache unreadable, rebuilding");
    }

    return freshCache();
}

function freshEntry(): FileEntry {
    return { size: 0, mtimeMs: 0, offset: 0, events: [], recentIds: [] };
}

function compact(
    event: { model: string; timestamp: string; recordedCostUsd?: number },
    options: { costUsd: number; tokens: number; source: AgentId; priced: boolean }
): CompactEvent {
    const compacted: CompactEvent = {
        t: event.timestamp,
        costUsd: options.costUsd,
        tokens: options.tokens,
        model: event.model,
        source: options.source,
    };

    if (!options.priced && event.recordedCostUsd === undefined) {
        compacted.unpriced = true;
    }

    return compacted;
}

/**
 * Prune to the retention window, then persist.
 *
 * A file whose every event aged out keeps its row: the offset and the driver
 * resume state are what stop the next run from re-reading it from byte zero.
 */
function pruneAndSave(cache: EventsCache, storage: Storage, now: Date): void {
    const cutoff = now.getTime() - AI_SPEND_SERIES_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    for (const [file, entry] of Object.entries(cache.files)) {
        if (!existsSync(file)) {
            delete cache.files[file];
            continue;
        }

        entry.events = entry.events.filter((event) => {
            const at = Date.parse(event.t);
            return !Number.isNaN(at) && at >= cutoff;
        });
    }

    atomicWriteFileSync(cachePath(storage), SafeJSON.stringify(cache, { strict: true }));
}

/**
 * Every cached event of every transcript in the window, tagged with the account
 * that owns its root TODAY.
 *
 * Attribution is re-stamped per run rather than read back from the cache: an
 * account bound after the file was first parsed must not leave those events
 * reported as unbound forever.
 */
export function collectSeriesEvents(options: CollectSeriesEventsOptions): CompactEvent[] {
    const now = options.now ?? new Date();
    const tailReader = options.readTailFn ?? readTail;
    const drivers = options.drivers ?? MONITOR_DRIVERS;
    const wanted = new Set(options.sources);
    const cache = loadCache(options.storage);
    const collected: CompactEvent[] = [];

    for (const driver of drivers) {
        if (!wanted.has(driver.id)) {
            continue;
        }

        const roots = resolveDriverRoots({
            driver,
            userHome: options.home,
            accounts: options.accounts,
            discoveredHomes: options.discoveredHomes?.[driver.id],
        });
        const files = findRecentTranscripts(
            roots.map((root) => root.path),
            options.minMtimeMs,
            driver
        );

        for (const file of files) {
            let stat: import("node:fs").Stats;

            try {
                stat = statSync(file);
            } catch (err) {
                logger.debug({ err, file }, "ai-spend series: file vanished mid-run");
                delete cache.files[file];
                continue;
            }

            const cached = cache.files[file];
            let entry: FileEntry;

            if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
                entry = cached;
            } else {
                entry = cached && stat.size >= cached.offset && cached.offset > 0 ? cached : freshEntry();
                readAppendedBytes({ driver, entry, file, size: stat.size, tailReader, pricing: options.pricing });
                entry.size = stat.size;
                entry.mtimeMs = stat.mtimeMs;
                cache.files[file] = entry;
            }

            const accountId = accountIdForFile(file, roots);

            for (const event of entry.events) {
                event.accountId = accountId;
                collected.push(event);
            }
        }
    }

    pruneAndSave(cache, options.storage, now);

    logger.debug(
        { events: collected.length, files: Object.keys(cache.files).length, sources: [...wanted] },
        "ai-spend series: events collected"
    );

    return collected;
}

interface ReadAppendedOptions {
    driver: MonitorDriver;
    entry: FileEntry;
    file: string;
    size: number;
    tailReader: typeof readTail;
    pricing: PricingTable;
}

function readAppendedBytes(options: ReadAppendedOptions): void {
    const { driver, entry, file, pricing } = options;
    const chunk = options.tailReader(file, entry.offset, options.size);
    // A live agent appends to these files, so a stat can land mid-line. Parse
    // only through the last newline and leave the offset there; the fragment is
    // re-read whole once the writer finishes it.
    const lastNewline = chunk.lastIndexOf("\n");
    const complete = lastNewline >= 0 ? chunk.slice(0, lastNewline + 1) : "";
    const parsed = parseNativeChunk({ driver, source: driver.id, file, chunk: complete, state: entry.state });
    const seen = new Set(entry.recentIds);

    for (const event of parsed.events) {
        if (Number.isNaN(Date.parse(event.timestamp))) {
            logger.debug({ agent: driver.id, id: event.id }, "ai-spend series: event has no usable timestamp");
            continue;
        }

        if (seen.has(event.id)) {
            continue;
        }

        seen.add(event.id);
        entry.recentIds.push(event.id);

        const priced = driver.priceCandidates(event.model).some((candidate) => priceFor(candidate, pricing) !== null);
        entry.events.push(
            compact(event, {
                costUsd: pricedEventCost(event, pricing, "auto"),
                tokens: totalTokensOf(event),
                source: driver.id,
                priced,
            })
        );
    }

    entry.state = parsed.state;
    entry.offset += Buffer.byteLength(complete, "utf8");

    if (entry.recentIds.length > RECENT_ID_WINDOW) {
        entry.recentIds = entry.recentIds.slice(-RECENT_ID_WINDOW);
    }
}
