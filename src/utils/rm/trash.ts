import { createHash, randomBytes } from "node:crypto";
import {
    closeSync,
    existsSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmdirSync,
    statSync,
    unlinkSync,
    writeSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { createStopwatch } from "@genesiscz/utils/format";
import { walkFiles } from "@genesiscz/utils/fs/disk-usage";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { isTrashRootName, type RmConfig, rmDataDir } from "./config";
import { appendRmLedger } from "./ledger";
import { canonicalPath, isInside, mountPointOf, pathSegments, realOrSelf, VOLUME_TRASH_DIR } from "./paths";
import type { RmCaller, RmTarget, RmTargetKind } from "./rules";

export interface TrashItem {
    original: string;
    stored: string;
    kind: RmTargetKind;
    rule: string;
    /** Allocated bytes, measured right after the move. */
    bytes?: number;
}

/** One `tools rm` run's moved-aside items. The record lives in `~/.genesis-tools/rm/batches/<id>.json`. */
export interface TrashBatch {
    id: string;
    createdAt: string;
    /** When the drain may delete the items; until then `tools rm restore` brings them back. */
    drainAfter: string;
    caller: RmCaller | null;
    items: TrashItem[];
}

export interface TrashPaths {
    /** Where batch records live. */
    batchesDir: string;
    /** The drainer's single-instance lock. */
    lockPath: string;
}

export function defaultTrashPaths(): TrashPaths {
    return { batchesDir: rmDataDir("batches"), lockPath: rmDataDir("drainer.lock") };
}

export function newBatchId(now: Date = new Date()): string {
    const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    return `${stamp}-${process.pid}-${randomBytes(2).toString("hex")}`;
}

/** A stored name that stays short and unique: a hash of the full path, then the original name. */
export function trashItemName(index: number, path: string): string {
    const hash = createHash("sha256").update(path).digest("hex").slice(0, 8);
    const name = basename(path)
        .replace(/[^\w.-]/g, "_")
        .slice(0, 100);
    return `${index}-${hash}-${name}`;
}

/** The trash folder for `target`: the configured root on its volume, else `.GenesisTools-rm` at the target's mount. */
export function trashRootFor(target: RmTarget, config: RmConfig): string {
    mkdirSync(config.trashRoot, { recursive: true });

    if (lstatSync(target.path).dev === statSync(config.trashRoot).dev) {
        return realOrSelf(config.trashRoot);
    }

    return join(mountPointOf(dirname(target.path)), VOLUME_TRASH_DIR);
}

/**
 * Throws unless `path` lies inside a trash root: inside the configured root, or below a `.GenesisTools-rm`
 * folder. `level` is how deep it must be: `item` (`<root>/<batch>/<item>`) or `batch` (`<root>/<batch>`). Every
 * deletion this module makes goes through it, so a bug that builds a wrong path deletes nothing.
 */
export function assertInsideTrash(path: string, config: RmConfig, level: "item" | "batch"): void {
    if (!path || !isAbsolute(path) || pathSegments(path).includes("..")) {
        throw new Error(`rm: refusing to delete ${SafeJSON.stringify(path)}: not an absolute plain path`);
    }

    if (!isTrashRootName(config.trashRoot)) {
        throw new Error(`rm: refusing to delete: the trash root ${config.trashRoot} has no GenesisTools folder in it`);
    }

    const real = canonicalPath(path);
    const minDepth = level === "item" ? 2 : 1;
    const configured = realOrSelf(config.trashRoot);
    const segments = pathSegments(real);
    const volumeIndex = segments.lastIndexOf(VOLUME_TRASH_DIR);
    let depth = -1;

    if (isInside(real, configured)) {
        depth = pathSegments(relative(configured, real)).length;
    } else if (volumeIndex >= 0) {
        depth = segments.length - volumeIndex - 1;
    }

    if (depth < minDepth) {
        throw new Error(`rm: refusing to delete ${real}: it is not inside a trash folder at ${level} depth`);
    }
}

export interface MoveRequest {
    target: RmTarget;
    rule: string;
    /** The path to record and restore to, when `target` is not where the item came from (an aside copy). */
    original?: string;
    /** A size already measured (an aside copy), so the move does not walk the tree again. */
    bytes?: number;
}

export interface MoveOptions {
    config: RmConfig;
    caller: RmCaller | null;
    graceMinutes: number;
    paths?: TrashPaths;
    now?: Date;
}

/**
 * Renames each target into a new batch (instant on one volume) and records the batch after every move, so a crash
 * halfway leaves a record of what moved. Returns the batch, or null when nothing moved.
 */
export function moveToTrash(requests: readonly MoveRequest[], options: MoveOptions): TrashBatch | null {
    if (requests.length === 0) {
        return null;
    }

    const now = options.now ?? new Date();
    const paths = options.paths ?? defaultTrashPaths();
    const batch: TrashBatch = {
        id: newBatchId(now),
        createdAt: now.toISOString(),
        drainAfter: new Date(now.getTime() + options.graceMinutes * 60_000).toISOString(),
        caller: options.caller,
        items: [],
    };

    for (const [index, request] of requests.entries()) {
        const name = trashItemName(index, request.target.path);
        let stored = join(trashRootFor(request.target, options.config), batch.id, name);

        try {
            mkdirSync(dirname(stored), { recursive: true });
            renameSync(request.target.path, stored);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
                throw error;
            }

            // The device check said one volume but the rename crossed two (a firmlink, a bind mount): fall back
            // to the trash at the target's own mount point, where the rename stays a rename.
            stored = join(mountPointOf(dirname(request.target.path)), VOLUME_TRASH_DIR, batch.id, name);
            logger.debug({ path: request.target.path, stored }, "rm: cross-volume rename, using the volume's trash");
            mkdirSync(dirname(stored), { recursive: true });
            renameSync(request.target.path, stored);
        }

        const original = request.original ?? request.target.path;
        const bytes = request.bytes ?? measureBytes(stored);
        batch.items.push({ original, stored, kind: request.target.kind, rule: request.rule, bytes });
        writeBatch(batch, paths);
        appendRmLedger({
            action: "move",
            path: original,
            stored,
            batchId: batch.id,
            rule: request.rule,
            bytes,
            caller: options.caller,
        });
        logger.debug({ path: request.target.path, stored, batch: batch.id }, "rm: moved aside");
    }

    return batch;
}

function batchFile(paths: TrashPaths, id: string): string {
    return join(paths.batchesDir, `${id}.json`);
}

function writeBatch(batch: TrashBatch, paths: TrashPaths, file = batchFile(paths, batch.id)): void {
    mkdirSync(paths.batchesDir, { recursive: true });
    atomicWriteFileSync(file, `${SafeJSON.stringify(batch, null, 2)}\n`);
}

function isTrashBatch(value: unknown): value is TrashBatch {
    return (
        typeof value === "object" &&
        value !== null &&
        "id" in value &&
        typeof value.id === "string" &&
        "drainAfter" in value &&
        typeof value.drainAfter === "string" &&
        "items" in value &&
        Array.isArray(value.items)
    );
}

function readBatch(file: string): TrashBatch | null {
    try {
        const parsed: unknown = SafeJSON.parse(readFileSync(file, "utf8"));
        return isTrashBatch(parsed) ? parsed : null;
    } catch (error) {
        logger.debug({ file, error }, "rm: unreadable batch record");
        return null;
    }
}

/** Batches waiting for the drain (claimed ones excluded), oldest first. */
export function listBatches(paths: TrashPaths = defaultTrashPaths()): TrashBatch[] {
    if (!existsSync(paths.batchesDir)) {
        return [];
    }

    return readdirSync(paths.batchesDir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => readBatch(join(paths.batchesDir, name)))
        .filter((batch): batch is TrashBatch => batch !== null)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Claims a batch record for one process by renaming it; null when another process got it first. */
function claimBatch(paths: TrashPaths, id: string, purpose: "draining" | "restoring"): string | null {
    const claimed = join(paths.batchesDir, `${id}.json.${purpose}-${process.pid}`);

    try {
        renameSync(batchFile(paths, id), claimed);
        return claimed;
    } catch (error) {
        logger.debug({ id, error }, "rm: batch already claimed or gone");
        return null;
    }
}

/** Allocated bytes of a file or folder tree, without following symlinks; 0 when it cannot be read. */
export function measureBytes(path: string): number {
    try {
        const stat = lstatSync(path);

        if (!stat.isDirectory()) {
            return stat.blocks * 512;
        }

        let total = 0;

        for (const entry of walkFiles(path)) {
            total += entry.allocated;
        }

        return total;
    } catch (error) {
        logger.debug({ path, error }, "rm: cannot measure");
        return 0;
    }
}

function removeEmptyBatchDirs(batch: TrashBatch, config: RmConfig): void {
    for (const dir of new Set(batch.items.map((item) => dirname(item.stored)))) {
        try {
            assertInsideTrash(dir, config, "batch");

            if (existsSync(dir) && readdirSync(dir).length === 0) {
                rmdirSync(dir);
            }
        } catch (error) {
            logger.debug({ dir, error }, "rm: batch folder kept");
        }
    }
}

export interface DrainResult {
    batches: number;
    items: number;
    bytes: number;
}

/** One deleted item, for a caller that prints progress (`tools rm drain --now`). */
export interface DrainProgress {
    path: string;
    bytes: number;
    elapsed: string;
}

/**
 * Measures and deletes one stored item. Bun runs each `rm` on its thread pool, so a batch's items (and several
 * batches) delete in parallel, the way the reference tool started one `rm -rf` per orphan.
 */
async function deleteStored(path: string, config: RmConfig, level: "item" | "batch"): Promise<number> {
    assertInsideTrash(path, config, level);
    const size = measureBytes(path);
    await rm(path, { recursive: true, force: true });
    return size;
}

/** Deletes one claimed batch's items in parallel, each checked by `assertInsideTrash` first. */
async function drainClaimed(
    batch: TrashBatch,
    claimedFile: string,
    config: RmConfig,
    onItem?: (progress: DrainProgress) => void
): Promise<DrainResult> {
    const present = batch.items.filter((item) => existsSync(item.stored) || isBrokenLink(item.stored));
    const sizes = await Promise.all(
        present.map(async (item) => {
            const elapsed = createStopwatch();
            const size = await deleteStored(item.stored, config, "item");
            appendRmLedger({
                action: "drain",
                path: item.original,
                batchId: batch.id,
                rule: item.rule,
                bytes: size,
                caller: batch.caller,
            });
            onItem?.({ path: item.original, bytes: size, elapsed: elapsed() });
            return size;
        })
    );
    const bytes = sizes.reduce((sum, size) => sum + size, 0);
    removeEmptyBatchDirs(batch, config);
    unlinkSync(claimedFile);
    logger.debug({ batch: batch.id, items: present.length, bytes }, "rm: batch drained");
    return { batches: 1, items: present.length, bytes };
}

function isBrokenLink(path: string): boolean {
    try {
        return lstatSync(path).isSymbolicLink();
    } catch {
        return false;
    }
}

export interface DrainOptions {
    config: RmConfig;
    paths?: TrashPaths;
    now?: Date;
    /** Drain every batch, due or not. */
    force?: boolean;
    onItem?: (progress: DrainProgress) => void;
}

/** Drains every batch whose grace has passed (or all of them with `force`), batches in parallel. */
export async function drainDue(options: DrainOptions): Promise<DrainResult> {
    const paths = options.paths ?? defaultTrashPaths();
    const now = (options.now ?? new Date()).getTime();
    const claimed = listBatches(paths)
        .filter((batch) => options.force || Date.parse(batch.drainAfter) <= now)
        .map((batch) => ({ batch, file: claimBatch(paths, batch.id, "draining") }))
        .filter((entry): entry is { batch: TrashBatch; file: string } => entry.file !== null);
    const results = await Promise.all(
        claimed.map(({ batch, file }) => drainClaimed(batch, file, options.config, options.onItem))
    );

    return results.reduce(
        (total, result) => ({
            batches: total.batches + result.batches,
            items: total.items + result.items,
            bytes: total.bytes + result.bytes,
        }),
        { batches: 0, items: 0, bytes: 0 }
    );
}

const CLAIM_NAME = /^(.+)\.json\.(?:draining|restoring)-(\d+)$/;

/**
 * Folders in the configured trash root that no batch record names (a run that died between its move and its
 * record), older than `minAgeMs`, are deleted: nothing could restore them. A claim whose process died is given
 * back as a plain record, so the next drain (or a restore) finishes it.
 */
export async function sweepOrphans(options: DrainOptions & { minAgeMs?: number }): Promise<DrainResult> {
    const paths = options.paths ?? defaultTrashPaths();
    const root = realOrSelf(options.config.trashRoot);
    const records = existsSync(paths.batchesDir) ? readdirSync(paths.batchesDir) : [];
    const known = new Set(
        records.map((name) => CLAIM_NAME.exec(name)?.[1] ?? (name.endsWith(".json") ? name.slice(0, -5) : name))
    );

    for (const name of records) {
        const claim = CLAIM_NAME.exec(name);

        if (claim && !isProcessAlive(Number(claim[2]))) {
            renameSync(join(paths.batchesDir, name), join(paths.batchesDir, `${claim[1]}.json`));
        }
    }

    if (!existsSync(root)) {
        return { batches: 0, items: 0, bytes: 0 };
    }

    const now = (options.now ?? new Date()).getTime();
    const minAgeMs = options.minAgeMs ?? 10 * 60_000;
    const orphans = readdirSync(root)
        .filter((name) => !known.has(name))
        .map((name) => join(root, name))
        .filter((dir) => {
            try {
                return now - lstatSync(dir).mtimeMs >= minAgeMs;
            } catch {
                return false;
            }
        });
    const sizes = await Promise.all(
        orphans.map(async (dir) => {
            try {
                const elapsed = createStopwatch();
                const size = await deleteStored(dir, options.config, "batch");
                appendRmLedger({ action: "drain", path: dir, reason: "orphaned trash folder", bytes: size });
                options.onItem?.({ path: dir, bytes: size, elapsed: elapsed() });
                return size;
            } catch (error) {
                logger.warn({ dir, error }, "rm: cannot sweep an orphaned trash folder");
                return 0;
            }
        })
    );

    return { batches: orphans.length, items: orphans.length, bytes: sizes.reduce((sum, size) => sum + size, 0) };
}

/** True when the configured trash root holds anything (a batch, or an orphan the drainer should sweep). */
export function trashHasEntries(config: RmConfig): boolean {
    const root = realOrSelf(config.trashRoot);
    return existsSync(root) && readdirSync(root).length > 0;
}

export interface RestoreResult {
    restored: string[];
    skipped: Array<{ path: string; reason: string }>;
}

/** Moves a batch's items (all, or the named originals) back where they were. */
export function restoreBatch(
    id: string,
    options: { config: RmConfig; only?: readonly string[]; paths?: TrashPaths; caller?: RmCaller | null }
): RestoreResult {
    const paths = options.paths ?? defaultTrashPaths();
    const claimed = claimBatch(paths, id, "restoring");

    if (!claimed) {
        throw new Error(`rm: no batch ${id} waiting in the trash (already drained, or being drained)`);
    }

    const batch = readBatch(claimed);

    if (!batch) {
        renameSync(claimed, batchFile(paths, id));
        throw new Error(`rm: the record of batch ${id} is unreadable`);
    }

    const wanted = options.only && options.only.length > 0 ? new Set(options.only) : null;
    const result: RestoreResult = { restored: [], skipped: [] };
    const remaining: TrashItem[] = [];

    for (const item of batch.items) {
        if (wanted && !wanted.has(item.original)) {
            remaining.push(item);
            continue;
        }

        if (existsSync(item.original) || isBrokenLink(item.original)) {
            result.skipped.push({ path: item.original, reason: "something exists at the original path" });
            remaining.push(item);
            continue;
        }

        if (!existsSync(item.stored) && !isBrokenLink(item.stored)) {
            result.skipped.push({ path: item.original, reason: "the moved copy is gone" });
            continue;
        }

        mkdirSync(dirname(item.original), { recursive: true });
        renameSync(item.stored, item.original);
        result.restored.push(item.original);
        appendRmLedger({ action: "restore", path: item.original, batchId: id, caller: options.caller ?? null });
    }

    if (remaining.length > 0) {
        writeBatch({ ...batch, items: remaining }, paths, claimed);
        renameSync(claimed, batchFile(paths, id));
    } else {
        removeEmptyBatchDirs(batch, options.config);
        unlinkSync(claimed);
    }

    return result;
}

/** The drainer's single-instance lock; null when a live drainer holds it. */
export function acquireDrainerLock(lockPath: string): (() => void) | null {
    mkdirSync(dirname(lockPath), { recursive: true });

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const fd = openSync(lockPath, "wx");
            writeSync(fd, String(process.pid));
            closeSync(fd);
            return () => {
                try {
                    if (readFileSync(lockPath, "utf8").trim() === String(process.pid)) {
                        unlinkSync(lockPath);
                    }
                } catch (error) {
                    logger.debug({ lockPath, error }, "rm: drainer lock already gone");
                }
            };
        } catch (error) {
            const holder = Number(readLock(lockPath));

            if (isProcessAlive(holder)) {
                logger.debug({ holder }, "rm: a drainer is already running");
                return null;
            }

            logger.debug({ lockPath, holder, error }, "rm: taking over a dead drainer's lock");
            unlinkSync(lockPath);
        }
    }

    return null;
}

function readLock(lockPath: string): string {
    try {
        return readFileSync(lockPath, "utf8").trim();
    } catch {
        return "";
    }
}

export interface DrainerOptions {
    config: RmConfig;
    paths?: TrashPaths;
    now?: () => Date;
    sleep?: (ms: number) => Promise<void>;
}

/**
 * The background drainer. Every start drains the due batches at once: claims keep two drainers off one batch, so
 * a new batch never waits for a drainer that sleeps toward a later one. Then one drainer at a time (the lock) sleeps
 * until the next batch is due (at most 10 minutes, so a restore or a new batch is noticed), and exits when no
 * batch waits.
 */
export async function runDrainer(options: DrainerOptions): Promise<DrainResult> {
    const paths = options.paths ?? defaultTrashPaths();
    const now = options.now ?? (() => new Date());
    const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
    const total: DrainResult = { batches: 0, items: 0, bytes: 0 };
    const add = (result: DrainResult): void => {
        total.batches += result.batches;
        total.items += result.items;
        total.bytes += result.bytes;
    };

    add(await drainDue({ config: options.config, paths, now: now() }));
    const release = acquireDrainerLock(paths.lockPath);

    if (!release) {
        return total;
    }

    try {
        add(await sweepOrphans({ config: options.config, paths, now: now() }));

        while (true) {
            add(await drainDue({ config: options.config, paths, now: now() }));
            const waiting = listBatches(paths);

            if (waiting.length === 0) {
                break;
            }

            const nextDue = Math.min(...waiting.map((batch) => Date.parse(batch.drainAfter)));
            await sleep(Math.min(Math.max(nextDue - now().getTime(), 1_000), 10 * 60_000));
        }
    } finally {
        release();
    }

    return total;
}
