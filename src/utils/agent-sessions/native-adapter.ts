import type { Database } from "bun:sqlite";
import { logger } from "@genesiscz/utils/logger";
import { openHistoryReadOnly } from "./database";
import { openHistoryCached, openHistoryService } from "./open-service";
import { readerHasKind, resolveHistoryProvider } from "./provider";
import type { HistorySearchResult } from "./service";
import { readHistoryStatus } from "./sync-repository";
import type { AgentKind, AgentSearchHit, AgentSessionAdapter, NativeSessionReader, NativeSourceIssue } from "./types";

export function nativeReaderFor(kind: AgentKind): NativeSessionReader {
    const { reader } = resolveHistoryProvider(kind);

    if (!readerHasKind(reader, kind)) {
        throw new Error(`${kind} registered a native reader for ${reader.kind}`);
    }

    return reader;
}

function nativeHit<Kind extends string>(result: HistorySearchResult, kind: Kind): AgentSearchHit<Kind> {
    if (result.session.kind !== kind) {
        throw new Error("History result belongs to another provider");
    }

    const records = result.contextRecords.length ? result.contextRecords : result.matchedRecords;
    return {
        ...result.session,
        kind,
        matchedText: result.matchedText,
        matchedEntries: result.matchedEntries,
        contextEntries: result.contextEntries,
        relevanceScore: result.relevanceScore,
        sourceRecords: records.map((record) => ({ line: record.position + 1, data: record.original })),
    };
}

/**
 * A systemic problem produces one issue per source, so an unbounded dump wrote thousands of lines
 * to stderr AND to the day log on every single search. Name the scale, show enough to diagnose.
 */
function issueSample(kind: string, issues: NativeSourceIssue[]) {
    return { kind, total: issues.length, issues: issues.slice(0, 20) };
}

export function createNativeHistoryAdapter<Kind extends string = AgentKind>(options: {
    kind: Kind;
    provider?: string;
    roots?: string[];
    database?: Database;
}): AgentSessionAdapter<Kind> {
    // The kind and provider are fixed at construction, so resolving them per call ran the plugin
    // registry twice for every list, search, sync and status.
    let resolved: string | undefined;
    const providerId = () => {
        if (resolved === undefined) {
            const provider = resolveHistoryProvider(options.provider ?? options.kind);

            if (provider.reader.kind !== options.kind) {
                throw new Error(
                    `Provider ${provider.id} supplies ${provider.reader.kind} history, not ${options.kind}`
                );
            }

            resolved = provider.id;
        }

        return resolved;
    };
    const service = () =>
        openHistoryService({ provider: providerId(), roots: options.roots, database: options.database });

    return {
        kind: options.kind,
        async list(filters) {
            return this.search({ ...filters, query: undefined, summaryOnly: true });
        },
        async unresolvedIdentities() {
            const opened = openHistoryCached({
                provider: providerId(),
                roots: options.roots,
                database: options.database,
            });

            if (!opened) {
                return 0;
            }

            try {
                return opened.service.unresolvedIdentities();
            } catch (error) {
                logger.debug({ error, kind: options.kind }, "Unresolved-identity count unavailable");
                return 0;
            } finally {
                opened.close();
            }
        },
        async listCached(filters) {
            // The open is INSIDE the try: `new Database(missing, { readonly: true })` throws, so a
            // concurrent `history index --rebuild` renaming the file mid-rescue would otherwise
            // fail the whole capture instead of degrading to an empty catalog.
            let opened: ReturnType<typeof openHistoryCached>;

            try {
                opened = openHistoryCached({
                    provider: providerId(),
                    roots: options.roots,
                    database: options.database,
                });
            } catch (error) {
                logger.warn({ error, kind: options.kind }, "Cached history index could not be opened");
                return [];
            }

            if (!opened) {
                // A rescue that silently drops every resume target is the worst shape this can
                // take, so say so: nothing is indexed yet, and only a full refresh could answer.
                logger.warn({ kind: options.kind }, "No history index yet; cached listing is empty");
                return [];
            }

            try {
                const response = opened.service.cached({ ...filters, query: undefined, summaryOnly: true });
                return response.results.map((result) => nativeHit(result, options.kind));
            } catch (error) {
                // A database written before the compact schema has no provider column, so the
                // cached query throws. A rescue path degrades to "nothing indexed" rather than
                // failing the whole capture.
                logger.warn({ error, kind: options.kind }, "Cached history listing unavailable");
                return [];
            } finally {
                opened.close();
            }
        },
        async search(filters) {
            const response = await service().search(filters);

            if (response.issues.length) {
                logger.warn(issueSample(options.kind, response.issues), "History source issues");
            }

            return response.results.map((result) => nativeHit(result, options.kind));
        },
        async sync(syncOptions) {
            return (await service().sync(syncOptions)).report;
        },
        async refreshStatistics(statisticsOptions) {
            return service().refreshStatistics(statisticsOptions);
        },
        async status() {
            const id = providerId();

            if (options.database) {
                return readHistoryStatus(options.database, id);
            }

            const db = openHistoryReadOnly();

            try {
                return readHistoryStatus(db, id);
            } finally {
                db?.close();
            }
        },
    };
}

export function createClaudeAdapter(roots?: string[]): AgentSessionAdapter {
    return createNativeHistoryAdapter({ kind: "claude", roots });
}
