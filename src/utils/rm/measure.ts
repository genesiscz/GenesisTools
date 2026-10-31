import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { walkFiles } from "@genesiscz/utils/fs/disk-usage";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { type FolderStats, folderStats } from "./item-facts";
import { appendRmLedger } from "./ledger";
import { loadRmRequest, type RmRequest, type RmRequestTarget, rmRequestsDir } from "./requests";
import { acquireDrainerLock } from "./trash";

/**
 * The size facts of one request path, measured once and kept beside the request, so `tools rm approve` shows them
 * without walking the tree again. `mtimeMs` is the top path's change time when the walk started: a later change of
 * it (an entry added, removed or renamed at the top) makes the numbers stale.
 */
export interface RmMeasuredItem {
    /** The path the request names. */
    path: string;
    /** What was walked: the aside copy while it waits, else `path`. */
    location: string;
    /** When the walk started (ISO time). */
    at: string;
    mtimeMs: number;
    /** Allocated bytes, the way `measureBytes` counts them. */
    bytes: number;
    /** A folder with nothing in it. */
    empty?: boolean;
    folderStats?: FolderStats;
}

/** `<requests>/measured/<id>.json`: what the measurement pass found for a request, one entry per path. */
export interface RmRequestMeasurements {
    requestId: string;
    items: RmMeasuredItem[];
}

/** How many walk entries pass between two event-loop turns, so a window's reply is read while a big tree is walked. */
const YIELD_EVERY = 2000;

export function rmMeasurementsDir(requestsDir = rmRequestsDir()): string {
    return join(requestsDir, "measured");
}

function measurementsFile(id: string, requestsDir: string): string {
    return join(rmMeasurementsDir(requestsDir), `${id}.json`);
}

function lockFile(id: string, requestsDir: string): string {
    return join(rmMeasurementsDir(requestsDir), `${id}.lock`);
}

function isMeasurements(value: unknown): value is RmRequestMeasurements {
    return (
        typeof value === "object" &&
        value !== null &&
        "requestId" in value &&
        typeof value.requestId === "string" &&
        "items" in value &&
        Array.isArray(value.items)
    );
}

/** The saved measurements of request `id`; null when none were saved or the file cannot be read. */
export function loadRmMeasurements(id: string, requestsDir = rmRequestsDir()): RmRequestMeasurements | null {
    const file = measurementsFile(id, requestsDir);

    if (!existsSync(file)) {
        return null;
    }

    try {
        const parsed: unknown = SafeJSON.parse(readFileSync(file, "utf8"));
        return isMeasurements(parsed) ? parsed : null;
    } catch (error) {
        logger.debug({ file, error }, "rm: unreadable request measurements");
        return null;
    }
}

/** Saves `item` into request `id`'s measurements, replacing the entry for the same location. */
export function saveRmMeasurement(id: string, item: RmMeasuredItem, requestsDir = rmRequestsDir()): void {
    const saved = loadRmMeasurements(id, requestsDir)?.items ?? [];
    const items = [...saved.filter((other) => other.location !== item.location), item];
    mkdirSync(rmMeasurementsDir(requestsDir), { recursive: true });
    atomicWriteFileSync(
        measurementsFile(id, requestsDir),
        `${SafeJSON.stringify({ requestId: id, items }, null, 2)}\n`
    );
}

/** Where a request path is now: its aside copy while it waits, else the path itself. */
export function targetLocation(target: Pick<RmRequestTarget, "path" | "stored">): string {
    return target.stored ?? target.path;
}

function topMtimeMs(path: string): number | null {
    try {
        return lstatSync(path).mtimeMs;
    } catch (error) {
        logger.debug({ path, error }, "rm: cannot stat a measured path");
        return null;
    }
}

/** The saved entry for `target` when its top path has not changed since the walk; null when stale or missing. */
export function freshMeasurement(
    measurements: RmRequestMeasurements | null,
    target: Pick<RmRequestTarget, "path" | "stored">,
    mtimeOf: (path: string) => number | null = topMtimeMs
): RmMeasuredItem | null {
    const location = targetLocation(target);
    const item = measurements?.items.find((entry) => entry.location === location && entry.path === target.path);

    if (!item) {
        return null;
    }

    return mtimeOf(location) === item.mtimeMs ? item : null;
}

/** An event-loop turn, so a reply on a pipe and an abort get read in the middle of a long walk. */
function nextTurn(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

/**
 * `measureBytes` that gives the event loop a turn every few thousand entries: the CLI reads the approval window's
 * answer while it walks. Throws the signal's reason when aborted; 0 when the path cannot be read.
 */
export async function measureBytesAsync(path: string, signal?: AbortSignal): Promise<number> {
    let stat: ReturnType<typeof lstatSync>;

    try {
        stat = lstatSync(path);
    } catch (error) {
        logger.debug({ path, error }, "rm: cannot measure");
        return 0;
    }

    if (!stat.isDirectory()) {
        return stat.blocks * 512;
    }

    let total = 0;
    let seen = 0;

    try {
        for (const entry of walkFiles(path, { signal })) {
            total += entry.allocated;
            seen++;

            if (seen % YIELD_EVERY === 0) {
                await nextTurn();
            }
        }
    } catch (error) {
        if (signal?.aborted) {
            throw error;
        }

        logger.debug({ path, error }, "rm: cannot measure");
        return 0;
    }

    return total;
}

function isEmptyFolder(dir: string): boolean {
    try {
        return readdirSync(dir).length === 0;
    } catch (error) {
        logger.debug({ error, dir }, "rm: could not list a folder to measure");
        return false;
    }
}

/** Measures one request path where it is now; null when nothing is there. */
export async function measureTarget(
    target: Pick<RmRequestTarget, "path" | "stored">,
    options: { now?: () => Date; signal?: AbortSignal } = {}
): Promise<RmMeasuredItem | null> {
    const location = targetLocation(target);
    const at = (options.now ?? (() => new Date()))().toISOString();
    let stat: ReturnType<typeof lstatSync>;

    try {
        stat = lstatSync(location);
    } catch (error) {
        logger.debug({ location, error }, "rm: nothing to measure");
        return null;
    }

    const bytes = await measureBytesAsync(location, options.signal);
    const item: RmMeasuredItem = { path: target.path, location, at, mtimeMs: stat.mtimeMs, bytes };

    if (!stat.isDirectory()) {
        return item;
    }

    return { ...item, empty: isEmptyFolder(location), folderStats: folderStats(location) };
}

/**
 * Saves a measurement of one of `request`'s paths. The first size of an aside copy also goes into the ledger, for the
 * audit's aside total: the aside move itself no longer measures, so the asking run does not wait for the walk.
 */
export function recordRmMeasurement(input: {
    request: Pick<RmRequest, "id" | "caller">;
    target: Pick<RmRequestTarget, "path" | "stored">;
    item: RmMeasuredItem;
    requestsDir?: string;
}): void {
    const { request, target, item } = input;
    const requestsDir = input.requestsDir ?? rmRequestsDir();
    const known = loadRmMeasurements(request.id, requestsDir)?.items.some((entry) => entry.location === item.location);
    saveRmMeasurement(request.id, item, requestsDir);

    if (target.stored && !known) {
        appendRmLedger({
            action: "measure",
            path: target.path,
            stored: target.stored,
            bytes: item.bytes,
            requestId: request.id,
            caller: request.caller,
        });
    }
}

/** A live process measures request `id` now. */
export function isRmMeasurementRunning(id: string, requestsDir = rmRequestsDir()): boolean {
    const file = lockFile(id, requestsDir);

    if (!existsSync(file)) {
        return false;
    }

    try {
        return isProcessAlive(Number(readFileSync(file, "utf8").trim()));
    } catch (error) {
        logger.debug({ file, error }, "rm: unreadable measurement lock");
        return false;
    }
}

export interface MeasureRequestResult {
    /** The paths walked by this pass. */
    measured: number;
    /** The paths whose saved numbers were still fresh. */
    fresh: number;
    /** Another pass holds the request's lock: this one did nothing. */
    busy: boolean;
}

/**
 * The measurement pass `tools rm` starts when it opens a delete request: each path that has no fresh entry is walked
 * and saved at once, so `approve` reads what is done even while the pass still runs. One pass per request at a time.
 */
export async function measureRmRequest(
    id: string,
    options: { requestsDir?: string; now?: () => Date } = {}
): Promise<MeasureRequestResult> {
    const requestsDir = options.requestsDir ?? rmRequestsDir();
    const request = loadRmRequest(id, requestsDir);
    const result: MeasureRequestResult = { measured: 0, fresh: 0, busy: false };

    if (request?.status !== "pending" || request.kind !== "delete") {
        logger.debug({ id, status: request?.status }, "rm: no pending delete request to measure");
        return result;
    }

    const release = acquireDrainerLock(lockFile(id, requestsDir));

    if (!release) {
        return { ...result, busy: true };
    }

    try {
        for (const target of request.targets) {
            const saved = loadRmMeasurements(id, requestsDir);

            if (freshMeasurement(saved, target)) {
                result.fresh++;
                continue;
            }

            const item = await measureTarget(target, { now: options.now });

            if (item) {
                recordRmMeasurement({ request, target, item, requestsDir });
                result.measured++;
            }
        }
    } finally {
        release();
    }

    logger.debug({ id, ...result }, "rm: request measured");
    return result;
}
