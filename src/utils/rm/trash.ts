import { createHash, randomBytes } from "node:crypto";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmdirSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { createStopwatch, formatCount } from "@genesiscz/utils/format";
import { walkFiles } from "@genesiscz/utils/fs/disk-usage";
import { keepFromTmpCleaner } from "@genesiscz/utils/fs/tmp-cleaner";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isArbitrationBusy, withPathArbitrationSync } from "@genesiscz/utils/process/path-arbitration";
import { isProcessAliveSince } from "@genesiscz/utils/process-identity";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { isTrashRootName, loadRmConfig, type RmConfig, rmDataDir } from "./config";
import { appendRmLedger } from "./ledger";
import {
    canonicalPath,
    DESTINATION_TAKEN,
    ensurePrivateDir,
    identityOf,
    isInside,
    mountPointOf,
    pathSegments,
    realOrSelf,
    renameNoReplace,
    VOLUME_TRASH_DIR,
} from "./paths";
import { type RmCaller, type RmTarget, type RmTargetKind, targetChangeReason } from "./rules";

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
    /**
     * Set while the producer has not finished its moves, or when it stopped before it did: the items are the planned
     * ones, and the filesystem says which moved. A restore brings back what moved; the drain never deletes it. A
     * record without the field (every record written before it existed) is complete.
     */
    incomplete?: true;
    /**
     * Set when the drain could not delete these items (a folder without write permission): they stay in the trash,
     * restorable, and only a forced drain (`drain --now`) tries again, so the drainer neither loops nor tells twice.
     */
    failed?: { at: string; reason: string };
}

/** What a drain could not delete, for the caller that tells the person (`notify.onFailure`). */
export interface DrainFailure {
    batch: TrashBatch;
    items: Array<{ path: string; reason: string }>;
}

/** Whether a pid still runs the process that made a claim or lock at `markedAtMs`; tests replace it. */
export type ClaimAlive = (pid: number, markedAtMs: number) => boolean;

/** When a claim, lock or marker file was made or renamed (its ctime); +Infinity when it cannot be read. */
function markedAtMs(file: string): number {
    try {
        return lstatSync(file).ctimeMs;
    } catch (error) {
        logger.debug({ file, error }, "rm: cannot read when a claim was made");
        return Number.POSITIVE_INFINITY;
    }
}

/**
 * An incomplete batch on disk. Its items sit under `planned`, not `items`, so an older reader (which drains and
 * restores `items` and knows no `incomplete`) reads no batch: it never drains one, and its orphan sweep keeps the
 * folder, since a `<id>.json` names it.
 */
interface IncompleteBatchRecord {
    id: string;
    createdAt: string;
    drainAfter: string;
    caller: RmCaller | null;
    incomplete: true;
    planned: TrashItem[];
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

/**
 * The configured trash root, resolved; throws when its name or what it resolves to (a symlink on the way) is not a
 * plain path with a `GenesisTools` folder in it, so a root that points at the home folder deletes nothing.
 */
export function resolvedTrashRoot(config: RmConfig): string {
    if (!isTrashRootName(config.trashRoot)) {
        throw new Error(`rm: refusing the trash root ${config.trashRoot}: not a plain path with a GenesisTools folder`);
    }

    const real = realOrSelf(config.trashRoot);

    if (!isTrashRootName(real)) {
        throw new Error(`rm: refusing the trash root ${config.trashRoot}: it resolves to ${real}`);
    }

    return real;
}

/** The trash folder for `target`: the configured root on its volume, else `.GenesisTools-rm` at the target's mount. */
export function trashRootFor(target: RmTarget, config: RmConfig): string {
    // Checked before anything is created, then again once it exists and resolves.
    resolvedTrashRoot(config);
    // The default root sits in the machine-wide /tmp: closed to other users, who could read moved files or swap it.
    ensurePrivateDir(config.trashRoot, { ancestors: true });
    const root = resolvedTrashRoot(config);

    if (lstatSync(target.path).dev === statSync(root).dev) {
        return root;
    }

    return volumeTrashDir(target.path);
}

/** `.GenesisTools-rm` at the mount point of the volume holding `path`, created closed to other users. */
function volumeTrashDir(path: string): string {
    const dir = join(mountPointOf(dirname(path)), VOLUME_TRASH_DIR);
    ensurePrivateDir(dir);
    return dir;
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

    const configured = resolvedTrashRoot(config);
    const real = canonicalPath(path);
    const minDepth = level === "item" ? 2 : 1;
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

/** The path no longer names what the checks saw; nothing was moved (or it was put back). */
export class RmTargetChangedError extends Error {
    constructor(path: string, reason: string) {
        super(`rm: refusing ${path}: ${reason}`);
        this.name = "RmTargetChangedError";
    }
}

/** A seam for the test that swaps the path inside the window between the last check and the rename. */
export interface RenameHooks {
    beforeRename?: () => void;
}

/**
 * Renames `target` to `to` only while it still names what was checked: the same canonical folder and the same
 * device and inode, checked right before the rename. Node has no `renameat`, so a swap can still land between that
 * check and the rename; the moved item's inode is checked after it, and a stranger is put back and refused.
 */
export function renameVerified(target: RmTarget, to: string, hooks: RenameHooks = {}): void {
    const before = targetChangeReason(target);

    if (before) {
        throw new RmTargetChangedError(target.path, before);
    }

    hooks.beforeRename?.();
    renameSync(target.path, to);

    if (identityOf(to) === target.identity) {
        return;
    }

    try {
        renameNoReplace(to, target.path);
        throw new RmTargetChangedError(target.path, "it was swapped during the move; put back");
    } catch (error) {
        if (
            error instanceof RmTargetChangedError ||
            !DESTINATION_TAKEN.has((error as NodeJS.ErrnoException).code ?? "")
        ) {
            throw error;
        }
    }

    throw new RmTargetChangedError(target.path, `it was swapped during the move and waits at ${to}`);
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
    /** A path that no longer names what was checked: it stays where it is, and the run says so. */
    onRefused?: (request: MoveRequest, reason: string) => void;
    /**
     * The trash root the saved config names now (default: read from the config file). Read once the claim is on
     * record; when it is no longer `config`'s root, nothing moves.
     */
    currentTrashRoot?: () => string;
    hooks?: RenameHooks & {
        beforeTrashRoot?: (request: MoveRequest) => void;
        beforeVolumeTrash?: (request: MoveRequest) => void;
        /** Between the claim and the trash-root re-check. */
        afterClaim?: () => void;
    };
}

/**
 * Renames each target into a new batch (instant on one volume). The record is written first, as a claim this
 * process holds, with every planned item and its restore path; each move follows, and the record is published as
 * `<id>.json` only once the moves are over. Until then the drain cannot see the batch, a restore refuses it, and
 * the orphan sweep keeps its folder; a crash leaves the claim, which the sweep gives back as an incomplete record
 * that a restore reads and the drain never deletes. Returns the batch, or null when nothing moved.
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
        incomplete: true,
    };
    const planned: Array<{ request: MoveRequest; item: TrashItem }> = [];

    for (const [index, request] of requests.entries()) {
        let root: string;

        try {
            root = inTrash(() => {
                options.hooks?.beforeTrashRoot?.(request);
                return trashRootFor(request.target, options.config);
            });
        } catch (error) {
            if (!(error instanceof RmTrashUnavailableError)) {
                throw error;
            }

            refuseUnavailable({ request, reason: error.message, options });
            continue;
        }

        const item: TrashItem = {
            original: request.original ?? request.target.path,
            stored: join(root, batch.id, trashItemName(index, request.target.path)),
            kind: request.target.kind,
            rule: request.rule,
        };
        planned.push({ request, item });
        batch.items.push(item);
    }

    if (planned.length === 0) {
        return null;
    }

    const claim = producerClaim(paths, batch.id);
    writeBatch(batch, paths, claim);
    let published: TrashBatch | null = null;

    try {
        // The claim first, then the look at the root: a trash-root change counts claims after it marks itself, so
        // either it sees this claim and refuses, or this run sees its marker or its new root here and moves nothing.
        options.hooks?.afterClaim?.();
        const changed = trashRootChangedSince(options.config, paths, options.currentTrashRoot);

        if (changed) {
            for (const { request } of planned) {
                refuseRootChanged({ request, reason: changed, options });
            }

            return null;
        }

        for (const { request, item } of planned) {
            try {
                moveOne({ request, item, batch, paths, claim, options });
            } catch (error) {
                if (error instanceof RmTrashUnavailableError) {
                    refuseUnavailable({ request, reason: error.message, options });
                    continue;
                }
                if (!(error instanceof RmTargetChangedError)) {
                    throw error;
                }

                refuseChanged({ request, reason: error.message, options });
                continue;
            }

            // Restorable until drainAfter, but the rename kept the times inside the tree, so macOS tmp_cleaner could
            // delete it first. A batch with no grace is drained at once and promises no restore.
            if (options.graceMinutes > 0) {
                keepFromTmpCleaner(item.stored);
            }

            item.bytes = request.bytes ?? measureBytes(item.stored);
            appendRmLedger({
                action: "move",
                path: item.original,
                stored: item.stored,
                batchId: batch.id,
                rule: request.rule,
                bytes: item.bytes,
                caller: options.caller,
            });
            logger.debug({ path: request.target.path, stored: item.stored, batch: batch.id }, "rm: moved aside");
        }
    } finally {
        // Also on a throw: what reached the trash is on the published record, whatever stopped the loop.
        published = publishBatch(batch, { paths, claim, config: options.config });
    }

    return published;
}

/** Moves one planned item; a cross-volume fallback puts its new destination on record before it moves there. */
function moveOne(context: {
    request: MoveRequest;
    item: TrashItem;
    batch: TrashBatch;
    paths: TrashPaths;
    claim: string;
    options: MoveOptions;
}): void {
    const { request, item } = context;
    inTrash(() => mkdirSync(dirname(item.stored), { recursive: true }));

    try {
        renameVerified(request.target, item.stored, context.options.hooks);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
            throw error;
        }

        // The device check said one volume but the rename crossed two (a firmlink, a bind mount): fall back to the
        // trash at the target's own mount point, where the rename stays a rename.
        const volume = inTrash(() => {
            context.options.hooks?.beforeVolumeTrash?.(request);
            return volumeTrashDir(request.target.path);
        });
        item.stored = join(volume, context.batch.id, basename(item.stored));
        inTrash(() => mkdirSync(dirname(item.stored), { recursive: true }));
        writeBatch(context.batch, context.paths, context.claim);
        logger.debug(
            { path: request.target.path, stored: item.stored },
            "rm: cross-volume rename, using the volume's trash"
        );
        renameVerified(request.target, item.stored, context.options.hooks);
    }
}

/**
 * Publishes the finished batch: the items that are in the trash now (the filesystem decides, so an item moved by a
 * step that then threw is still on record), written to the claim and renamed to `<id>.json` in one step.
 */
function publishBatch(
    batch: TrashBatch,
    context: { paths: TrashPaths; claim: string; config: RmConfig }
): TrashBatch | null {
    const items = batch.items.filter((item) => existsSync(item.stored) || isBrokenLink(item.stored));

    if (items.length === 0) {
        unlinkSync(context.claim);
        removeEmptyBatchDirs(batch, context.config);
        return null;
    }

    for (const item of items) {
        item.bytes ??= measureBytes(item.stored);
    }

    const published: TrashBatch = {
        id: batch.id,
        createdAt: batch.createdAt,
        drainAfter: batch.drainAfter,
        caller: batch.caller,
        items,
    };
    writeBatch(published, context.paths, context.claim);
    renameSync(context.claim, batchFile(context.paths, batch.id));
    return published;
}

/** A volume with no writable private trash: the step's error becomes RmTrashUnavailableError, so the path stays. */
function inTrash<T>(step: () => T): T {
    try {
        return step();
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
            throw new RmTrashUnavailableError(`no writable private trash on this volume (${code}); kept in place`, {
                cause: error,
            });
        }
        throw error;
    }
}

class RmTrashUnavailableError extends Error {}

/** A path that stays in place, why, and the move's options (its `onRefused` and caller). */
interface MoveRefusal {
    request: MoveRequest;
    reason: string;
    options: MoveOptions;
}

function refuseUnavailable({ request, reason, options }: MoveRefusal): void {
    if (!options.onRefused) {
        throw new RmTrashUnavailableError(`${request.target.path}: ${reason}`);
    }
    appendRmLedger({
        action: "refuse",
        path: request.original ?? request.target.path,
        rule: "trash-unavailable",
        reason,
        caller: options.caller,
    });
    options.onRefused(request, reason);
}

function refuseRootChanged({ request, reason, options }: MoveRefusal): void {
    if (!options.onRefused) {
        throw new Error(`${request.target.path}: ${reason}`);
    }
    appendRmLedger({
        action: "refuse",
        path: request.original ?? request.target.path,
        rule: "trash-root-changed",
        reason,
        caller: options.caller,
    });
    options.onRefused(request, reason);
}

function refuseChanged({ request, reason, options }: MoveRefusal): void {
    logger.warn({ path: request.target.path, reason }, "rm: the path changed since it was checked");
    appendRmLedger({
        action: "refuse",
        path: request.original ?? request.target.path,
        rule: "target-changed",
        reason,
        caller: options.caller,
    });
    options.onRefused?.(request, reason);
}

function batchFile(paths: TrashPaths, id: string): string {
    return join(paths.batchesDir, `${id}.json`);
}

/**
 * The claim a producer holds on its own record while it moves. It reuses the `restoring` suffix on purpose: every
 * reader, older ones too, treats a `draining` or `restoring` claim as owned by its pid, so the orphan sweep keeps the
 * batch folder while this process lives and gives the record back as `<id>.json` when it dies.
 */
function producerClaim(paths: TrashPaths, id: string): string {
    return join(paths.batchesDir, `${id}.json.restoring-${process.pid}`);
}

function writeBatch(batch: TrashBatch, paths: TrashPaths, file = batchFile(paths, batch.id)): void {
    const { items, incomplete, ...rest } = batch;
    const record: TrashBatch | IncompleteBatchRecord = incomplete
        ? { ...rest, incomplete, planned: items }
        : { ...rest, items };
    mkdirSync(paths.batchesDir, { recursive: true });
    atomicWriteFileSync(file, `${SafeJSON.stringify(record, null, 2)}\n`);
}

function isIncompleteRecord(value: unknown): value is IncompleteBatchRecord {
    return (
        typeof value === "object" &&
        value !== null &&
        "incomplete" in value &&
        value.incomplete === true &&
        "id" in value &&
        typeof value.id === "string" &&
        "drainAfter" in value &&
        typeof value.drainAfter === "string" &&
        "planned" in value &&
        Array.isArray(value.planned)
    );
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

        if (isIncompleteRecord(parsed)) {
            const { planned, ...rest } = parsed;
            return { ...rest, items: planned };
        }

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
 * batches) delete in parallel, the way the reference tool started one `rm -rf` per orphan. `knownBytes` is the size
 * recorded when the item was moved; the tree is walked again only when none was recorded.
 */
async function deleteStored(
    path: string,
    config: RmConfig,
    level: "item" | "batch",
    knownBytes?: number
): Promise<number> {
    assertInsideTrash(path, config, level);
    const size = knownBytes ?? measureBytes(path);
    await rm(path, { recursive: true, force: true });
    return size;
}

/**
 * Deletes one claimed batch's items in parallel, each checked by `assertInsideTrash` first. An item that cannot be
 * deleted gets a `fail` ledger line and stays on the record, which goes back marked `failed` instead of looping.
 */
async function drainClaimed(input: {
    batch: TrashBatch;
    claimedFile: string;
    paths: TrashPaths;
    config: RmConfig;
    onItem?: (progress: DrainProgress) => void;
}): Promise<DrainResult & { failure?: DrainFailure }> {
    const { batch, claimedFile, config } = input;
    const present = batch.items.filter((item) => existsSync(item.stored) || isBrokenLink(item.stored));
    const failed: Array<{ item: TrashItem; reason: string }> = [];
    const sizes = await Promise.all(
        present.map(async (item) => {
            const elapsed = createStopwatch();
            let size: number;

            try {
                size = await deleteStored(item.stored, config, "item", item.bytes);
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                failed.push({ item, reason });
                appendRmLedger({
                    action: "fail",
                    path: item.original,
                    stored: item.stored,
                    batchId: batch.id,
                    rule: item.rule,
                    reason,
                    caller: batch.caller,
                });
                logger.warn({ batch: batch.id, stored: item.stored, error }, "rm: the drain could not delete an item");
                return 0;
            }

            appendRmLedger({
                action: "drain",
                path: item.original,
                batchId: batch.id,
                rule: item.rule,
                bytes: size,
                caller: batch.caller,
            });
            input.onItem?.({ path: item.original, bytes: size, elapsed: elapsed() });
            return size;
        })
    );
    const bytes = sizes.reduce((sum, size) => sum + size, 0);
    const items = present.length - failed.length;

    if (failed.length > 0) {
        const kept: TrashBatch = {
            ...batch,
            items: failed.map((entry) => entry.item),
            failed: { at: new Date().toISOString(), reason: failed[0]?.reason ?? "unknown" },
        };
        writeBatch(kept, input.paths, claimedFile);
        renameSync(claimedFile, batchFile(input.paths, batch.id));
        logger.debug({ batch: batch.id, items, failed: failed.length, bytes }, "rm: batch drained in part");
        return {
            batches: items > 0 ? 1 : 0,
            items,
            bytes,
            failure: { batch: kept, items: failed.map(({ item, reason }) => ({ path: item.original, reason })) },
        };
    }

    removeEmptyBatchDirs(batch, config);
    unlinkSync(claimedFile);
    logger.debug({ batch: batch.id, items, bytes }, "rm: batch drained");
    return { batches: 1, items, bytes };
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
    /** With `force`, the batches still in their grace period that may go early; unset: every one. */
    forceOnly?: (batch: TrashBatch) => boolean;
    onItem?: (progress: DrainProgress) => void;
    /** Whether a claim's pid still runs the process that made it (`isProcessAliveSince` unless a test says). */
    claimAlive?: ClaimAlive;
    /** Called once per batch whose items the drain could not all delete. */
    onFailure?: (failure: DrainFailure) => void;
}

/** Drains every complete batch whose grace has passed (or all of them with `force`), batches in parallel. */
export async function drainDue(options: DrainOptions): Promise<DrainResult> {
    const paths = options.paths ?? defaultTrashPaths();
    const now = (options.now ?? new Date()).getTime();
    const claimed = listBatches(paths)
        .filter((batch) => {
            const forced = options.force === true && (options.forceOnly?.(batch) ?? true);
            // A batch that failed waits for a forced drain: retrying it on every pass would loop and tell again.
            return !batch.incomplete && (forced || (!batch.failed && Date.parse(batch.drainAfter) <= now));
        })
        .map((batch) => ({ batch, file: claimBatch(paths, batch.id, "draining") }))
        .filter((entry): entry is { batch: TrashBatch; file: string } => entry.file !== null);
    const results = await Promise.all(
        claimed.map(({ batch, file }) =>
            drainClaimed({ batch, claimedFile: file, paths, config: options.config, onItem: options.onItem }).then(
                (drained) => {
                    if (drained.failure) {
                        options.onFailure?.(drained.failure);
                    }

                    return drained;
                }
            )
        )
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
 * Gives each claim among `names` whose process died back as a plain `<id>.json` record; returns the live claims. A
 * pid that now runs a process started after the claim was made is a recycled pid, so its claim is dead too.
 */
function releaseDeadClaims(
    paths: TrashPaths,
    names: readonly string[],
    alive: ClaimAlive = isProcessAliveSince
): Array<{ id: string; pid: number }> {
    const live: Array<{ id: string; pid: number }> = [];

    for (const name of names) {
        const claim = CLAIM_NAME.exec(name);

        if (!claim) {
            continue;
        }

        const pid = Number(claim[2]);

        if (alive(pid, markedAtMs(join(paths.batchesDir, name)))) {
            live.push({ id: claim[1], pid });
            continue;
        }

        renameSync(join(paths.batchesDir, name), batchFile(paths, claim[1]));
    }

    return live;
}

/** A batch folder the sweep kept although no plain complete record names it, and why. */
export interface HeldBatch {
    id: string;
    reason: string;
}

/** An interrupted run's batch the sweep finished: what had moved drains after the grace, the rest stayed in place. */
export interface FinishedBatch {
    id: string;
    moved: string[];
    notMoved: string[];
}

export interface SweepResult extends DrainResult {
    held: HeldBatch[];
    finished: FinishedBatch[];
}

/**
 * Finishes an incomplete record whose run is dead (its claim was given back as a plain `<id>.json`): the planned
 * items whose copy is in the trash become a complete batch with the run's own grace, the rest never moved and stay
 * where they are. Every item of a batch was allowed or approved before its move, so draining what moved is what the
 * run would have done; holding it for good hid a 2.9 GB batch until a person restored it (2026-11-01).
 */
function finishIncomplete(batch: TrashBatch, paths: TrashPaths, config: RmConfig): FinishedBatch | null {
    const claimed = claimBatch(paths, batch.id, "restoring");

    if (!claimed) {
        return null;
    }

    const fresh = readBatch(claimed);

    if (!fresh?.incomplete) {
        renameSync(claimed, batchFile(paths, batch.id));
        return null;
    }

    const moved = fresh.items.filter((item) => existsSync(item.stored) || isBrokenLink(item.stored));
    const notMoved = fresh.items.filter((item) => !moved.includes(item)).map((item) => item.original);

    if (moved.length === 0) {
        removeEmptyBatchDirs(fresh, config);
        unlinkSync(claimed);
    } else {
        for (const item of moved) {
            item.bytes ??= measureBytes(item.stored);
        }

        const { incomplete: _incomplete, ...complete } = fresh;
        writeBatch({ ...complete, items: moved }, paths, claimed);
        renameSync(claimed, batchFile(paths, batch.id));
    }

    const result = { id: batch.id, moved: moved.map((item) => item.original), notMoved };
    const reason =
        `an interrupted run's batch, finished: ${formatCount(moved.length, "moved item")} ` +
        `${moved.length === 1 ? "drains" : "drain"} after the grace, ${formatCount(notMoved.length, "path")} never moved`;
    appendRmLedger({ action: "finish", batchId: batch.id, reason, caller: batch.caller });
    logger.warn(result, "rm: finished the batch of a run that died while it moved");
    return result;
}

/**
 * Folders in the configured trash root that no batch record names, older than `minAgeMs`, are deleted: nothing
 * could restore them. A claim whose process died is given back as a plain record, so the next drain (or a restore)
 * finishes it. A folder whose record is incomplete, or that a live process still claims, is kept and reported.
 */
export async function sweepOrphans(options: DrainOptions & { minAgeMs?: number }): Promise<SweepResult> {
    const paths = options.paths ?? defaultTrashPaths();
    const root = resolvedTrashRoot(options.config);
    const records = existsSync(paths.batchesDir) ? readdirSync(paths.batchesDir) : [];
    const known = new Set(
        records.map((name) => CLAIM_NAME.exec(name)?.[1] ?? (name.endsWith(".json") ? name.slice(0, -5) : name))
    );
    const held: HeldBatch[] = releaseDeadClaims(paths, records, options.claimAlive).map(({ id, pid }) => ({
        id,
        reason: `process ${pid} holds its record`,
    }));
    const finished: FinishedBatch[] = [];

    // A plain incomplete record has no live producer: a live one holds its claim, and a dead one's was just given back.
    for (const batch of listBatches(paths).filter((b) => b.incomplete)) {
        const done = finishIncomplete(batch, paths, options.config);

        if (done) {
            finished.push(done);
        }
    }

    if (!existsSync(root)) {
        return { batches: 0, items: 0, bytes: 0, held, finished };
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

    return {
        batches: orphans.length,
        items: orphans.length,
        bytes: sizes.reduce((sum, size) => sum + size, 0),
        held,
        finished,
    };
}

/**
 * Why the trash root cannot move to `next` now, or null when it can. Batch records keep their stored paths and the
 * drain checks each against the configured root, so a move while the old root holds anything would leave it there.
 * `drainCommand` is the caller's command that empties the trash now, named in the refusal when given. Only an answer
 * given inside `whileChangingTrashRoot`, followed there by the save, is final; outside it, it is a preview.
 */
export function trashRootChangeBlocker(
    config: RmConfig,
    next: string,
    paths: TrashPaths = defaultTrashPaths(),
    drainCommand?: string
): string | null {
    if (realOrSelf(next) === realOrSelf(config.trashRoot)) {
        return null;
    }

    // Every record counts, claims too: a producer holds `<id>.json.restoring-<pid>` from before its first move until
    // it publishes, and a drain or a restore holds its own claim; `listBatches` reads only the plain records.
    const records = existsSync(paths.batchesDir)
        ? readdirSync(paths.batchesDir).filter((name) => name.endsWith(".json") || CLAIM_NAME.test(name))
        : [];
    const batches = records.length;

    if (batches === 0 && !trashHasEntries(config)) {
        return null;
    }

    return (
        `the trash at ${config.trashRoot} still holds ${formatCount(batches, "batch", "batches")} or leftover folders. ` +
        `Restore what you want back, ${drainCommand ? `run ${drainCommand}` : "drain the trash"}, then change trash-root.`
    );
}

const ROOT_CHANGE_NAME = /^root-change-(\d+)$/;

/**
 * Runs `change` (the check that the old root is empty, then the save of the new root) under a `root-change-<pid>`
 * marker in the batches folder. No lock: a producer writes its claim, then looks for this marker and re-reads the
 * root, so a claim the check missed belongs to a run that sees the marker or the new root and moves nothing.
 */
export function whileChangingTrashRoot<T>(paths: TrashPaths, change: () => T): T {
    mkdirSync(paths.batchesDir, { recursive: true });
    const marker = join(paths.batchesDir, `root-change-${process.pid}`);
    writeFileSync(marker, "");

    try {
        return change();
    } finally {
        unlinkSync(marker);
    }
}

/** Why a run that loaded `config` must not move into its trash root now, or null when that root still stands. */
function trashRootChangedSince(
    config: RmConfig,
    paths: TrashPaths,
    currentTrashRoot: () => string = () => loadRmConfig().trashRoot
): string | null {
    // A marker whose process died (or whose pid another process got since) is a change that never finished.
    const changing = readdirSync(paths.batchesDir).some((name) => {
        const marker = ROOT_CHANGE_NAME.exec(name);
        return marker !== null && isProcessAliveSince(Number(marker[1]), markedAtMs(join(paths.batchesDir, name)));
    });

    if (changing) {
        return "the trash root is being changed right now; nothing moved, run it again";
    }

    const now = currentTrashRoot();

    if (realOrSelf(now) !== realOrSelf(config.trashRoot)) {
        return `the trash root changed to ${now} after this run read its config; nothing moved, run it again`;
    }

    return null;
}

/** True when the configured trash root holds anything (a batch, or an orphan the drainer should sweep). */
export function trashHasEntries(config: RmConfig): boolean {
    const root = realOrSelf(config.trashRoot);
    return existsSync(root) && readdirSync(root).length > 0;
}

export interface RestoreResult {
    restored: string[];
    skipped: Array<{ path: string; reason: string }>;
    /** Items of an incomplete batch that its run never moved: they are still at their path. */
    notMoved: string[];
}

/** Moves a batch's items (all, or the named originals) back where they were. */
export function restoreBatch(
    id: string,
    options: { config: RmConfig; only?: readonly string[]; paths?: TrashPaths; caller?: RmCaller | null }
): RestoreResult {
    const paths = options.paths ?? defaultTrashPaths();
    // A run that died while it moved left its claim: give it back, so its incomplete record can be restored.
    const claims = existsSync(paths.batchesDir)
        ? readdirSync(paths.batchesDir).filter((name) => name.startsWith(`${id}.json.`))
        : [];
    releaseDeadClaims(paths, claims);
    const claimed = claimBatch(paths, id, "restoring");

    if (!claimed) {
        throw new Error(`rm: no batch ${id} waiting in the trash (already drained, being drained, or still moving)`);
    }

    const batch = readBatch(claimed);

    if (!batch) {
        renameSync(claimed, batchFile(paths, id));
        throw new Error(`rm: the record of batch ${id} is unreadable`);
    }

    const wanted = options.only && options.only.length > 0 ? new Set(options.only) : null;
    const result: RestoreResult = { restored: [], skipped: [], notMoved: [] };
    const remaining: TrashItem[] = [];

    for (const item of batch.items) {
        if (wanted && !wanted.has(item.original)) {
            remaining.push(item);
            continue;
        }

        if (batch.incomplete && !existsSync(item.stored) && !isBrokenLink(item.stored)) {
            result.notMoved.push(item.original);
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

        try {
            // Never over something that appeared at the original path since the check above.
            renameNoReplace(item.stored, item.original);
        } catch (error) {
            if (!DESTINATION_TAKEN.has((error as NodeJS.ErrnoException).code ?? "")) {
                throw error;
            }

            result.skipped.push({ path: item.original, reason: "something exists at the original path" });
            remaining.push(item);
            continue;
        }

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

/** How long an empty lock file counts as held: a writer that creates the file first and writes its pid after. */
const EMPTY_LOCK_MS = 5_000;

/**
 * A single-holder lock file (the drainer's, a request's decision lock, a measurement pass); null when a live process
 * holds it (a recycled pid holds nothing). The file appears with this pid already in it (written to a private file, then linked into place), so no
 * reader ever finds it empty and takes it for a dead holder's. A dead holder's lock is removed only under the path's
 * claim arbiter, after a second read finds the same content: two processes that both saw the dead holder can no
 * longer remove each other's new lock.
 */
export function acquireDrainerLock(lockPath: string, alive: ClaimAlive = isProcessAliveSince): (() => void) | null {
    mkdirSync(dirname(lockPath), { recursive: true });

    for (let attempt = 0; attempt < 2; attempt++) {
        if (createLockFile(lockPath)) {
            return () => {
                try {
                    if (readFileSync(lockPath, "utf8").trim() === String(process.pid)) {
                        unlinkSync(lockPath);
                    }
                } catch (error) {
                    logger.debug({ lockPath, error }, "rm: lock already gone");
                }
            };
        }

        const seen = readLock(lockPath);

        if (seen !== null && lockHeld(lockPath, seen, alive)) {
            logger.debug({ lockPath, holder: seen }, "rm: a live process holds the lock");
            return null;
        }

        if (seen !== null && !removeStaleLock(lockPath, seen, alive)) {
            return null;
        }
    }

    return null;
}

/** Creates `lockPath` holding this pid in one step; false when the name is taken. */
function createLockFile(lockPath: string): boolean {
    const draft = `${lockPath}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(draft, String(process.pid), { flag: "wx" });

    try {
        renameNoReplace(draft, lockPath);
        return true;
    } catch (error) {
        try {
            unlinkSync(draft);
        } catch (cleanup) {
            logger.debug({ draft, error: cleanup }, "rm: lock draft already gone");
        }

        if (!DESTINATION_TAKEN.has((error as NodeJS.ErrnoException).code ?? "")) {
            throw error;
        }

        return false;
    }
}

/**
 * The pid still runs the process that wrote the lock (a recycled pid holds nothing), or an empty file is young enough
 * to be a writer between its create and its pid write.
 */
function lockHeld(lockPath: string, content: string, alive: ClaimAlive): boolean {
    if (content !== "") {
        return alive(Number(content), markedAtMs(lockPath));
    }

    try {
        return Date.now() - statSync(lockPath).mtimeMs < EMPTY_LOCK_MS;
    } catch (error) {
        logger.debug({ lockPath, error }, "rm: the lock went away while it was read");
        return false;
    }
}

/**
 * Removes a stale lock under the path's claim arbiter, only when it still holds `seen` and that is still stale. True
 * when the name is free to take again; false when another process takes the lock over right now, or the lock
 * changed since it was read (a new holder took it). Exported for the race test in rm.test.ts.
 */
export function removeStaleLock(lockPath: string, seen: string, alive: ClaimAlive = isProcessAliveSince): boolean {
    try {
        return withPathArbitrationSync(lockPath, () => {
            const now = readLock(lockPath);

            if (now === null) {
                return true;
            }

            if (now !== seen || lockHeld(lockPath, now, alive)) {
                logger.debug({ lockPath, seen, now }, "rm: the lock changed hands while it was checked");
                return false;
            }

            logger.debug({ lockPath, holder: now }, "rm: taking over a dead holder's lock");
            unlinkSync(lockPath);
            return true;
        });
    } catch (error) {
        if (isArbitrationBusy(error)) {
            logger.debug({ lockPath }, "rm: another process is taking the lock over");
            return false;
        }

        throw error;
    }
}

/** The lock's content, or null when no file is there any more. */
function readLock(lockPath: string): string | null {
    try {
        return readFileSync(lockPath, "utf8").trim();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
        }

        logger.debug({ lockPath, error }, "rm: unreadable lock");
        return "";
    }
}

export interface DrainerOptions {
    config: RmConfig;
    paths?: TrashPaths;
    now?: () => Date;
    sleep?: (ms: number) => Promise<void>;
    /** Called once per batch whose items the drain could not all delete. */
    onFailure?: (failure: DrainFailure) => void;
    /**
     * The request sweep (`sweepRmRequests` with the caller's rule contexts): run at the start and every
     * `config.sweep.everyMinutes` while the drainer runs. Unset: no sweep, and the drainer exits with the trash empty.
     */
    sweepRequests?: () => void | Promise<void>;
    /** Whether a request still waits: the drainer then stays `config.sweep.lingerMinutes` after the trash emptied. */
    requestsWaiting?: () => boolean;
}

/**
 * The background drainer. Every start drains the due batches at once: claims keep two drainers off one batch, so
 * a new batch never waits for a drainer that sleeps toward a later one. Then one drainer at a time (the lock) sweeps
 * the requests (at start and every `sweep.everyMinutes`), sleeps until the next batch is due or the next sweep (at
 * most 10 minutes, so a restore or a new batch is noticed), and exits when no batch waits and either no request
 * waits or none has for `sweep.lingerMinutes`.
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

    const onFailure = options.onFailure;
    add(await drainDue({ config: options.config, paths, now: now(), onFailure }));
    const release = acquireDrainerLock(paths.lockPath);

    if (!release) {
        return total;
    }

    const sweepEvery = options.config.sweep.everyMinutes * 60_000;
    const linger = options.config.sweep.lingerMinutes * 60_000;
    let lastSweep = Number.NEGATIVE_INFINITY;
    let idleSince: number | null = null;

    try {
        add(await sweepOrphans({ config: options.config, paths, now: now() }));

        while (true) {
            if (options.sweepRequests && now().getTime() - lastSweep >= sweepEvery) {
                lastSweep = now().getTime();
                await options.sweepRequests();
            }

            add(await drainDue({ config: options.config, paths, now: now(), onFailure }));
            // A failed batch waits for a person's forced drain, not for this loop.
            const waiting = listBatches(paths).filter((batch) => !batch.incomplete && !batch.failed);
            const at = now().getTime();

            if (waiting.length === 0) {
                if (!options.sweepRequests || !options.requestsWaiting?.()) {
                    break;
                }

                idleSince ??= at;

                if (at - idleSince >= linger) {
                    break;
                }
            } else {
                idleSince = null;
            }

            const nextDue =
                waiting.length > 0 ? Math.min(...waiting.map((batch) => Date.parse(batch.drainAfter))) : Infinity;
            const nextSweep = options.sweepRequests ? lastSweep + sweepEvery : Infinity;
            await sleep(Math.min(Math.max(Math.min(nextDue, nextSweep) - at, 1_000), 10 * 60_000));
        }
    } finally {
        release();
    }

    return total;
}
