import { existsSync } from "node:fs";
import { join } from "node:path";
import { getIndexerStorage } from "@app/indexer/lib/storage";
import { searchIndexReadonly } from "@app/indexer/lib/store";
import logger from "@app/logger";
import { ENVELOPE_INDEX_PATH } from "@app/macos/lib/mail/constants";
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
import type { MailMessage, MailMessageRow, SearchOptions } from "@app/macos/lib/mail/types";
import { closeDarwinKit, rankBySimilarity } from "@app/utils/macos";
import type { MailDatabase } from "@app/utils/macos/MailDatabase";

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

    logger.debug(
        `[mail/search] mode=${resolvedMode} willUseIndex=${willUseIndex} ` +
            `indexExists=${indexExists} jxa=${options.jxa ?? false} ` +
            `withoutBody=${searchOpts.withoutBody ?? false} indexDbPath=${indexDbPath}`
    );

    if (willUseIndex) {
        options.onProgress?.start(formatSearchLabelStart(resolvedMode));
        const t0 = performance.now();
        const fetchLimit = Math.max((searchOpts.offset ?? 0) + (searchOpts.limit ?? 100), STABLE_INDEX_FETCH_LIMIT);

        const ftsResults = await searchIndexReadonly(MAIL_INDEX_NAME, query, {
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
        });

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
        rows = ftsRowids.length > 0 ? await options.db.getMessagesByRowids(ftsRowids, searchOpts) : [];
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
            mdfindMailRowids(query),
            options.db.searchMessages(searchOpts),
        ]);
        const rowidSet = new Set<number>(likeRows.map((r) => r.rowid));
        const newSpotlightIds = spotlightRowids.filter((r) => !rowidSet.has(r));
        const spotlightRows =
            newSpotlightIds.length > 0 ? await options.db.getMessagesByRowids(newSpotlightIds, searchOpts) : [];

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
    const attachmentsMap = await options.db.getAttachments(rowids);
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
            const ranked = await rankBySimilarity(query, items, { maxDistance: maxDist, language: "en" });
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
