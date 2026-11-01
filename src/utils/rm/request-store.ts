import { readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { type RmRequest, readRmRequestFile, rmRequestFile, rmRequestsDir, saveRmRequest } from "./requests";
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
