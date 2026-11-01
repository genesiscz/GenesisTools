import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isSameOrInside, realOrSelf } from "./paths";
import { listRmRequests, type RmRequest, readRmRequestFile, rmRequestsDir } from "./requests";

/**
 * Which aside folders still wait for a person. Its own module, apart from the moves in `aside.ts`, so a script that
 * only needs this guard (the babysit tmp-reclaim) does not load the trash and the rule table.
 */

/** `<id>.json.moving-<pid>`: a request drafted by a run that moves its paths aside, before it is saved. */
const JOURNAL_NAME = /^([a-z0-9]{4,12})\.json\.moving-(\d+)$/;

export interface AsideJournal {
    id: string;
    pid: number;
    file: string;
    draft: RmRequest | null;
}

/** The journals of the aside runs in `dir` that have not saved their request yet (running, or died moving). */
export function asideJournals(dir: string): AsideJournal[] {
    if (!existsSync(dir)) {
        return [];
    }

    return readdirSync(dir).flatMap((name) => {
        const match = JOURNAL_NAME.exec(name);

        if (!match) {
            return [];
        }

        const file = join(dir, name);
        return [{ id: match[1], pid: Number(match[2]), file, draft: readRmRequestFile(file) }];
    });
}

export interface PendingAside {
    dir: string;
    requestId: string;
}

/** Aside folders whose request still waits for the user, or whose run moves (or died moving) paths into them. */
export function pendingAsideDirs(requestsDir = rmRequestsDir()): PendingAside[] {
    const requests = listRmRequests({ dir: requestsDir })
        .filter((request) => request.asideDir)
        .map((request) => ({ dir: realOrSelf(request.asideDir ?? ""), requestId: request.id }));
    const journals = asideJournals(requestsDir).flatMap((journal) =>
        journal.draft?.asideDir ? [{ dir: realOrSelf(journal.draft.asideDir), requestId: journal.id }] : []
    );
    return [...requests, ...journals];
}

/** The pending request whose aside folder `path` is, holds, or sits in; null when none. */
export function pendingAsideFor(path: string, pending: readonly PendingAside[]): string | null {
    const hit = pending.find((entry) => isSameOrInside(path, entry.dir) || isSameOrInside(entry.dir, path));
    return hit?.requestId ?? null;
}
