import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { concurrentMap } from "@genesiscz/utils/async";
import { sourceFingerprint } from "./fingerprint";
import { historySourceKey } from "./identity";
import { historyPathUnderRoot } from "./project-scope";
import type { HistorySourceSnapshot } from "./repository";
import type { HistorySyncRepository } from "./sync-repository";
import type {
    HistoryDiscoveryOptions,
    HistoryMetadataRecord,
    NativeIndexSyncResult,
    NativeSessionReader,
    NativeSessionSource,
    NativeSourceIssue,
} from "./types";

interface PreparedMetadata {
    source: NativeSessionSource<string>;
    metadata: HistoryMetadataRecord;
    revision: string;
    snapshot: string;
    readAttempts: number;
    previous: HistorySourceSnapshot | null;
}

class MetadataSnapshotChanged extends Error {
    constructor() {
        super("Source changed before metadata commit");
    }
}

function canonicalRoot(path: string): string {
    try {
        return realpathSync(path);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return resolve(path);
        }

        throw error;
    }
}

function sourceExists(path: string): boolean {
    try {
        return statSync(path).isFile();
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return false;
        }

        throw error;
    }
}

export async function synchronizeHistory(options: {
    providerId: string;
    reader: NativeSessionReader<string>;
    repository: HistorySyncRepository;
    roots: string[];
    scope?: HistoryDiscoveryOptions;
    rebuild?: boolean;
    signal?: AbortSignal;
    /** A query may discover once and refresh only conservative content candidates. */
    discovery?: Awaited<ReturnType<NativeSessionReader<string>["discover"]>>;
    metadataSources?: ReadonlySet<string>;
}): Promise<{
    report: NativeIndexSyncResult;
    sources: NativeSessionSource<string>[];
    reindexed: boolean;
    completeRoots: string[];
}> {
    const { reader, repository, providerId, signal } = options;

    if (!reader.readMetadata) {
        throw new Error(`${providerId} does not implement compact metadata reading`);
    }

    signal?.throwIfAborted();
    const roots = [...new Set(options.roots.map(canonicalRoot))];
    const filtered = Boolean(options.scope?.excludeAgents || options.scope?.agentsOnly || options.scope?.project);
    const observed = options.discovery ?? (await reader.discover(roots, { ...options.scope, signal }));
    const cached = repository.sources(providerId);
    const observedRoots = repository.observedRoots(providerId);
    const observedPaths = new Set(observed.sources.map((source) => source.filePath));
    const selected = options.metadataSources
        ? observed.sources.filter((source) => options.metadataSources!.has(source.filePath))
        : observed.sources;
    const cachedByPath = new Map<string, HistorySourceSnapshot[]>();
    const observedCounts = new Map<string, number>();

    for (const source of cached) {
        const group = cachedByPath.get(source.filePath) ?? [];
        group.push(source);
        cachedByPath.set(source.filePath, group);
    }

    for (const source of observed.sources) {
        observedCounts.set(source.filePath, (observedCounts.get(source.filePath) ?? 0) + 1);
    }

    const needsPrune =
        !filtered &&
        cached.some(
            (source) =>
                !observedPaths.has(source.filePath) &&
                observed.completeRoots.some(
                    (root) => source.root === root || historyPathUnderRoot(source.filePath, root)
                )
        );
    const hasIssues = observed.issues.some(
        (issue) =>
            issue.code !== "root-missing" ||
            observedRoots.has(canonicalRoot(issue.path)) ||
            cached.some(
                (source) =>
                    source.root === resolve(issue.path) || historyPathUnderRoot(source.filePath, resolve(issue.path))
            )
    );
    const status = repository.status(providerId);
    const unchangedSnapshot =
        !options.rebuild &&
        !needsPrune &&
        !hasIssues &&
        status.issues.length === 0 &&
        observed.completeRoots.every((root) => observedRoots.has(root)) &&
        selected.every((source) => {
            signal?.throwIfAborted();
            const previous = cachedByPath.get(source.filePath);

            if (source.kind !== reader.kind || previous?.length !== 1 || observedCounts.get(source.filePath) !== 1) {
                return false;
            }

            try {
                return (
                    previous[0].metadataRevision === sourceFingerprint({ source, parserVersion: reader.parserVersion })
                );
            } catch {
                return false;
            }
        });

    if (unchangedSnapshot) {
        return {
            report: { ...status, parsed: 0, unchanged: selected.length, removed: 0 },
            sources: observed.sources,
            reindexed: false,
            completeRoots: observed.completeRoots,
        };
    }

    // Unchanged queries do not write bookkeeping or fsync the shared durable database.
    // A writer reserves its generation BEFORE a fresh discovery so an older optimistic
    // observation cannot overwrite metadata committed by a concurrent newer discovery.
    const generation = repository.begin({ providerId, roots });
    const discovery = await reader.discover(roots, { ...options.scope, signal });
    const previousSources = repository.sources(providerId);
    const issues: NativeSourceIssue[] = discovery.issues.filter(
        (issue) =>
            issue.code !== "root-missing" ||
            observedRoots.has(canonicalRoot(issue.path)) ||
            observed.completeRoots.includes(canonicalRoot(issue.path)) ||
            previousSources.some(
                (source) =>
                    source.root === resolve(issue.path) || historyPathUnderRoot(source.filePath, resolve(issue.path))
            )
    );
    const sourcesByPath = new Map<string, HistorySourceSnapshot[]>();

    for (const source of previousSources) {
        const group = sourcesByPath.get(source.filePath) ?? [];
        group.push(source);
        sourcesByPath.set(source.filePath, group);
    }

    const sourceMultiplicity = new Map<string, number>();

    for (const source of discovery.sources) {
        sourceMultiplicity.set(source.filePath, (sourceMultiplicity.get(source.filePath) ?? 0) + 1);
    }
    const currentPaths = new Set(discovery.sources.map((source) => source.filePath));
    let unchanged = 0;
    let parsed = 0;
    let removed = 0;
    let reindexed = false;
    async function prepareMetadata(input: {
        source: NativeSessionSource<string>;
        readAttempts?: number;
    }): Promise<PreparedMetadata | null> {
        const { source } = input;
        signal?.throwIfAborted();

        if (source.kind !== reader.kind) {
            throw new Error("A provider returned a source belonging to another reader");
        }

        const candidates = sourcesByPath.get(source.filePath) ?? [];
        const previous =
            candidates.length === 1 && sourceMultiplicity.get(source.filePath) === 1 ? candidates[0] : null;
        let readAttempts = input.readAttempts ?? 0;

        if (
            !readAttempts &&
            !options.rebuild &&
            previous?.metadataRevision === sourceFingerprint({ source, parserVersion: reader.parserVersion })
        ) {
            unchanged++;
            return null;
        }

        const relevantPaths = new Set([source.filePath, ...source.metadataPaths, ...source.dataPaths]);
        if (discovery.issues.some((issue) => relevantPaths.has(issue.path))) {
            return null;
        }

        while (readAttempts < 2) {
            signal?.throwIfAborted();
            const snapshot = sourceFingerprint({
                source,
                parserVersion: reader.parserVersion,
                fullMetadataSnapshot: true,
            });
            readAttempts++;
            const read = await reader.readMetadata!(source, { signal });
            issues.push(...read.issues);
            signal?.throwIfAborted();

            if (!read.complete || !read.metadata) {
                return null;
            }

            if (
                sourceFingerprint({ source, parserVersion: reader.parserVersion, fullMetadataSnapshot: true }) !==
                snapshot
            ) {
                if (readAttempts < 2) {
                    continue;
                }

                issues.push({
                    path: source.filePath,
                    message: "Source changed during metadata read; previous metadata retained",
                });
                return null;
            }

            const metadata = {
                ...read.metadata,
                sourceHome: canonicalRoot(read.metadata.sourceHome),
                providerId,
                sourceKey: historySourceKey({
                    providerId,
                    nativeId: read.metadata.nativeId,
                    sourceHome: read.metadata.sourceHome,
                }),
            };
            return {
                source,
                metadata,
                snapshot,
                readAttempts,
                revision: sourceFingerprint({ source, parserVersion: reader.parserVersion }),
                previous: candidates.find((candidate) => candidate.sourceKey === metadata.sourceKey) ?? previous,
            };
        }

        return null;
    }

    const prepared = await concurrentMap({
        items: options.metadataSources
            ? discovery.sources.filter((source) => options.metadataSources!.has(source.filePath))
            : discovery.sources,
        concurrency: 8,
        fn: (source) => prepareMetadata({ source }),
        onError(source) {
            signal?.throwIfAborted();
            issues.push({ path: source.filePath, message: "Source metadata unavailable; previous metadata retained" });
        },
    });
    const proposals = [...prepared.values()].filter((value): value is PreparedMetadata => value !== null);
    proposals.sort(
        (a, b) =>
            Number(Boolean(b.previous && b.previous.sourceKey !== b.metadata.sourceKey)) -
            Number(Boolean(a.previous && a.previous.sourceKey !== a.metadata.sourceKey))
    );

    for (const initial of proposals) {
        let proposal: PreparedMetadata | null = initial;

        while (proposal) {
            signal?.throwIfAborted();
            const current = proposal;

            try {
                const committed = repository.transaction(() => {
                    signal?.throwIfAborted();
                    if (
                        sourceFingerprint({
                            source: current.source,
                            parserVersion: reader.parserVersion,
                            fullMetadataSnapshot: true,
                        }) !== current.snapshot
                    ) {
                        throw new MetadataSnapshotChanged();
                    }

                    const target = repository.metadata.getSource(current.metadata.sourceKey);
                    if (
                        target &&
                        target.filePath !== current.source.filePath &&
                        (currentPaths.has(target.filePath) || sourceExists(target.filePath))
                    ) {
                        throw new Error("Multiple live files claim one native session identity");
                    }

                    const previous = current.previous
                        ? repository.metadata.getSource(current.previous.sourceKey)
                        : target;
                    if (previous && previous.generation > generation) {
                        return false;
                    }

                    return repository.metadata.replaceMetadata({
                        metadata: current.metadata,
                        revision: current.revision,
                        parserVersion: reader.parserVersion,
                        generation,
                        expected: previous,
                    });
                });

                if (committed) {
                    parsed++;
                    reindexed ||=
                        current.previous !== null && current.previous.metadataParserVersion !== reader.parserVersion;
                } else {
                    issues.push({
                        path: current.source.filePath,
                        message: "Concurrent metadata refresh retained; retry on next query",
                    });
                }

                break;
            } catch (error) {
                signal?.throwIfAborted();

                if (error instanceof MetadataSnapshotChanged && current.readAttempts < 2) {
                    try {
                        // Re-read outside the write transaction; never accept a changed snapshot.
                        proposal = await prepareMetadata({
                            source: current.source,
                            readAttempts: current.readAttempts,
                        });
                    } catch {
                        signal?.throwIfAborted();
                        proposal = null;
                        issues.push({
                            path: current.source.filePath,
                            message: "Source metadata unavailable on retry; previous metadata retained",
                        });
                    }

                    continue;
                }

                issues.push({
                    path: current.source.filePath,
                    message: error instanceof Error ? error.message.slice(0, 300) : "Metadata commit failed",
                });
                break;
            }
        }
    }

    signal?.throwIfAborted();
    const completeRoots = filtered ? [] : discovery.completeRoots;
    repository.transaction(() => {
        for (const source of repository.sources(providerId)) {
            const root =
                source.root ?? completeRoots.find((candidate) => historyPathUnderRoot(source.filePath, candidate));

            if (
                !root ||
                !completeRoots.includes(root) ||
                currentPaths.has(source.filePath) ||
                source.generation > generation
            ) {
                continue;
            }

            if (!repository.ownsRoot({ providerId, root, generation })) {
                continue;
            }

            try {
                if (!sourceExists(source.filePath)) {
                    repository.remove(source);
                    removed++;
                }
            } catch {
                issues.push({
                    path: source.filePath,
                    message: "Source deletion could not be verified; metadata retained",
                });
            }
        }
    });
    repository.finish({ providerId, roots: completeRoots, generation, issues });
    return {
        report: { ...repository.status(providerId), parsed, unchanged, removed },
        sources: discovery.sources,
        completeRoots: discovery.completeRoots,
        reindexed,
    };
}
