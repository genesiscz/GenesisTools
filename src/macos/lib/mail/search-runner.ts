import { existsSync } from "node:fs";
import { join } from "node:path";
import { getIndexerStorage } from "@app/indexer/lib/storage";
import { searchIndexReadonly } from "@app/indexer/lib/store";
import { buildMailFilterPredicate } from "@app/macos/lib/mail/search-filters";
import {
    formatFallbackStart,
    formatFallbackStop,
    formatSearchLabelEmpty,
    formatSearchLabelStart,
    formatSearchLabelStop,
    type ResolvedMethod,
} from "@app/macos/lib/mail/search-label";
import { mdfindMailRowids } from "@app/macos/lib/mail/spotlight";
import { rowToMessage } from "@app/macos/lib/mail/transform";
import { logger } from "@genesiscz/utils/logger";
import { closeDarwinKit, rankBySimilarity } from "@genesiscz/utils/macos";
import type { MailDatabase } from "@genesiscz/utils/macos/MailDatabase";
import { ENVELOPE_INDEX_PATH } from "@genesiscz/utils/macos/mail/constants";
import type { MailMessage, MailMessageRow, SearchOptions } from "@genesiscz/utils/macos/mail/types";
import { profiler } from "@genesiscz/utils/profile";
import { SQLITE_VEC_MAX_K } from "@genesiscz/utils/search/stores/sqlite-vec-store";

export type MailSearchMode = "auto" | "fulltext" | "hybrid" | "vector";

const VALID_MAIL_SEARCH_MODES = new Set<MailSearchMode>(["auto", "fulltext", "hybrid", "vector"]);

export function isMailSearchMode(input: string): input is MailSearchMode {
    return VALID_MAIL_SEARCH_MODES.has(input as MailSearchMode);
}

export function resolveMailSearchMode(input: string | undefined): MailSearchMode {
    if (!input) {
        return "auto";
    }

    if (isMailSearchMode(input)) {
        return input;
    }

    throw new Error(`Unknown --mode: "${input}". Valid: ${[...VALID_MAIL_SEARCH_MODES].join(", ")}`);
}

export interface RunMailSearchOptions {
    searchOpts: SearchOptions;
    mode: MailSearchMode;
    jxa?: boolean;
    semantic?: boolean;
    maxDistance?: number;
    db: MailDatabase;
    onProgress?: { start: (msg: string) => void; stop: (msg: string) => void };
    onWarning?: (message: string) => void;
    /** Hard deadline per stage (index query, row fetch, fallback, attachments). Default 60 s. */
    timeoutMs?: number;
}

export const DEFAULT_SEARCH_TIMEOUT_MS = 60_000;

function stageTimeoutError(label: string, timeoutMs: number, elapsedMs: number): Error {
    return new Error(
        `mail search timed out after ${Math.round(elapsedMs / 1000)}s in stage "${label}" ` +
            `(deadline ${Math.round(timeoutMs / 1000)}s). Narrow --from/--to or --limit, or raise --timeout <seconds>.`
    );
}

/**
 * Wraps every stage of a search in a deadline. A stage that never settles rejects with an error that names
 * the stage, so a stuck Spotlight call or a lost promise ends as "timed out in stage X" instead of a silent
 * process that lives for an hour (hunter A, 2026-09-07).
 *
 * What the deadline can and cannot do: the timer runs on the event loop, so it fires only when the stage
 * yields. The index and row stages call SQLite synchronously (`db.query(...).all()`), and nothing here can
 * interrupt such a call while it runs. What the guard does guarantee is that a stage which comes back AFTER
 * its deadline is still reported as a timeout, never as a success, so an over-time query cannot slip
 * through as a result. Bounding a blocked SQLite call itself would need a worker or subprocess.
 */
export function stageGuard(timeoutMs: number): <T>(label: string, fn: () => Promise<T>) => Promise<T> {
    return async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
        logger.debug(`[mail/search] stage ${label} start`);
        const t0 = performance.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                reject(stageTimeoutError(label, timeoutMs, performance.now() - t0));
            }, timeoutMs);
        });

        try {
            const result = await Promise.race([fn(), deadline]);
            const elapsed = performance.now() - t0;

            if (elapsed > timeoutMs) {
                // The stage blocked the event loop past its deadline, so the timer never got to fire.
                throw stageTimeoutError(label, timeoutMs, elapsed);
            }

            logger.debug(`[mail/search] stage ${label} done in ${Math.round(elapsed)}ms`);
            return result;
        } finally {
            clearTimeout(timer);
        }
    };
}

export interface MailSearchOutcome {
    messages: MailMessage[];
    totalCount: number;
    resolvedMethod: ResolvedMethod | undefined;
    searchMethod: "fts" | "spotlight+like";
    snippetByRowid: Map<number, string>;
    scoreByRowid: Map<number, number>;
}

const MAIL_INDEX_NAME = "macos-mail";
const STABLE_INDEX_FETCH_LIMIT = 250;
const prof = profiler.scope("macos-mail");

/** Filtered cosine queries over-fetch 5x so the filter has candidates to drop. */
const FILTERED_VECTOR_OVERFETCH = 5;
/** Hybrid (RRF) builds a 3x pool for each side before merging. */
const HYBRID_POOL_FACTOR = 3;

/**
 * The vector side asks sqlite-vec for more neighbours than the page (3x for the RRF pool, 5x more when a
 * filter is attached) and sqlite-vec caps `k` at 4096. Past that the vector candidate pool is smaller than
 * the query wanted, so some documents that should have had a vector score get none. The cap is not a rank
 * boundary: in a hybrid search every returned result may still carry both scores, and with a selective
 * filter even the first one may lack the vector score. Says so once per run, without claiming a boundary.
 */
export function vectorCapWarning(
    fetchLimit: number,
    hasFilters: boolean,
    method: Exclude<ResolvedMethod, "bm25">
): string | undefined {
    const factor = (method === "rrf" ? HYBRID_POOL_FACTOR : 1) * (hasFilters ? FILTERED_VECTOR_OVERFETCH : 1);
    const asked = fetchLimit * factor;

    if (asked <= SQLITE_VEC_MAX_K) {
        return undefined;
    }

    const kind = method === "rrf" ? "hybrid" : "vector";
    const effect =
        method === "rrf"
            ? "vector recall is reduced; results are still ranked by fulltext and vector scores together, but some may carry a fulltext score only"
            : `only the ${SQLITE_VEC_MAX_K} nearest neighbours are considered before the filter and the page are applied`;

    return (
        `vector candidates capped at ${SQLITE_VEC_MAX_K} by sqlite-vec (the ${kind} search asked for ${asked} for ` +
        `--limit ${fetchLimit}); ${effect}`
    );
}

export async function runMailSearch(query: string, options: RunMailSearchOptions): Promise<MailSearchOutcome> {
    const searchOpts = options.searchOpts;
    const resolvedMode = options.mode;
    const filterPredicate = buildMailFilterPredicate(searchOpts);
    const indexerStorage = getIndexerStorage();
    const indexDbPath = join(indexerStorage.getIndexDir(MAIL_INDEX_NAME), "index.db");
    const indexExists = existsSync(indexDbPath);
    const willUseIndex = indexExists && !options.jxa && !searchOpts.withoutBody;
    const snippetByRowid = new Map<number, string>();
    const scoreByRowid = new Map<number, number>();
    let rows: MailMessageRow[] = [];
    let searchMethod: "fts" | "spotlight+like" = "spotlight+like";
    let resolvedMethod: ResolvedMethod | undefined;
    const guard = stageGuard(options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS);
    const stage = <T>(label: string, fn: () => Promise<T>): Promise<T> =>
        guard(label, () => prof.measureAsync(label, fn));

    logger.debug(
        `[mail/search] mode=${resolvedMode} willUseIndex=${willUseIndex} ` +
            `indexExists=${indexExists} jxa=${options.jxa ?? false} ` +
            `withoutBody=${searchOpts.withoutBody ?? false} indexDbPath=${indexDbPath}`
    );

    if (willUseIndex) {
        options.onProgress?.start(formatSearchLabelStart(resolvedMode));
        const t0 = performance.now();
        const fetchLimit = Math.max((searchOpts.offset ?? 0) + (searchOpts.limit ?? 100), STABLE_INDEX_FETCH_LIMIT);

        const ftsResults = await stage(`search.index.${resolvedMode}`, () =>
            searchIndexReadonly(MAIL_INDEX_NAME, query, {
                mode: resolvedMode,
                limit: fetchLimit,
                onWarning: options.onWarning,
                ...((searchOpts.from || searchOpts.to) && {
                    coverageCheck: {
                        from: searchOpts.from,
                        to: searchOpts.to,
                        onOutside: (advisory: string): void => {
                            process.stderr.write(advisory);
                        },
                    },
                }),
                ...(filterPredicate && {
                    filters: filterPredicate,
                    attach: { alias: "mailapp", dbPath: ENVELOPE_INDEX_PATH, mode: "ro" as const },
                }),
            })
        );

        const ms = performance.now() - t0;
        const ftsRowids: number[] = [];

        for (const r of ftsResults) {
            const sid = r.doc.sourceId ?? (r.doc as unknown as { source_id?: string }).source_id;

            if (!sid) {
                continue;
            }

            const rowid = Number(sid);
            ftsRowids.push(rowid);

            if (!snippetByRowid.has(rowid)) {
                const snippet =
                    r.ftsSnippet ??
                    (typeof r.doc.content === "string"
                        ? r.doc.content.replace(/\s+/g, " ").trim().slice(0, 200)
                        : undefined);

                if (snippet) {
                    snippetByRowid.set(rowid, snippet);
                }
            }

            if (typeof r.score === "number" && !scoreByRowid.has(rowid)) {
                scoreByRowid.set(rowid, r.score);
            }
        }

        resolvedMethod = ftsResults[0]?.method;
        const capWarning =
            resolvedMethod && resolvedMethod !== "bm25"
                ? vectorCapWarning(fetchLimit, !!filterPredicate, resolvedMethod)
                : undefined;

        if (capWarning) {
            logger.debug(`[mail/search] ${capWarning}`);
            options.onWarning?.(capWarning);
        }
        rows =
            ftsRowids.length > 0
                ? await stage("search.index.rows", () => options.db.getMessagesByRowids(ftsRowids, searchOpts))
                : [];
        searchMethod = "fts";

        const orderByRowid = new Map(ftsRowids.map((rowid, index) => [rowid, index]));
        rows.sort((a, b) => (orderByRowid.get(a.rowid) ?? Infinity) - (orderByRowid.get(b.rowid) ?? Infinity));

        if (rows.length > 0) {
            options.onProgress?.stop(formatSearchLabelStop(resolvedMode, resolvedMethod, rows.length, ms));
        } else {
            options.onProgress?.stop(formatSearchLabelEmpty(resolvedMode));
        }
    }

    if (!indexExists || (options.jxa ?? false) || (searchOpts.withoutBody ?? false)) {
        options.onProgress?.start(formatFallbackStart());
        const t0 = performance.now();

        const [spotlightRowids, likeRows] = await Promise.all([
            stage("search.fallback.spotlight", () => mdfindMailRowids(query)),
            stage("search.fallback.like", () => options.db.searchMessages(searchOpts)),
        ]);
        const rowidSet = new Set<number>(likeRows.map((r) => r.rowid));
        const newSpotlightIds = spotlightRowids.filter((r) => !rowidSet.has(r));
        const spotlightRows =
            newSpotlightIds.length > 0
                ? await stage("search.fallback.rows", () => options.db.getMessagesByRowids(newSpotlightIds, searchOpts))
                : [];

        rows = [...likeRows, ...spotlightRows];
        const fallbackOrder = new Map(rows.map((row, index) => [row.rowid, index]));
        rows = [...new Map(rows.map((row) => [row.rowid, row])).values()].sort(
            (a, b) => (fallbackOrder.get(a.rowid) ?? Infinity) - (fallbackOrder.get(b.rowid) ?? Infinity)
        );
        const ms = performance.now() - t0;
        options.onProgress?.stop(formatFallbackStop(rows.length, ms));
    }

    const isFts = searchMethod === "fts";
    const rowids = rows.map((r) => r.rowid);
    const attachmentsMap = await stage("search.attachments", () => options.db.getAttachments(rowids));
    const messages: MailMessage[] = rows.map((row) => {
        const msg = rowToMessage(row);
        msg.attachments = attachmentsMap.get(row.rowid) ?? [];
        msg.bodyMatchesQuery = isFts;
        msg.ftsSnippet = snippetByRowid.get(row.rowid);
        msg.searchScore = scoreByRowid.get(row.rowid);
        return msg;
    });

    if (options.semantic === true && messages.length > 0) {
        options.onProgress?.start(`Apple NL re-ranking ${messages.length} results...`);

        try {
            const maxDist = options.maxDistance ?? 1.2;
            const items = messages.map((m) => ({
                ...m,
                text: [m.subject, m.senderName, m.senderAddress, m.ftsSnippet ?? m.body ?? ""]
                    .filter(Boolean)
                    .join(" ")
                    .slice(0, 2000),
            }));
            const ranked = await stage("search.semantic", () =>
                rankBySimilarity(query, items, { maxDistance: maxDist, language: "en" })
            );
            const reordered: MailMessage[] = ranked.map((r) => {
                const msg = r.item as MailMessage;
                msg.semanticScore = r.score;
                return msg;
            });
            const rankedIds = new Set(reordered.map((m) => m.rowid));

            for (const msg of messages) {
                if (!rankedIds.has(msg.rowid)) {
                    reordered.push(msg);
                }
            }

            messages.length = 0;
            messages.push(...reordered);
            options.onProgress?.stop(`Semantic ranking complete (${ranked.length} relevant results)`);
        } catch (err) {
            options.onProgress?.stop(`Semantic ranking skipped: ${err instanceof Error ? err.message : String(err)}`);
            logger.warn(`Semantic ranking failed: ${err}`);
        } finally {
            closeDarwinKit();
        }
    }

    return {
        messages,
        totalCount: messages.length,
        resolvedMethod,
        searchMethod,
        snippetByRowid,
        scoreByRowid,
    };
}
