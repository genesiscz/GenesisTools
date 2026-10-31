import { createHash } from "node:crypto";
import {
    closeSync,
    existsSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    unlinkSync,
    writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type WalkError, walkFiles } from "@genesiscz/utils/fs/disk-usage";
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

/**
 * What the measurement pass and `approve` found for a request, one entry per path. On disk each path is its own file,
 * `<requests>/measured/<id>/<hash of the location>.json`, written whole: two processes that measure different paths
 * of one request never merge into a shared file, so neither can drop the other's entry.
 */
export interface RmRequestMeasurements {
    requestId: string;
    items: RmMeasuredItem[];
}

/**
 * How many walk entries (files and folders) pass between two event-loop turns, so a window's reply is read while a
 * big tree is walked.
 */
const YIELD_EVERY = 2000;

export function rmMeasurementsDir(requestsDir = rmRequestsDir()): string {
    return join(requestsDir, "measured");
}

function measurementsDir(id: string, requestsDir: string): string {
    return join(rmMeasurementsDir(requestsDir), id);
}

function locationKey(location: string): string {
    return createHash("sha256").update(location).digest("hex").slice(0, 24);
}

function lockFile(id: string, requestsDir: string): string {
    return join(rmMeasurementsDir(requestsDir), `${id}.lock`);
}

function isMeasuredItem(value: unknown): value is RmMeasuredItem {
    return (
        typeof value === "object" &&
        value !== null &&
        "path" in value &&
        typeof value.path === "string" &&
        "location" in value &&
        typeof value.location === "string" &&
        "mtimeMs" in value &&
        typeof value.mtimeMs === "number" &&
        "bytes" in value &&
        typeof value.bytes === "number"
    );
}

function readMeasuredItem(file: string): RmMeasuredItem | null {
    try {
        const parsed: unknown = SafeJSON.parse(readFileSync(file, "utf8"));
        return isMeasuredItem(parsed) ? parsed : null;
    } catch (error) {
        logger.debug({ file, error }, "rm: unreadable request measurement");
        return null;
    }
}

/** The saved measurements of request `id`; null when none were saved. */
export function loadRmMeasurements(id: string, requestsDir = rmRequestsDir()): RmRequestMeasurements | null {
    const dir = measurementsDir(id, requestsDir);

    if (!existsSync(dir)) {
        return null;
    }

    const items = readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => readMeasuredItem(join(dir, name)))
        .filter((item): item is RmMeasuredItem => item !== null);
    return { requestId: id, items };
}

/** The saved entry of one request path, read from its own file alone; null when none was saved. */
export function loadRmMeasurementOf(
    id: string,
    target: Pick<RmRequestTarget, "path" | "stored">,
    requestsDir = rmRequestsDir()
): RmMeasuredItem | null {
    const file = join(measurementsDir(id, requestsDir), `${locationKey(targetLocation(target))}.json`);
    return existsSync(file) ? readMeasuredItem(file) : null;
}

/** Saves `item` as request `id`'s entry for its location, replacing an older one; no other entry is read or written. */
export function saveRmMeasurement(id: string, item: RmMeasuredItem, requestsDir = rmRequestsDir()): void {
    const dir = measurementsDir(id, requestsDir);
    mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(join(dir, `${locationKey(item.location)}.json`), `${SafeJSON.stringify(item, null, 2)}\n`);
}

const LEDGER_DONE = "done";

function ledgerMarker(id: string, location: string, requestsDir: string): string {
    return join(measurementsDir(id, requestsDir), `${locationKey(location)}.ledger`);
}

/**
 * Claims the ledger line of `location` for this process: the marker is created with O_EXCL and holds this pid until
 * the line is written, then `done`. A marker of a process that died before it wrote the line is taken over, so a
 * crash between the claim and the write never loses the line. False when the line is written, or a live process
 * writes it now.
 */
function claimLedgerLine(marker: string): boolean {
    mkdirSync(dirname(marker), { recursive: true });

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const fd = openSync(marker, "wx");
            writeSync(fd, String(process.pid));
            closeSync(fd);
            return true;
        } catch (error) {
            const holder = readMarker(marker);

            if (holder === LEDGER_DONE || isProcessAlive(Number(holder))) {
                return false;
            }

            logger.debug({ marker, holder, error }, "rm: taking over the ledger line of a process that died");
            unlinkQuietly(marker);
        }
    }

    return false;
}

function readMarker(marker: string): string {
    try {
        return readFileSync(marker, "utf8").trim();
    } catch (error) {
        logger.debug({ marker, error }, "rm: unreadable ledger marker");
        return "";
    }
}

function unlinkQuietly(path: string): void {
    try {
        unlinkSync(path);
    } catch (error) {
        logger.debug({ path, error }, "rm: marker already gone");
    }
}

/**
 * Writes the size of an aside copy into the ledger once, for the audit's aside total: the aside move itself does not
 * measure. The marker is `done` only after the line is written; a failed write drops the claim, so the next
 * measurement pass (which runs this for fresh sizes too) writes it then.
 */
function logAsideSize(input: {
    request: Pick<RmRequest, "id" | "caller">;
    target: Pick<RmRequestTarget, "path" | "stored"> & Partial<Pick<RmRequestTarget, "rule">>;
    item: RmMeasuredItem;
    requestsDir: string;
}): void {
    const { request, target, item } = input;
    const marker = ledgerMarker(request.id, item.location, input.requestsDir);

    if (!target.stored || !claimLedgerLine(marker)) {
        return;
    }

    const written = appendRmLedger({
        action: "measure",
        path: target.path,
        stored: target.stored,
        rule: target.rule,
        bytes: item.bytes,
        requestId: request.id,
        caller: request.caller,
    });

    if (!written) {
        unlinkQuietly(marker);
        return;
    }

    try {
        atomicWriteFileSync(marker, LEDGER_DONE);
    } catch (error) {
        logger.warn({ marker, error }, "rm: could not mark an aside size as written to the ledger");
    }
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
 * `measureBytes` that gives the event loop a turn every few thousand entries, folders included: the CLI reads the
 * approval window's answer while it walks. `walkFiles` hands out files only and goes down into an empty folder
 * without one, so it lists one folder per call here and the folders below go on this function's own stack. Throws
 * the signal's reason when aborted. Null when any part of the tree could not be read (a folder it may not list, a
 * file it may not stat): a partial sum is not the size, and is never saved as one.
 */
export async function measureBytesAsync(path: string, signal?: AbortSignal): Promise<number | null> {
    let stat: ReturnType<typeof lstatSync>;

    try {
        stat = lstatSync(path);
    } catch (error) {
        logger.debug({ path, error }, "rm: cannot measure");
        return null;
    }

    if (!stat.isDirectory()) {
        return stat.blocks * 512;
    }

    let total = 0;
    let seen = 0;
    let unread: WalkError | null = null;
    const folders = [path];
    const below = (dir: string): false => {
        folders.push(dir);
        return false;
    };
    const onError = (error: WalkError): void => {
        unread ??= error;
    };

    try {
        while (folders.length > 0) {
            const dir = folders.pop() ?? path;

            for (const entry of walkFiles(dir, { signal, shouldEnter: below, onError })) {
                total += entry.allocated;
                seen++;

                if (seen % YIELD_EVERY === 0) {
                    await nextTurn();
                }
            }

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
        return null;
    }

    if (unread) {
        logger.debug({ path, unread }, "rm: part of the tree could not be read; its size is unknown");
        return null;
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

/** Measures one request path where it is now; null when nothing is there or part of it could not be read. */
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

    if (bytes === null) {
        return null;
    }

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
    /** `rule` keeps the aside bytes under the rule that set the copy aside in `tools rm log --by rule`. */
    target: Pick<RmRequestTarget, "path" | "stored"> & Partial<Pick<RmRequestTarget, "rule">>;
    item: RmMeasuredItem;
    requestsDir?: string;
}): void {
    const requestsDir = input.requestsDir ?? rmRequestsDir();
    saveRmMeasurement(input.request.id, input.item, requestsDir);
    logAsideSize({ ...input, requestsDir });
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
            // Each path reads its own file only: a pass over N paths reads N files, not N times the folder.
            const own = loadRmMeasurementOf(id, target, requestsDir);
            const fresh = freshMeasurement(own ? { requestId: id, items: [own] } : null, target);

            if (fresh) {
                // A fresh size whose ledger line failed earlier is written now.
                logAsideSize({ request, target, item: fresh, requestsDir });
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
