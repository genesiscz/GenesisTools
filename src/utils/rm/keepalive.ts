import { keepFromTmpCleaner, type TmpCleanerRefresh } from "@genesiscz/utils/fs/tmp-cleaner";
import { logger } from "@genesiscz/utils/logger";
import { asideJournals } from "./pending-aside";
import { listRmRequests, type RmRequest, rmRequestsDir } from "./requests";
import { defaultTrashPaths, isRestorableBatch, listBatches, type TrashPaths } from "./trash";

export interface RmKeepaliveResult extends TmpCleanerRefresh {
    /** Pending requests (and aside runs that have not saved theirs) whose aside copies were walked. */
    requests: number;
    /** Trash batches `tools rm restore` can still bring back whose items were walked. */
    batches: number;
}

export interface RmKeepaliveOptions {
    requestsDir?: string;
    trashPaths?: TrashPaths;
    now?: Date;
}

/**
 * The daily keepalive against macOS tmp_cleaner, which deletes a file in /tmp once all its times are older than 3
 * days: refreshes the files of every aside copy a pending request still waits on (a person may take days) and of every
 * trash batch `tools rm restore` can still bring back (`isRestorableBatch`: in its grace period, incomplete, or failed,
 * the last two restorable for good). A decided request and a drained batch past its grace are left alone. Stat and
 * utimes only. The daily pass (`compress/daily-pass.ts`) runs it.
 */
export function refreshWaitingRmData(options: RmKeepaliveOptions = {}): RmKeepaliveResult {
    const started = Date.now();
    const now = options.now ?? new Date();
    const requestsDir = options.requestsDir ?? rmRequestsDir();
    const result: RmKeepaliveResult = { requests: 0, batches: 0, files: 0, fresh: 0, emptyDirs: 0, failed: 0 };
    const add = (refresh: TmpCleanerRefresh): void => {
        result.files += refresh.files;
        result.fresh += refresh.fresh;
        result.emptyDirs += refresh.emptyDirs;
        result.failed += refresh.failed;
    };
    const drafts = asideJournals(requestsDir).flatMap((journal): RmRequest[] => (journal.draft ? [journal.draft] : []));

    for (const request of [...listRmRequests({ dir: requestsDir, now }), ...drafts]) {
        const stored = request.targets.flatMap((target) => (target.stored ? [target.stored] : []));

        if (stored.length === 0) {
            continue;
        }

        result.requests++;

        for (const path of stored) {
            add(keepFromTmpCleaner(path, now));
        }
    }

    for (const batch of listBatches(options.trashPaths ?? defaultTrashPaths())) {
        if (!isRestorableBatch(batch, now.getTime())) {
            continue;
        }

        result.batches++;

        for (const item of batch.items) {
            add(keepFromTmpCleaner(item.stored, now));
        }
    }

    logger.info(
        { ...result, ms: Date.now() - started },
        `rm: keepalive refreshed ${result.files} file(s) of ${result.requests} pending request(s) and ${result.batches} trash batch(es) against macOS tmp_cleaner`
    );
    return result;
}
