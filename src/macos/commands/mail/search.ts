import { existsSync } from "node:fs";
import { join } from "node:path";
import { getIndexerStorage } from "@app/indexer/lib/storage";
import { searchIndexReadonly } from "@app/indexer/lib/store";
import logger from "@app/logger";
import { ALL_COLUMN_KEYS, type MailColumnKey } from "@app/macos/lib/mail/columns";
import {
    enrichWithBodies,
    needsRecipients,
    outputFormattedResults,
    parseMailDate,
    resolveColumnsFromFlag,
} from "@app/macos/lib/mail/command-helpers";
import { ENVELOPE_INDEX_PATH } from "@app/macos/lib/mail/constants";
import { MailStorage } from "@app/macos/lib/mail/mail-storage";
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
import { isQuietOutput } from "@app/utils/cli/output-mode";
import { closeDarwinKit, rankBySimilarity } from "@app/utils/macos";
import { MailDatabase } from "@app/utils/macos/MailDatabase";
import * as p from "@clack/prompts";
import type { Command } from "commander";

type MailSearchMode = "auto" | "fulltext" | "hybrid" | "vector";
const VALID_MAIL_SEARCH_MODES = new Set<MailSearchMode>(["auto", "fulltext", "hybrid", "vector"]);

function isMailSearchMode(input: string): input is MailSearchMode {
    return VALID_MAIL_SEARCH_MODES.has(input as MailSearchMode);
}

function resolveMailSearchMode(input: string | undefined): MailSearchMode {
    if (!input) {
        return "auto";
    }

    if (isMailSearchMode(input)) {
        return input;
    }

    throw new Error(`Unknown --mode: "${input}". Valid: ${[...VALID_MAIL_SEARCH_MODES].join(", ")}`);
}

interface SearchCommandOptions {
    withoutBody?: boolean;
    jxa?: boolean;
    receiver?: string;
    account?: string;
    helpReceivers?: boolean;
    from?: string;
    to?: string;
    mailbox?: string;
    limit?: string;
    offset?: string;
    mode?: string;
    semantic?: boolean;
    maxDistance?: string;
    columns?: string | true;
    format?: string;
}

function buildSearchColumns({
    columns,
    withBody,
    ftsActive,
    semanticActive,
    columnsExplicit,
}: {
    columns: MailColumnKey[];
    withBody: boolean;
    ftsActive: boolean;
    semanticActive: boolean;
    columnsExplicit: boolean;
}): MailColumnKey[] {
    if (columnsExplicit) {
        return columns;
    }

    const result = [...columns];

    if (withBody && !result.includes("bodyMatch")) {
        result.push("bodyMatch");
    }

    if (ftsActive && !result.includes("ftsSnippet")) {
        result.push("ftsSnippet");
    }

    if (semanticActive && !result.includes("relevance")) {
        result.push("relevance");
    }

    return result;
}

const MAIL_INDEX_NAME = "macos-mail";
// Keep hybrid/vector filtered searches under sqlite-vec's k=4096 cap while
// making small pages stable enough that --limit 20 and --limit 50 share first-N.
const STABLE_INDEX_FETCH_LIMIT = 250;

interface QuietSpinner {
    start: (msg: string) => void;
    stop: (msg: string) => void;
}

function createQuietSpinner(): QuietSpinner {
    return {
        start: (): void => {},
        stop: (): void => {},
    };
}

export function registerSearchCommand(program: Command): void {
    program
        .command("search <query>")
        .description("Search emails by subject, sender, body, and attachment names")
        .option("--without-body", "Skip body search entirely (metadata-only)")
        .option("--jxa", "Skip FTS index, use SQLite LIKE search only")
        .option("--receiver <email>", "Filter by receiver email address")
        .option("--account <id>", "Filter by account (email address or UUID prefix)")
        .option("--help-receivers", "List all receiver accounts/addresses")
        .option("--from <date>", "Search from date (ISO format, e.g. 2026-01-01)")
        .option("--to <date>", "Search to date (ISO format)")
        .option("--mailbox <name>", "Restrict to specific mailbox (e.g. INBOX, Sent)")
        .option("--limit <n>", "Max results", "100")
        .option("--offset <n>", "Skip first N results (for pagination)", "0")
        .option("--mode <mode>", "Search mode: auto | fulltext | hybrid | vector (default: auto)", "auto")
        .option("--semantic", "Enable Apple NL re-ranking after RRF (not recommended — overwrites embedding scores)")
        .option("--max-distance <n>", "Max semantic distance to include (0–2, default: 1.2)", "1.2")
        .option("--columns [cols]", `Columns to show (${ALL_COLUMN_KEYS.join(",")})`)
        .option("-f, --format <type>", "Output format: table, json, toon", "table")
        .action(async (query: string, options: SearchCommandOptions) => {
            const isStructuredOutput = (options.format ?? "table") !== "table";
            const quiet = isQuietOutput(options.format);
            const announce = (msg: string): void => {
                if (isStructuredOutput || quiet) {
                    logger.info(msg);
                } else {
                    p.log.info(msg);
                }
            };
            const spinner = isStructuredOutput || quiet ? createQuietSpinner() : p.spinner();
            const db = new MailDatabase();

            try {
                if (options.helpReceivers) {
                    const receivers = db.listReceivers();
                    announce("\nReceiver addresses (by message count):\n");

                    for (const r of receivers) {
                        const name = r.name ? ` (${r.name})` : "";
                        announce(`  ${r.address}${name}  [${r.messageCount} msgs]`);
                    }

                    return;
                }

                const baseColumns = await resolveColumnsFromFlag(options.columns);

                if (!baseColumns) {
                    return;
                }

                const searchOpts: SearchOptions = {
                    query,
                    withoutBody: options.withoutBody,
                    receiver: options.receiver,
                    account: options.account,
                    from: parseMailDate(options.from),
                    to: parseMailDate(options.to, true),
                    mailbox: options.mailbox,
                    limit: Number.parseInt(options.limit ?? "100", 10),
                    offset: Number.parseInt(options.offset ?? "0", 10),
                };

                const resolvedMode = resolveMailSearchMode(options.mode);
                const filterPredicate = buildMailFilterPredicate(searchOpts);

                const indexerStorage = getIndexerStorage();
                const indexDbPath = join(indexerStorage.getIndexDir(MAIL_INDEX_NAME), "index.db");
                const indexExists = existsSync(indexDbPath);

                let rows: MailMessageRow[] = [];
                const snippetByRowid = new Map<number, string>();
                let searchMethod: "fts" | "spotlight+like" = "spotlight+like";
                let resolvedMethod: ResolvedMethod | undefined;

                if (indexExists && !options.jxa && !searchOpts.withoutBody) {
                    spinner.start(formatSearchLabelStart(resolvedMode));
                    const t0 = performance.now();

                    const fetchLimit = Math.max(
                        (searchOpts.offset ?? 0) + (searchOpts.limit ?? 100),
                        STABLE_INDEX_FETCH_LIMIT
                    );

                    const ftsResults = await searchIndexReadonly(MAIL_INDEX_NAME, query, {
                        mode: resolvedMode,
                        limit: fetchLimit,
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
                    }

                    resolvedMethod = ftsResults[0]?.method;
                    rows = ftsRowids.length > 0 ? db.getMessagesByRowids(ftsRowids) : [];
                    searchMethod = "fts";

                    const orderByRowid = new Map(ftsRowids.map((rowid, index) => [rowid, index]));
                    rows.sort(
                        (a, b) => (orderByRowid.get(a.rowid) ?? Infinity) - (orderByRowid.get(b.rowid) ?? Infinity)
                    );

                    if (rows.length > 0) {
                        spinner.stop(formatSearchLabelStop(resolvedMode, resolvedMethod, rows.length, ms));
                    } else {
                        spinner.stop(formatSearchLabelEmpty(resolvedMode));
                    }
                }

                if (!indexExists || (options.jxa ?? false) || (searchOpts.withoutBody ?? false)) {
                    spinner.start(formatFallbackStart());
                    const t0 = performance.now();

                    const [spotlightRowids, likeRows] = await Promise.all([
                        mdfindMailRowids(query),
                        Promise.resolve(db.searchMessages(searchOpts)),
                    ]);

                    const rowidSet = new Set<number>(likeRows.map((r) => r.rowid));
                    const newSpotlightIds = spotlightRowids.filter((r) => !rowidSet.has(r));

                    const spotlightRows =
                        newSpotlightIds.length > 0
                            ? db.getMessagesByRowids(newSpotlightIds, {
                                  from: searchOpts.from,
                                  to: searchOpts.to,
                                  mailbox: searchOpts.mailbox,
                                  receiver: searchOpts.receiver,
                                  account: searchOpts.account,
                              })
                            : [];

                    rows = [...likeRows, ...spotlightRows];
                    const fallbackOrder = new Map(rows.map((row, index) => [row.rowid, index]));
                    rows = [...new Map(rows.map((row) => [row.rowid, row])).values()].sort(
                        (a, b) => (fallbackOrder.get(a.rowid) ?? Infinity) - (fallbackOrder.get(b.rowid) ?? Infinity)
                    );
                    const ms = performance.now() - t0;
                    spinner.stop(formatFallbackStop(rows.length, ms));
                }

                if (rows.length === 0) {
                    announce("No messages found matching your query.");
                    return;
                }

                const isFts = searchMethod === "fts";
                const rowids = rows.map((r) => r.rowid);
                const attachmentsMap = db.getAttachments(rowids);

                const messages: MailMessage[] = rows.map((row) => {
                    const msg = rowToMessage(row);
                    msg.attachments = attachmentsMap.get(row.rowid) ?? [];
                    msg.bodyMatchesQuery = isFts;
                    msg.ftsSnippet = snippetByRowid.get(row.rowid);
                    return msg;
                });

                await enrichWithBodies(messages, baseColumns);

                let semanticActive = false;

                if (options.semantic === true && messages.length > 0) {
                    spinner.start(`Apple NL re-ranking ${messages.length} results…`);

                    try {
                        const maxDist = Number.parseFloat(options.maxDistance ?? "1.2");
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
                        semanticActive = true;
                        spinner.stop(`Semantic ranking complete (${ranked.length} relevant results)`);
                    } catch (err) {
                        spinner.stop(`Semantic ranking skipped: ${err instanceof Error ? err.message : String(err)}`);
                        logger.warn(`Semantic ranking failed: ${err}`);
                    } finally {
                        closeDarwinKit();
                    }
                }

                const finalColumns = buildSearchColumns({
                    columns: baseColumns,
                    withBody: !searchOpts.withoutBody,
                    ftsActive: isFts,
                    semanticActive,
                    columnsExplicit: options.columns !== undefined,
                });

                if (needsRecipients(finalColumns)) {
                    const recipientsMap = db.getRecipients(rowids);

                    for (const msg of messages) {
                        msg.recipients = recipientsMap.get(msg.rowid) ?? [];
                    }
                }

                const paginationOffset = searchOpts.offset ?? 0;
                const pageLimit = searchOpts.limit ?? 100;
                const totalCount = messages.length;
                const paginatedMessages = messages.slice(paginationOffset, paginationOffset + pageLimit);

                await outputFormattedResults({
                    messages: paginatedMessages,
                    columns: finalColumns,
                    format: options.format ?? "table",
                });

                if (!isStructuredOutput && !quiet && (options.format ?? "table") === "table") {
                    const rangeEnd = Math.min(paginationOffset + pageLimit, totalCount);
                    const rangeLabel =
                        paginationOffset > 0
                            ? `${paginationOffset + 1}–${rangeEnd} of ${totalCount}`
                            : `${paginatedMessages.length}`;
                    p.log.info(
                        `${rangeLabel} results.${totalCount > pageLimit ? " Use --offset/--limit to paginate." : ""}`
                    );
                }

                const mailStorage = new MailStorage();
                const resultsPath = mailStorage.saveSearchResults(messages);
                logger.debug(`Saved search results to ${resultsPath}`);
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);

                if (quiet) {
                    logger.error(msg);
                } else {
                    p.log.error(msg);
                }

                process.exit(1);
            } finally {
                db.close();
            }
        });
}
