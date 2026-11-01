import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { appendRmLedger } from "./ledger";
import { pathPresent, requestLive } from "./request-state";
import {
    RM_REQUEST_TTL_MS,
    type RmRequest,
    readRmRequestFile,
    rmRequestFile,
    rmRequestsDir,
    saveRmRequest,
} from "./requests";
import type { RmCaller } from "./rules";
import { acquireDrainerLock } from "./trash";

/** The lock a decision holds on request `id`: one approve, deny, settle or prune writes a request at a time. */
export function rmRequestLockFile(id: string, dir = rmRequestsDir()): string {
    return join(dir, `${id}.deciding.lock`);
}

export type RmRequestLock = { ok: true; release: () => void } | { ok: false; holder: number | null };

/** The locks this process holds, so an approve that settles a request it already holds does not lock itself out. */
const held = new Map<string, { count: number; unlock: () => void }>();

function releaseOnce(file: string): () => void {
    let released = false;
    return () => {
        const mine = held.get(file);

        if (released || !mine) {
            return;
        }

        released = true;
        mine.count--;

        if (mine.count === 0) {
            held.delete(file);
            mine.unlock();
        }
    };
}

function lockHolder(file: string): number | null {
    try {
        const pid = Number(readFileSync(file, "utf8").trim());
        return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch (error) {
        logger.debug({ file, error }, "rm: unreadable request lock");
        return null;
    }
}

/** The shape every saved request id has; anything else names no request file. */
const REQUEST_ID = /^[a-z0-9]{4,12}$/;

/** Takes request `id`'s decision lock (O_EXCL, a dead holder's lock is taken over); re-entrant inside one process. */
export function lockRmRequest(id: string, dir = rmRequestsDir()): RmRequestLock {
    // No request can be saved under such an id, so there is nothing to lock, and a lock file name built from it
    // could point outside the requests folder.
    if (!REQUEST_ID.test(id)) {
        return { ok: true, release: () => {} };
    }

    const file = rmRequestLockFile(id, dir);
    const mine = held.get(file);

    if (mine) {
        mine.count++;
        return { ok: true, release: releaseOnce(file) };
    }

    const unlock = acquireDrainerLock(file);

    if (!unlock) {
        return { ok: false, holder: lockHolder(file) };
    }

    held.set(file, { count: 1, unlock });
    return { ok: true, release: releaseOnce(file) };
}

export type RmRequestUpdate =
    | { kind: "saved"; request: RmRequest }
    | { kind: "unchanged"; request: RmRequest }
    | { kind: "busy"; holder: number | null }
    | { kind: "missing" };

/** Reads request `id` from disk under its lock and saves what `change` returns; null from `change` writes nothing. */
export function updateRmRequest(
    id: string,
    change: (fresh: RmRequest) => RmRequest | null,
    dir = rmRequestsDir()
): RmRequestUpdate {
    const lock = lockRmRequest(id, dir);

    if (!lock.ok) {
        return { kind: "busy", holder: lock.holder };
    }

    try {
        const fresh = REQUEST_ID.test(id) ? readRmRequestFile(rmRequestFile(id, dir)) : null;

        if (!fresh) {
            return { kind: "missing" };
        }

        const next = change(fresh);

        if (!next) {
            return { kind: "unchanged", request: fresh };
        }

        saveRmRequest(next, dir);
        return { kind: "saved", request: next };
    } finally {
        lock.release();
    }
}

/** Why prune may close a pending request, or null: it never moves, restores or deletes a file. */
export function pruneReason(
    request: RmRequest,
    now: Date,
    present: (path: string) => boolean = pathPresent
): "gone" | "expired" | null {
    if (request.status !== "pending") {
        return null;
    }

    if (requestLive(request, present).state === "gone") {
        return "gone";
    }

    const inPlaceOnly = request.targets.every((target) => target.stored === undefined);
    return inPlaceOnly && now.getTime() - Date.parse(request.createdAt) > RM_REQUEST_TTL_MS ? "expired" : null;
}

export interface RmPruneResult {
    closed: Array<{ id: string; status: "gone" | "expired" }>;
    /** Requests open in an approval window right now: left as they are. */
    busy: string[];
}

/**
 * Closes the pending requests nobody can decide any more: every path and copy gone (status `gone`), or an in-place
 * request past its TTL (status `expired`, what readers already show). Nothing on disk moves.
 */
export function pruneRmRequests(
    options: {
        dir?: string;
        now?: Date;
        dryRun?: boolean;
        caller?: RmCaller | null;
        present?: (path: string) => boolean;
        /** The end states to write; both unless said (the drainer's sweep writes only `gone`). */
        reasons?: ReadonlyArray<"gone" | "expired">;
        /** Only these requests. */
        ids?: readonly string[];
    } = {}
): RmPruneResult {
    const dir = options.dir ?? rmRequestsDir();
    const now = options.now ?? new Date();
    const result: RmPruneResult = { closed: [], busy: [] };

    if (!existsSync(dir)) {
        return result;
    }

    const ids = readdirSync(dir)
        .filter((name) => /^[a-z0-9]{4,12}\.json$/.test(name))
        .map((name) => name.slice(0, -5))
        .filter((id) => !options.ids || options.ids.includes(id))
        .sort();
    const allowed = (reason: "gone" | "expired" | null) =>
        reason !== null && (!options.reasons || options.reasons.includes(reason)) ? reason : null;

    for (const id of ids) {
        const raw = readRmRequestFile(rmRequestFile(id, dir));
        const reason = raw ? allowed(pruneReason(raw, now, options.present)) : null;

        if (!reason) {
            continue;
        }

        if (options.dryRun) {
            result.closed.push({ id, status: reason });
            continue;
        }

        const update = updateRmRequest(
            id,
            (fresh) => {
                const again = allowed(pruneReason(fresh, now, options.present));
                return again ? { ...fresh, status: again, decidedAt: now.toISOString(), decidedVia: "prune" } : null;
            },
            dir
        );

        if (update.kind === "busy") {
            result.busy.push(id);
        } else if (update.kind === "saved") {
            const status = update.request.status === "gone" ? "gone" : "expired";
            result.closed.push({ id, status });
            appendRmLedger({ action: "close", requestId: id, reason: status, caller: options.caller ?? null });
        }
    }

    return result;
}
