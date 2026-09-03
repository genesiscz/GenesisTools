import { statSync } from "node:fs";
import { FILE_META_DB_PATH, FileMetaCache, type ReconcileReport } from "@app/macos/lib/clones/file-meta-cache";
import { formatBytes } from "@genesiscz/utils/format";
import { logger } from "@genesiscz/utils/logger";

const log = logger.child({ component: "clones:cache-prune-daemon" });

/** Runs `FileMetaCache.reconcile()` on the shared cache DB. Registered by
 *  `tools macos clones daemon enable` to run once a day, after the scan. */
export async function runCachePrune(): Promise<ReconcileReport> {
    const before = statSync(FILE_META_DB_PATH, { throwIfNoEntry: false })?.size ?? 0;
    const cache = FileMetaCache.getInstance();
    try {
        const report = await cache.reconcile();
        const after = statSync(FILE_META_DB_PATH, { throwIfNoEntry: false })?.size ?? 0;
        log.info(
            { ...report, dbBytesBefore: before, dbBytesAfter: after },
            `cache reconciled: ${formatBytes(before)} -> ${formatBytes(after)}`
        );
        return report;
    } finally {
        cache.close();
    }
}

if (import.meta.main) {
    runCachePrune()
        .then(() => {
            process.exitCode = 0;
        })
        .catch((err) => {
            log.error({ err }, "cache-prune-daemon failed");
            process.exitCode = 1;
        });
}
