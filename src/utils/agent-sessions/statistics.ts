import { realpathSync, statSync } from "node:fs";
import { sourceFingerprint } from "./fingerprint";
import type { CachedHistoryMetadata } from "./repository";
import type { HistoryStatisticsRepository } from "./statistics-repository";
import { synchronizeHistory } from "./sync";
import type { HistorySyncRepository } from "./sync-repository";
import type { NativeSessionReader, NativeSourceIssue } from "./types";

export interface HistoryStatisticsRefresh {
    parsed: number;
    unchanged: number;
    sources: number;
    completeSources: number;
    coverage: "complete" | "partial" | "unsupported";
    issues: NativeSourceIssue[];
}

/** Explicit full-statistics refresh; ordinary metadata/search requests never invoke it. */
export async function refreshHistoryStatistics(options: {
    providerId: string;
    reader: NativeSessionReader<string>;
    repository: HistorySyncRepository;
    statistics: HistoryStatisticsRepository;
    roots: string[];
    force?: boolean;
    signal?: AbortSignal;
    onProgress?: (processed: number, total: number, firstDate?: string) => void;
}): Promise<HistoryStatisticsRefresh> {
    const { reader, repository, statistics, providerId, signal } = options;

    if (!reader.readStatistics) {
        const coverage = statistics.coverage(providerId);
        return {
            parsed: 0,
            unchanged: 0,
            sources: coverage.sources,
            completeSources: coverage.complete,
            coverage: "unsupported",
            issues: [],
        };
    }

    signal?.throwIfAborted();
    const discovery = await reader.discover(options.roots, { signal });
    const refreshed = await synchronizeHistory({
        providerId,
        reader,
        repository,
        roots: options.roots,
        discovery,
        signal,
    });
    const issues = [...refreshed.report.issues];
    const metadataByPath = new Map<string, CachedHistoryMetadata[]>();

    for (const metadata of repository.metadata.listMetadata({ providerId })) {
        const group = metadataByPath.get(metadata.filePath) ?? [];
        group.push(metadata);
        metadataByPath.set(metadata.filePath, group);
    }

    const sourceKeys: string[] = [];
    let parsed = 0;
    let unchanged = 0;

    let processed = 0;

    for (const source of refreshed.sources) {
        signal?.throwIfAborted();
        processed++;
        const candidates = metadataByPath.get(source.filePath) ?? [];
        const metadata =
            candidates.find((candidate) => candidate.nativeId === source.metadata?.sessionId) ??
            (candidates.length === 1 ? candidates[0] : undefined);
        const expected = metadata ? repository.metadata.getSource(metadata.sourceKey) : null;

        if (!metadata || !expected) {
            // No metadata row means no contribution either, so `publish` reports partial coverage
            // on its own from the source keys it did get.
            continue;
        }

        sourceKeys.push(metadata.sourceKey);

        try {
            const revision = sourceFingerprint({ source, parserVersion: reader.parserVersion });
            const inputsRevision = sourceFingerprint({
                source,
                parserVersion: reader.parserVersion,
                statisticsSnapshot: true,
            });

            if (expected.metadataRevision !== revision) {
                issues.push({
                    path: source.filePath,
                    message: "Statistics source lacks current complete metadata; previous aggregates retained",
                });
                continue;
            }

            if (
                !options.force &&
                expected.statisticsStatus === "complete" &&
                expected.statsRevision === revision &&
                expected.statsInputsRevision === inputsRevision
            ) {
                unchanged++;
                continue;
            }

            const snapshot = sourceFingerprint({
                source,
                parserVersion: reader.parserVersion,
                fullMetadataSnapshot: true,
                statisticsSnapshot: true,
            });
            const result = await reader.readStatistics(source, { signal });
            issues.push(...result.issues);
            signal?.throwIfAborted();

            if (!result.complete) {
                issues.push({
                    path: source.filePath,
                    message: "Statistics source read is incomplete; previous aggregates retained",
                });
                continue;
            }

            const committed = statistics.replace({
                expected,
                revision,
                inputsRevision,
                parserVersion: reader.parserVersion,
                statistics: result,
                sourceMtime: Math.floor(statSync(source.filePath).mtimeMs),
                verifyRevision: () => {
                    signal?.throwIfAborted();
                    return (
                        sourceFingerprint({
                            source,
                            parserVersion: reader.parserVersion,
                            fullMetadataSnapshot: true,
                            statisticsSnapshot: true,
                        }) === snapshot
                    );
                },
            });

            if (committed) {
                parsed++;
                options.onProgress?.(processed, refreshed.sources.length, result.summary.firstDate ?? undefined);
            } else {
                issues.push({
                    path: source.filePath,
                    message: "Statistics source changed during refresh; previous aggregates retained",
                });
            }
        } catch (error) {
            signal?.throwIfAborted();
            issues.push({
                path: source.filePath,
                message: error instanceof Error ? error.message.slice(0, 300) : "Statistics read failed",
            });
        }
    }

    signal?.throwIfAborted();
    // This precondition answers only one question: did the walk see every ROOT? A missed root
    // means sources we never observed at all, and rolling up without them could silently drop a
    // whole project — worse than a visible zero. Everything narrower belongs to `publish`, which
    // checks each source itself and reports complete or partial.
    //
    // It used to also require `issues.length === 0` and `allIdentified`. Both are per-source
    // conditions, and on this corpus they are never both satisfied: a live session always keeps
    // one transcript moving mid-read, and two sources have no metadata row. So publication was
    // refused on every run, and a cold build ended with 12,923 contribution rows against an empty
    // `daily_stats` and `totals_cache` — the dashboard read "0 conversations" permanently.
    const completeDiscovery =
        refreshed.completeRoots.length > 0 &&
        options.roots.every((root) => {
            try {
                return refreshed.completeRoots.includes(realpathSync(root));
            } catch (error) {
                // Default providers enumerate optional legacy/archive locations. A never-existing
                // location is empty; publish still rejects retained indexed sources absent above.
                return error instanceof Error && "code" in error && error.code === "ENOENT";
            }
        });
    const published = statistics.publish({
        providerId,
        discoveryComplete: completeDiscovery,
        expectedSourceKeys: sourceKeys,
    });
    const coverage = statistics.coverage(providerId);

    // Only a refusal leaves the old rows behind; a partial publication already labels its own.
    if (published === "refused") {
        statistics.markStale(providerId);
    }

    return {
        parsed,
        unchanged,
        sources: coverage.sources,
        completeSources: coverage.complete,
        // The rows are published either way; this reports whether THIS run saw full coverage, so
        // a source that failed to read still stops `last_full_update` from moving.
        coverage: published === "complete" && issues.length === 0 ? "complete" : "partial",
        issues,
    };
}
