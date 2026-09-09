import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { concurrentMap } from "@genesiscz/utils/async";
import { logger } from "@genesiscz/utils/logger";
import { sourceFingerprint } from "./fingerprint";
import { haystackMatch } from "./match";
import { validateHistoryFilters } from "./native-match";
import { historyPathUnderRoot, historyProjectMatches } from "./project-scope";
import type { CachedHistoryMetadata } from "./repository";
import { historyCandidates } from "./search-candidates";
import {
    listingIndexSlice,
    listingPassesDate,
    mergeSearchWaves,
    RELEVANCE_MATCH_COUNT_CAP,
    ranksByRelevance,
    relevanceParseCap,
} from "./search-plan";
import { calculateHistoryRelevance } from "./search-rank";
import {
    type HistorySourceMatch,
    historyRecordText,
    matchesHistoryMetadata,
    searchHistorySource,
} from "./search-source";
import { refreshHistoryStatistics } from "./statistics";
import type { HistoryStatisticsRepository } from "./statistics-repository";
import { synchronizeHistory } from "./sync";
import type { HistorySyncRepository } from "./sync-repository";
import type {
    AgentSearchFilters,
    AgentSession,
    HistorySourceRecord,
    NativeHistoryEntry,
    NativeSessionReader,
    NativeSessionSource,
    NativeSourceIssue,
} from "./types";

export interface HistorySearchResult {
    session: AgentSession<string>;
    metadata: CachedHistoryMetadata;
    timestamp: Date;
    matchedEntries: NativeHistoryEntry[];
    contextEntries: NativeHistoryEntry[];
    matchedRecords: HistorySourceRecord[];
    contextRecords: HistorySourceRecord[];
    matchedText?: string;
    relevanceScore: number;
}

export interface HistorySearchResponse {
    results: HistorySearchResult[];
    issues: NativeSourceIssue[];
}

interface MatchedHistorySource {
    source: NativeSessionSource<string>;
    match: HistorySourceMatch;
    revision: string;
}

function canonicalRoot(root: string): string {
    try {
        return realpathSync(root);
    } catch {
        return resolve(root);
    }
}

/**
 * `--since` and `--until` were applied only per RECORD, and only when that record carried a
 * timestamp. Grok records carry none and a metadata match has no record at all, so both flags
 * silently returned everything on the codex and grok doors: `--since 2027-01-01` listed sessions
 * from 2026. A session overlaps the window when it ended at or after `since` and started at or
 * before `until`; `mtime` stands in for a missing end, and for a missing start.
 */
function sessionOverlapsDateRange(metadata: CachedHistoryMetadata, filters: AgentSearchFilters): boolean {
    if (!filters.since && !filters.until) {
        return true;
    }

    const started = metadata.firstTimestamp ? new Date(metadata.firstTimestamp) : new Date(metadata.mtime);
    const ended = metadata.lastTimestamp ? new Date(metadata.lastTimestamp) : new Date(metadata.mtime);

    if (filters.since && !Number.isNaN(ended.getTime()) && ended < filters.since) {
        return false;
    }

    return !(filters.until && !Number.isNaN(started.getTime()) && started > filters.until);
}

/** bun:sqlite surfaces contention as SQLITE_BUSY on the error's `code`, and in its message. */
function isDatabaseBusy(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }

    const code = "code" in error ? String((error as Error & { code?: unknown }).code) : "";

    return code.includes("SQLITE_BUSY") || /database is locked|database table is locked/i.test(error.message);
}

function metadataInScope(metadata: CachedHistoryMetadata, filters: AgentSearchFilters): boolean {
    if ((filters.agentsOnly && !metadata.isSubagent) || (filters.excludeAgents && metadata.isSubagent)) {
        return false;
    }

    if (!sessionOverlapsDateRange(metadata, filters)) {
        return false;
    }

    if (!filters.all && filters.cwd && metadata.cwd !== filters.cwd) {
        return false;
    }

    if (
        !filters.all &&
        filters.project &&
        !historyProjectMatches({
            providerId: metadata.providerId,
            project: metadata.project,
            projectDirectory: metadata.projectDirectory,
            requested: filters.project,
        })
    ) {
        return false;
    }

    if (filters.sourceRoots && !filters.sourceRoots.some((root) => historyPathUnderRoot(metadata.filePath, root))) {
        return false;
    }

    return !filters.excludeSessions?.some(
        (id) => id === metadata.sessionId || id === metadata.nativeId || id === metadata.sourceKey
    );
}

function resultFromMetadata(metadata: CachedHistoryMetadata, kind: string): HistorySearchResult {
    const timestamp = metadata.firstTimestamp ? new Date(metadata.firstTimestamp) : new Date(metadata.mtime);
    return {
        session: {
            kind,
            sessionId: metadata.nativeId ?? metadata.sessionId ?? metadata.filePath,
            cwd: metadata.cwd ?? "",
            title: metadata.customTitle ?? metadata.summary ?? metadata.firstPrompt ?? metadata.nativeId ?? "",
            summary: metadata.summary ?? undefined,
            prompt: metadata.firstPrompt ?? undefined,
            mtime: new Date(metadata.mtime),
            createdAt: timestamp,
            filePath: metadata.filePath,
            project: metadata.project ?? undefined,
            projectDirectory: metadata.projectDirectory ?? undefined,
            sourceHome: metadata.sourceHome ?? undefined,
            sourceKey: metadata.sourceKey,
            archived: metadata.archived,
            isSubagent: metadata.isSubagent,
            gitBranch: metadata.gitBranch ?? undefined,
        },
        metadata,
        timestamp,
        matchedEntries: [],
        contextEntries: [],
        matchedRecords: [],
        contextRecords: [],
        relevanceScore: 0,
    };
}

/** One provider-independent query path. The owner supplies an initialized canonical repository. */
export class HistoryService {
    constructor(
        private readonly options: {
            providerId: string;
            reader: NativeSessionReader<string>;
            repository: HistorySyncRepository;
            statistics?: HistoryStatisticsRepository;
            roots: string[];
            now?: () => Date;
        }
    ) {}

    sync(options: { rebuild?: boolean; signal?: AbortSignal } = {}) {
        return synchronizeHistory({ ...this.options, ...options });
    }

    status() {
        return this.options.repository.status(this.options.providerId);
    }

    async detail(sessionId: string, signal?: AbortSignal): Promise<HistorySearchResponse> {
        signal?.throwIfAborted();
        const { providerId, reader, repository } = this.options;
        const synchronized = await synchronizeHistory({ ...this.options, signal });
        const issues = [...synchronized.report.issues];
        const metadata = repository.metadata.getMetadataBySessionId({ providerId, sessionId });

        if (!metadata || !reader.scan) {
            return { results: [], issues };
        }

        const candidates = synchronized.sources.filter((source) => source.filePath === metadata.filePath);
        const source =
            candidates.length === 1
                ? candidates[0]
                : candidates.find((candidate) => candidate.metadata?.sessionId === metadata.nativeId);

        if (!source) {
            issues.push({ path: metadata.filePath, message: "Indexed history source is unavailable" });
            return { results: [], issues };
        }

        const snapshot = sourceFingerprint({
            source,
            parserVersion: reader.parserVersion,
            fullMetadataSnapshot: true,
        });
        const records: HistorySourceRecord[] = [];

        for await (const record of reader.scan(source, {
            signal,
            onIssue: (issue) => issues.push(issue),
        })) {
            records.push(record);
        }

        signal?.throwIfAborted();
        if (
            sourceFingerprint({ source, parserVersion: reader.parserVersion, fullMetadataSnapshot: true }) !== snapshot
        ) {
            issues.push({ path: source.filePath, message: "Source changed during detail read; retry the request" });
            return { results: [], issues };
        }

        const result = resultFromMetadata(metadata, reader.kind);
        result.matchedRecords = records;
        result.matchedEntries = records.flatMap((record) => record.entries);
        result.matchedText = result.matchedEntries[0]
            ? historyRecordText(result.matchedEntries).slice(0, 1200)
            : undefined;
        return { results: [result], issues };
    }

    refreshStatistics(
        options: {
            force?: boolean;
            signal?: AbortSignal;
            onProgress?: (processed: number, total: number, firstDate?: string) => void;
        } = {}
    ) {
        if (!this.options.statistics) {
            throw new Error("Statistics repository is not configured for this history service");
        }

        return refreshHistoryStatistics({ ...this.options, ...options, statistics: this.options.statistics });
    }

    private async hydrateMatch(options: {
        candidate: MatchedHistorySource;
        filters: AgentSearchFilters;
        issues: NativeSourceIssue[];
    }): Promise<HistorySearchResult | undefined> {
        const { candidate, filters, issues } = options;
        const { reader } = this.options;
        filters.signal?.throwIfAborted();

        try {
            if (!reader.readRecords) {
                throw new Error(`${reader.kind} does not implement original record hydration`);
            }

            const locators = [...new Set([...candidate.match.matchedLocators, ...candidate.match.contextLocators])];
            const selected = new Map(candidate.match.selectedRecords.map((record) => [record.locator, record]));
            const canReuse = locators.every((locator) => selected.has(locator));
            const hydrated = canReuse
                ? { records: candidate.match.selectedRecords, issues: [], complete: true }
                : locators.length
                  ? await reader.readRecords(candidate.source, { locators, signal: filters.signal })
                  : { records: [], issues: [], complete: true };
            issues.push(...hydrated.issues);

            if (
                !hydrated.complete ||
                sourceFingerprint({
                    source: candidate.source,
                    parserVersion: reader.parserVersion,
                    fullMetadataSnapshot: true,
                }) !== candidate.revision
            ) {
                issues.push({
                    path: candidate.source.filePath,
                    message: "Source changed or became unreadable during search; retry to refresh results",
                });
                return;
            }

            const available = new Set(hydrated.records.map((record) => record.locator));

            if (locators.some((locator) => !available.has(locator))) {
                issues.push({
                    path: candidate.source.filePath,
                    message: "Selected source records are no longer available",
                });
                return;
            }

            const matched = new Set(candidate.match.matchedLocators);
            const context = new Set(candidate.match.contextLocators);
            const result = resultFromMetadata(candidate.match.metadata, reader.kind);
            result.timestamp = candidate.match.timestamp;
            result.session.createdAt = result.timestamp;
            result.session.mtime = new Date(statSync(candidate.source.filePath).mtimeMs);
            result.matchedRecords = hydrated.records.filter((record) => matched.has(record.locator));
            result.contextRecords = hydrated.records.filter((record) => context.has(record.locator));
            result.matchedEntries = result.matchedRecords.flatMap((record) => record.entries);
            result.contextEntries = result.contextRecords.flatMap((record) => record.entries);
            result.relevanceScore = candidate.match.relevanceScore;
            result.matchedText = candidate.match.matchedText;
            return result;
        } catch (error) {
            filters.signal?.throwIfAborted();
            issues.push({
                path: candidate.source.filePath,
                message: error instanceof Error ? error.message.slice(0, 300) : "Source hydration failed",
            });
            return;
        }
    }

    private async refreshListing(filters: AgentSearchFilters) {
        validateHistoryFilters(filters);
        const scope = {
            agentsOnly: filters.agentsOnly,
            excludeAgents: filters.excludeAgents,
            project: filters.project,
            signal: filters.signal,
        };
        const discovery = await this.options.reader.discover(this.options.roots, scope);
        const candidates = await historyCandidates({ sources: discovery.sources, filters: { signal: filters.signal } });
        const selected = listingIndexSlice(candidates, filters.limit);
        return synchronizeHistory({
            ...this.options,
            discovery,
            scope,
            signal: filters.signal,
            metadataSources: new Set(selected.map((candidate) => candidate.source.filePath)),
        });
    }

    /** The listing catalog: refresh the metadata a listing will read, then read it. */
    async catalog(filters: AgentSearchFilters = {}) {
        const synchronized = await this.refreshListing(filters);
        const scoped = {
            ...filters,
            sourceRoots: (filters.sourceRoots ?? this.options.roots).map(canonicalRoot),
            excludeAgents: false,
            agentsOnly: false,
        };
        const metadata = this.options.repository.metadata
            .listMetadata({ providerId: this.options.providerId, orderBy: "firstTimestamp" })
            .filter((entry) => metadataInScope(entry, scoped));
        return { metadata, report: synchronized.report, reindexed: synchronized.reindexed };
    }

    /** How many indexed sessions still carry the pre-index identity the migration synthesized. */
    unresolvedIdentities(): number {
        return this.options.repository.metadata.unresolvedIdentityCount(this.options.providerId);
    }

    /** Cached inspection deliberately performs no discovery, parsing, migration or writes. */
    cached(filters: AgentSearchFilters = {}): HistorySearchResponse {
        return this.queryCached({ filters });
    }

    private queryCached(options: {
        filters: AgentSearchFilters;
        overrides?: Map<string, CachedHistoryMetadata>;
        excludedKeys?: Set<string>;
    }): HistorySearchResponse {
        const { filters } = options;
        validateHistoryFilters(filters);

        if (filters.limit === 0) {
            return { results: [], issues: [] };
        }

        const scoped = { ...filters, sourceRoots: (filters.sourceRoots ?? this.options.roots).map(canonicalRoot) };
        const results: HistorySearchResult[] = [];

        for (const cached of this.options.repository.metadata.listMetadata({ providerId: this.options.providerId })) {
            const metadata = options.overrides?.get(cached.sourceKey) ?? cached;
            if (options.excludedKeys?.has(metadata.sourceKey) || !metadataInScope(metadata, scoped)) {
                continue;
            }

            const result = resultFromMetadata(metadata, this.options.reader.kind);
            const hasDate = !filters.summaryOnly || metadata.firstTimestamp !== null;

            if (filters.summaryOnly && !metadata.firstTimestamp) {
                result.timestamp = this.options.now?.() ?? new Date();
            }

            if (
                hasDate &&
                (!listingPassesDate(result.timestamp, filters) ||
                    (filters.conversationDate && result.timestamp < filters.conversationDate) ||
                    (filters.conversationDateUntil && result.timestamp > filters.conversationDateUntil))
            ) {
                continue;
            }

            if (!filters.query) {
                results.push(result);
                continue;
            }

            const text = [metadata.customTitle, metadata.summary, metadata.firstPrompt, metadata.allUserText]
                .filter(Boolean)
                .join(" ");

            if (filters.query && !haystackMatch(text, filters.query, filters)) {
                continue;
            }

            result.matchedText = text.slice(0, 1200);
            result.relevanceScore = calculateHistoryRelevance({
                query: filters.query ?? "",
                summary: metadata.summary ?? undefined,
                customTitle: metadata.customTitle ?? undefined,
                firstUserMessage: metadata.firstPrompt ?? undefined,
                allText: text,
                timestamp: result.timestamp,
                now: this.options.now?.(),
            });
            results.push(result);
        }

        if (filters.summaryOnly) {
            results.sort((left, right) =>
                filters.sortByRelevance
                    ? right.relevanceScore - left.relevanceScore
                    : right.session.mtime.getTime() - left.session.mtime.getTime()
            );
            return { results: filters.limit === undefined ? results : results.slice(0, filters.limit), issues: [] };
        }

        return {
            results: mergeSearchWaves(
                results.filter((result) => !result.session.isSubagent),
                results.filter((result) => result.session.isSubagent),
                {
                    limit: filters.limit,
                    sortByRelevance: ranksByRelevance(filters),
                }
            ),
            issues: [],
        };
    }

    private async searchSummaries(options: {
        filters: AgentSearchFilters;
        sources: NativeSessionSource<string>[];
        issues: NativeSourceIssue[];
    }): Promise<HistorySearchResponse> {
        const { filters, issues } = options;
        const { reader, repository, providerId } = this.options;
        const bounded = repository.metadata.listMetadata({ providerId, boundedOnly: true });
        const overrides = new Map<string, CachedHistoryMetadata>();
        const excludedKeys = new Set<string>();
        const sourceByPath = new Map<string, NativeSessionSource<string>[]>();

        for (const source of options.sources) {
            const group = sourceByPath.get(source.filePath) ?? [];
            group.push(source);
            sourceByPath.set(source.filePath, group);
        }

        const scoped = { ...filters, sourceRoots: (filters.sourceRoots ?? this.options.roots).map(canonicalRoot) };
        for (const cached of bounded) {
            if (
                !metadataInScope(cached, scoped) ||
                !(cached.storageTruncatedFields ?? cached.boundedFields).some((field) =>
                    ["customTitle", "summary", "firstPrompt", "allUserText"].includes(field)
                )
            ) {
                continue;
            }

            filters.signal?.throwIfAborted();
            const sources = sourceByPath.get(cached.filePath) ?? [];
            const source =
                sources.length === 1
                    ? sources[0]
                    : sources.find((candidate) => candidate.metadata?.sessionId === cached.nativeId);

            if (!source || !reader.readMetadata) {
                continue;
            }

            try {
                const revision = sourceFingerprint({
                    source,
                    parserVersion: reader.parserVersion,
                    fullMetadataSnapshot: true,
                });
                const full = await reader.readMetadata(source, { signal: filters.signal, fullSummaryFields: true });
                issues.push(...full.issues);
                filters.signal?.throwIfAborted();

                if (!full.complete || !full.metadata) {
                    continue;
                }

                if (
                    full.metadata.nativeId !== cached.nativeId ||
                    sourceFingerprint({ source, parserVersion: reader.parserVersion, fullMetadataSnapshot: true }) !==
                        revision
                ) {
                    excludedKeys.add(cached.sourceKey);
                    issues.push({
                        path: source.filePath,
                        message: "Source changed during summary lookup; retry to refresh results",
                    });
                    continue;
                }

                overrides.set(cached.sourceKey, { ...cached, ...full.metadata, sourceHome: cached.sourceHome });
            } catch (error) {
                filters.signal?.throwIfAborted();
                issues.push({
                    path: cached.filePath,
                    message: error instanceof Error ? error.message.slice(0, 300) : "Full summary fields unavailable",
                });
            }
        }

        return { ...this.queryCached({ filters, overrides, excludedKeys }), issues };
    }

    async search(filters: AgentSearchFilters = {}): Promise<HistorySearchResponse> {
        validateHistoryFilters(filters);
        filters.signal?.throwIfAborted();

        if (filters.limit === 0) {
            return { results: [], issues: [] };
        }

        const { reader, repository, providerId } = this.options;
        const restricted = Boolean(
            filters.file || filters.files?.some(Boolean) || filters.tool || filters.commitHash || filters.commitMessage
        );
        // A plain listing has nothing to match inside a transcript, so it is answered from
        // metadata exactly as the previous engine's listing shortcut did. Hydrating every record
        // instead turned `claude history --limit 5 --format json` from about 2 KB into 34 MB.
        const metadataOnly = (filters.summaryOnly || !filters.query) && !restricted;

        if (metadataOnly && !filters.query) {
            // Only the report is wanted here; going through catalog() built and filtered every
            // cached metadata row just to throw it away, and then queryCached read the same
            // table a second time (342 ms of the 684 ms this path spent on 12,029 rows).
            //
            // A refresh takes a write lock. Base never did on a warm index, so where base returned
            // results under contention this failed outright with `database is locked` after the
            // 5 s busy timeout. Stale results with a notice beat both that and a longer hang.
            try {
                const refreshed = await this.refreshListing(filters);
                return { ...this.cached(filters), issues: refreshed.report.issues };
            } catch (error) {
                if (!isDatabaseBusy(error)) {
                    throw error;
                }

                logger.warn({ error }, "History index is busy; serving the cached listing");
                return {
                    ...this.cached(filters),
                    issues: [
                        {
                            path: this.options.roots[0] ?? "",
                            message: "History index is busy; these results may be stale",
                        },
                    ],
                };
            }
        }

        const scope = { agentsOnly: filters.agentsOnly, excludeAgents: filters.excludeAgents, signal: filters.signal };
        const discovery = await reader.discover(this.options.roots, scope);
        const rawCandidates = metadataOnly
            ? undefined
            : await historyCandidates({ sources: discovery.sources, filters });
        const rawSources = new Set(rawCandidates?.map((candidate) => candidate.source.filePath));
        const contentCandidates =
            !metadataOnly && reader.searchMetadata && !restricted
                ? await historyCandidates({ sources: discovery.sources, filters: { signal: filters.signal } })
                : rawCandidates;
        const synchronized = await synchronizeHistory({
            ...this.options,
            signal: filters.signal,
            scope,
            discovery,
            metadataSources: contentCandidates
                ? new Set(contentCandidates.map((candidate) => candidate.source.filePath))
                : undefined,
        });
        const issues = [...synchronized.report.issues];
        const freshSources = new Map<string, NativeSessionSource<string>[]>();

        if (synchronized.sources !== discovery.sources) {
            for (const source of synchronized.sources) {
                const group = freshSources.get(source.filePath) ?? [];
                group.push(source);
                freshSources.set(source.filePath, group);
            }
        }

        const refreshedCandidates =
            synchronized.sources === discovery.sources
                ? contentCandidates
                : contentCandidates?.flatMap((candidate) => {
                      const group = freshSources.get(candidate.source.filePath) ?? [];
                      const source =
                          group.length === 1
                              ? group[0]
                              : group.find(
                                    (source) => source.metadata?.sessionId === candidate.source.metadata?.sessionId
                                );
                      return source ? [{ ...candidate, source }] : [];
                  });

        if (filters.summaryOnly && !restricted) {
            return this.searchSummaries({ filters, sources: synchronized.sources, issues });
        }

        const scoped = { ...filters, sourceRoots: (filters.sourceRoots ?? this.options.roots).map(canonicalRoot) };
        const byPath = new Map<string, CachedHistoryMetadata[]>();
        const lazyMetadata =
            !ranksByRelevance(filters) &&
            !reader.searchMetadata &&
            refreshedCandidates?.every((candidate) => candidate.source.metadata?.isSubagent !== undefined);

        for (const metadata of repository.metadata.listMetadata({
            providerId,
            filePaths: lazyMetadata ? [] : (refreshedCandidates?.map((candidate) => candidate.source.filePath) ?? []),
        })) {
            if (!metadataInScope(metadata, { ...scoped, cwd: undefined, excludeSessions: undefined })) {
                continue;
            }

            const group = byPath.get(metadata.filePath) ?? [];
            group.push(metadata);
            byPath.set(metadata.filePath, group);
        }

        const metadataFor = (source: NativeSessionSource<string>) => {
            let metadata = byPath.get(source.filePath);
            if (metadata === undefined && lazyMetadata) {
                metadata = repository.metadata
                    .listMetadata({ providerId, filePath: source.filePath })
                    .filter((row) => metadataInScope(row, { ...scoped, cwd: undefined, excludeSessions: undefined }));
                byPath.set(source.filePath, metadata);
            }
            return metadata ?? [];
        };

        const matches: MatchedHistorySource[] = [];
        const results: HistorySearchResult[] = [];

        const candidates = (refreshedCandidates ?? []).filter((candidate) => {
            if (lazyMetadata) {
                return rawSources.has(candidate.source.filePath);
            }
            const metadata = byPath.get(candidate.source.filePath);
            return (
                metadata &&
                (rawSources.has(candidate.source.filePath) ||
                    metadata.some((entry) => matchesHistoryMetadata(entry, filters)))
            );
        });
        const relevance = ranksByRelevance(filters);
        /**
         * The wave loop below breaks once it has `limit` results, so the scan order has to be the
         * order the results are presented in — `mergeSearchWaves` sorts by the SESSION timestamp,
         * not the file mtime. Those two agree on the live index to 100 of 100 at the top and first
         * diverge around 300, but a file touched long after its last message breaks it outright:
         * with a limit of 1 the scan returned the stale session and never looked at the newer one.
         *
         * The session's own last timestamp is also an upper bound on any match inside it, so
         * ordering by it cannot put a candidate behind one it should outrank. `mtime` remains the
         * fallback for a source with no recorded timestamps at all.
         */
        // `byPath` is empty on the lazy path — `listMetadata` returns nothing for an empty
        // `filePaths`, which is how a Claude search avoids loading the whole corpus's metadata. So
        // read the timestamps for the CANDIDATES only: one query, already narrowed by ripgrep,
        // which is a different and much smaller thing than the load the lazy path exists to avoid.
        const candidateOrderTimes = new Map<string, number>();

        if (candidates.length > 0) {
            for (const metadata of repository.metadata.listMetadata({
                providerId,
                filePaths: candidates.map((candidate) => candidate.source.filePath),
            })) {
                const recorded = metadata.lastTimestamp ?? metadata.firstTimestamp;
                const parsed = recorded ? Date.parse(recorded) : Number.NaN;

                if (!Number.isNaN(parsed)) {
                    candidateOrderTimes.set(metadata.filePath, parsed);
                }
            }
        }

        // mtime stays the tiebreak, not the key: sessions that share a timestamp still need a
        // deterministic order, which is what `search-concurrency.test.ts` pins with twelve
        // identically-stamped fixtures.
        const candidateOrderKey = (candidate: (typeof candidates)[number]): number =>
            candidateOrderTimes.get(candidate.source.filePath) ?? candidate.mtime;
        candidates.sort((left, right) =>
            relevance
                ? Math.min(right.matchCount, RELEVANCE_MATCH_COUNT_CAP) -
                      Math.min(left.matchCount, RELEVANCE_MATCH_COUNT_CAP) ||
                  candidateOrderKey(right) - candidateOrderKey(left) ||
                  right.mtime - left.mtime
                : Number(Boolean(left.source.metadata?.isSubagent)) -
                      Number(Boolean(right.source.metadata?.isSubagent)) ||
                  candidateOrderKey(right) - candidateOrderKey(left) ||
                  right.mtime - left.mtime
        );
        const isAgent = (source: NativeSessionSource<string>) =>
            source.metadata?.isSubagent ?? byPath.get(source.filePath)?.[0]?.isSubagent ?? false;
        const mains = candidates.filter((candidate) => !isAgent(candidate.source));
        const agents = candidates.filter((candidate) => isAgent(candidate.source));
        const planned = relevance
            ? mains
                  .slice(0, relevanceParseCap(mains.length, filters.limit))
                  .concat(agents.slice(0, relevanceParseCap(agents.length, filters.limit)))
            : mains.concat(agents);

        const scanCandidate = async ({
            source,
        }: (typeof planned)[number]): Promise<MatchedHistorySource | undefined> => {
            filters.signal?.throwIfAborted();
            const candidates = metadataFor(source);
            const metadata =
                candidates.find((candidate) => candidate.nativeId === source.metadata?.sessionId) ??
                (candidates.length === 1 ? candidates[0] : undefined);

            if (!metadata) {
                return;
            }

            try {
                const revision = sourceFingerprint({
                    source,
                    parserVersion: reader.parserVersion,
                    fullMetadataSnapshot: true,
                });
                const match = await searchHistorySource({
                    source,
                    reader,
                    metadata,
                    filters,
                    now: this.options.now?.(),
                    allowMetadataMatch:
                        reader.searchMetadata &&
                        !restricted &&
                        repository.metadata.getSource(metadata.sourceKey)?.metadataRevision ===
                            sourceFingerprint({ source, parserVersion: reader.parserVersion }),
                    onIssue: (issue) => issues.push(issue),
                });

                if (match && metadataInScope(match.metadata, scoped)) {
                    return { source, match, revision };
                }
            } catch (error) {
                filters.signal?.throwIfAborted();
                issues.push({
                    path: source.filePath,
                    message: error instanceof Error ? error.message.slice(0, 300) : "Source search failed",
                });
            }
        };

        for (let offset = 0; offset < planned.length; ) {
            filters.signal?.throwIfAborted();
            const remaining = !relevance && filters.limit !== undefined ? filters.limit - results.length : 8;
            if (remaining <= 0) {
                break;
            }
            const batch = planned.slice(offset, offset + Math.min(8, remaining));
            const scanned = await concurrentMap({
                items: batch,
                concurrency: batch.length,
                fn: scanCandidate,
                onError: (_candidate, error) => {
                    throw error;
                },
            });
            for (const item of batch) {
                const candidate = scanned.get(item);
                if (!candidate) {
                    continue;
                }
                if (relevance) {
                    matches.push(candidate);
                } else {
                    const hydrated = await this.hydrateMatch({ candidate, filters, issues });
                    if (hydrated) {
                        results.push(hydrated);
                    }
                }
            }
            offset += batch.length;
        }

        const ranked = mergeSearchWaves(
            matches
                .filter((candidate) => !candidate.match.metadata.isSubagent)
                .map((candidate) => ({
                    ...candidate,
                    timestamp: candidate.match.timestamp,
                    relevanceScore: candidate.match.relevanceScore,
                })),
            matches
                .filter((candidate) => candidate.match.metadata.isSubagent)
                .map((candidate) => ({
                    ...candidate,
                    timestamp: candidate.match.timestamp,
                    relevanceScore: candidate.match.relevanceScore,
                })),
            { sortByRelevance: ranksByRelevance(filters) }
        );

        for (const candidate of ranked) {
            const hydrated = await this.hydrateMatch({ candidate, filters, issues });

            if (hydrated) {
                results.push(hydrated);
            }

            if (filters.limit !== undefined && filters.limit > 0 && results.length >= filters.limit) {
                break;
            }
        }

        return {
            results: mergeSearchWaves(
                results.filter((result) => !result.session.isSubagent),
                results.filter((result) => result.session.isSubagent),
                {
                    limit: filters.limit,
                    sortByRelevance: relevance,
                }
            ),
            issues,
        };
    }
}
