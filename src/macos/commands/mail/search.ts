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
import { MailStorage } from "@app/macos/lib/mail/mail-storage";
import { MailDatabase } from "@app/utils/macos/MailDatabase";
import { rowToMessage } from "@app/macos/lib/mail/transform";
import type { MailMessage, MailMessageRow, SearchOptions } from "@app/macos/lib/mail/types";
import { closeDarwinKit, rankBySimilarity } from "@app/utils/macos";
import * as p from "@clack/prompts";
import type { Command } from "commander";

type MailSearchMode = "auto" | "fulltext" | "hybrid" | "vector";
const VALID_MAIL_SEARCH_MODES: readonly MailSearchMode[] = ["auto", "fulltext", "hybrid", "vector"];

function resolveMailSearchMode(input: string | undefined): MailSearchMode {
    if (!input) {
        return "auto";
    }

    if ((VALID_MAIL_SEARCH_MODES as readonly string[]).includes(input)) {
        return input as MailSearchMode;
    }

    throw new Error(`Unknown --mode: "${input}". Valid: ${VALID_MAIL_SEARCH_MODES.join(", ")}`);
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
            const db = new MailDatabase();

            try {
                // Handle --help-receivers: list receiver addresses and exit
                if (options.helpReceivers) {
                    const receivers = db.listReceivers();
                    console.log("\nReceiver addresses (by message count):\n");

                    for (const r of receivers) {
                        const name = r.name ? ` (${r.name})` : "";
                        console.log(`  ${r.address}${name}  [${r.messageCount} msgs]`);
                    }

                    return;
                }

                // Resolve columns
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

                const spinner = p.spinner();
                let rows: MailMessageRow[];
                let searchMethod: "fts" | "sqlite" | "jxa" = "sqlite";

                const resolvedMode = resolveMailSearchMode(options.mode);
                const snippetByRowid = new Map<number, string>();
                let ftsMethodLabel = "";

                // Index-based search first (fulltext / hybrid / vector), SQLite LIKE as fallback
                if (!options.jxa && !searchOpts.withoutBody) {
                    try {
                        spinner.start(`Searching (${resolvedMode} index)...`);
                        const startFts = performance.now();
                        // Fetch enough candidates for offset+limit pagination
                        const fetchLimit = (searchOpts.offset ?? 0) + (searchOpts.limit ?? 100);
                        const ftsResults = await searchIndexReadonly("macos-mail", query, {
                            mode: resolvedMode,
                            limit: fetchLimit,
                        });
                        const ftsMs = performance.now() - startFts;
                        // DB column is source_id, ChunkRecord type is sourceId
                        const ftsRowids: number[] = [];

                        for (const r of ftsResults) {
                            const sid = r.doc.sourceId ?? (r.doc as unknown as { source_id?: string }).source_id;

                            if (!sid) {
                                continue;
                            }

                            const rowid = Number(sid);
                            ftsRowids.push(rowid);

                            if (!snippetByRowid.has(rowid) && typeof r.doc.content === "string") {
                                snippetByRowid.set(rowid, r.doc.content.replace(/\s+/g, " ").trim().slice(0, 200));
                            }
                        }

                        if (ftsRowids.length > 0) {
                            rows = db.getMessagesByRowids(ftsRowids, {
                                from: searchOpts.from,
                                to: searchOpts.to,
                                mailbox: searchOpts.mailbox,
                                receiver: searchOpts.receiver,
                                account: searchOpts.account,
                            });
                            searchMethod = "fts";
                            ftsMethodLabel = (ftsResults[0]?.method ?? resolvedMode).toUpperCase();
                            spinner.stop(`${ftsMethodLabel}: ${rows.length} matches in ${(ftsMs / 1000).toFixed(1)}s`);
                        } else {
                            spinner.stop(`${resolvedMode}: 0 matches — falling back to metadata search`);
                            rows = [];
                        }
                    } catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        logger.debug(`[search] index search failed: ${errMsg}`);
                        spinner.stop("Index unavailable — using metadata search");
                        rows = [];
                    }
                } else {
                    rows = [];
                }

                // Fallback to tokenized LIKE
                if (rows.length === 0) {
                    const totalMessages = db.getMessageCount();
                    const label = searchMethod === "fts" ? "No FTS matches — searching" : "Searching";
                    spinner.start(`${label} metadata across ${totalMessages.toLocaleString()} messages...`);
                    const startSqlite = performance.now();
                    rows = db.searchMessages(searchOpts);
                    const sqliteMs = performance.now() - startSqlite;
                    searchMethod = "sqlite";
                    spinner.stop(`Found ${rows.length} metadata matches in ${(sqliteMs / 1000).toFixed(1)}s`);
                }

                if (rows.length === 0) {
                    p.log.info("No messages found matching your query.");
                    return;
                }

                // Enrich with attachments
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

                // Optional: Apple NL re-ranking (opt-in with --semantic).
                // Uses on-device sentence similarity — NOT the indexer's embedding model.
                // Not recommended: overwrites RRF embedding scores with Apple NL scores.
                let semanticActive = false;

                if (options.semantic === true && messages.length > 0) {
                    spinner.start(`Apple NL re-ranking ${messages.length} results (overwrites RRF embedding scores)...`);

                    try {
                        const maxDist = parseFloat(options.maxDistance ?? "1.2");
                        const items = messages.map((m) => ({
                            ...m,
                            text: [m.subject, m.senderName, m.senderAddress, m.ftsSnippet ?? m.body ?? ""]
                                .filter(Boolean)
                                .join(" ")
                                .slice(0, 2000),
                        }));
                        const ranked = await rankBySimilarity(query, items, {
                            maxDistance: maxDist,
                            language: "en",
                        });
                        // Re-order messages and attach scores
                        const reordered: MailMessage[] = ranked.map((r) => {
                            const msg = r.item as MailMessage;
                            msg.semanticScore = r.score;
                            return msg;
                        });
                        // Append messages that were filtered out (beyond maxDistance)
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
                        logger.warn(`Semantic ranking failed, falling back to keyword order: ${err}`);
                    } finally {
                        closeDarwinKit();
                    }
                }

                // Build final columns: add body/relevance if active and not already selected
                const finalColumns = buildSearchColumns({
                    columns: baseColumns,
                    withBody: !searchOpts.withoutBody,
                    ftsActive: isFts,
                    semanticActive,
                    columnsExplicit: options.columns !== undefined,
                });

                // Enrich with recipients if any recipient column is selected
                if (needsRecipients(finalColumns)) {
                    const recipientsMap = db.getRecipients(rowids);

                    for (const msg of messages) {
                        msg.recipients = recipientsMap.get(msg.rowid) ?? [];
                    }
                }

                // Apply pagination (offset/limit) AFTER ranking so ordering is stable
                const paginationOffset = searchOpts.offset ?? 0;
                const pageLimit = searchOpts.limit ?? 100;
                const totalCount = messages.length;
                const paginatedMessages = messages.slice(paginationOffset, paginationOffset + pageLimit);

                // Output results
                await outputFormattedResults({
                    messages: paginatedMessages,
                    columns: finalColumns,
                    format: options.format ?? "table",
                });

                if ((options.format ?? "table") === "table") {
                    const rangeEnd = Math.min(paginationOffset + pageLimit, totalCount);
                    const rangeLabel =
                        paginationOffset > 0
                            ? `${paginationOffset + 1}–${rangeEnd} of ${totalCount}`
                            : `${paginatedMessages.length}`;
                    p.log.info(
                        `${rangeLabel} results.${totalCount > pageLimit ? " Use --offset/--limit to paginate." : ""}`
                    );
                }

                // Save results for download command
                const mailStorage = new MailStorage();
                const resultsPath = mailStorage.saveSearchResults(messages);
                logger.debug(`Saved search results to ${resultsPath}`);
            } catch (error) {
                p.log.error(error instanceof Error ? error.message : String(error));
                process.exit(1);
            } finally {
                db.close();
            }
        });
}
