import logger from "@app/logger";
import { ALL_COLUMN_KEYS, type MailColumnKey } from "@app/macos/lib/mail/columns";
import { needsRecipients, outputFormattedResults, resolveColumnsFromFlag } from "@app/macos/lib/mail/command-helpers";
import { MailStorage } from "@app/macos/lib/mail/mail-storage";
import {
    cleanup,
    getAttachments,
    getMessageCount,
    getRecipients,
    listReceivers,
    searchMessages,
} from "@app/macos/lib/mail/sqlite";
import { rowToMessage } from "@app/macos/lib/mail/transform";
import type { MailMessage, MailMessageRow, SearchOptions } from "@app/macos/lib/mail/types";
import { closeDarwinKit, rankBySimilarity } from "@app/utils/macos";
import * as p from "@clack/prompts";
import type { Command } from "commander";

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
    semantic?: boolean;
    maxDistance?: string;
    columns?: string | true;
    format?: string;
}

function buildSearchColumns({
    columns,
    withBody,
    semanticActive,
    columnsExplicit,
}: {
    columns: MailColumnKey[];
    withBody: boolean;
    semanticActive: boolean;
    columnsExplicit: boolean;
}): MailColumnKey[] {
    if (columnsExplicit) {
        return columns;
    }

    const result = [...columns];

    if (withBody && !result.includes("body")) {
        result.push("body");
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
        .option("--no-semantic", "Disable semantic re-ranking (faster, uses keyword order only)")
        .option("--max-distance <n>", "Max semantic distance to include (0–2, default: 1.2)", "1.2")
        .option("--columns [cols]", `Columns to show (${ALL_COLUMN_KEYS.join(",")})`)
        .option("-f, --format <type>", "Output format: table, json, toon", "table")
        .action(async (query: string, options: SearchCommandOptions) => {
            try {
                // Handle --help-receivers: list receiver addresses and exit
                if (options.helpReceivers) {
                    const receivers = listReceivers();
                    console.log("\nReceiver addresses (by message count):\n");

                    for (const r of receivers) {
                        const name = r.name ? ` (${r.name})` : "";
                        console.log(`  ${r.address}${name}  [${r.messageCount} msgs]`);
                    }

                    cleanup();
                    return;
                }

                const parseDate = (s?: string): Date | undefined => {
                    if (!s) {
                        return undefined;
                    }

                    const d = new Date(s);

                    if (Number.isNaN(d.getTime())) {
                        throw new Error(`Invalid date: ${s}`);
                    }

                    return d;
                };

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
                    from: parseDate(options.from),
                    to: parseDate(options.to),
                    mailbox: options.mailbox,
                    limit: Number.parseInt(options.limit ?? "100", 10),
                };

                const spinner = p.spinner();
                let rows: MailMessageRow[];
                let searchMethod: "fts" | "sqlite" | "jxa" = "sqlite";

                // FTS5 first, then SQLite LIKE fallback
                if (!options.jxa && !searchOpts.withoutBody) {
                    try {
                        const { searchIndexReadonly } = await import("@app/indexer/lib/store");
                        const { getMessagesByRowids } = await import("@app/macos/lib/mail/sqlite");

                        spinner.start("Searching (FTS index)...");
                        const startFts = performance.now();
                        const ftsResults = await searchIndexReadonly("macos-mail", query, {
                            mode: "fulltext",
                            limit: searchOpts.limit ?? 100,
                        });
                        const ftsMs = performance.now() - startFts;
                        // DB column is source_id, ChunkRecord type is sourceId
                        const ftsRowids = ftsResults
                            .map((r) => r.doc.sourceId ?? (r.doc as unknown as { source_id?: string }).source_id)
                            .filter(Boolean)
                            .map(Number);

                        if (ftsRowids.length > 0) {
                            rows = getMessagesByRowids(ftsRowids, {
                                from: searchOpts.from,
                                to: searchOpts.to,
                                mailbox: searchOpts.mailbox,
                                receiver: searchOpts.receiver,
                                account: searchOpts.account,
                            });
                            searchMethod = "fts";
                            spinner.stop(`FTS: ${rows.length} matches in ${(ftsMs / 1000).toFixed(1)}s`);
                        } else {
                            spinner.stop("FTS: 0 matches — falling back to metadata search");
                            rows = [];
                        }
                    } catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        logger.debug(`[search] FTS search failed: ${errMsg}`);
                        spinner.stop("FTS unavailable — using metadata search");
                        rows = [];
                    }
                } else {
                    rows = [];
                }

                // Fallback to tokenized LIKE
                if (rows.length === 0) {
                    const totalMessages = getMessageCount();
                    const label = searchMethod === "fts" ? "No FTS matches — searching" : "Searching";
                    spinner.start(`${label} metadata across ${totalMessages.toLocaleString()} messages...`);
                    const startSqlite = performance.now();
                    rows = searchMessages(searchOpts);
                    const sqliteMs = performance.now() - startSqlite;
                    searchMethod = "sqlite";
                    spinner.stop(`Found ${rows.length} metadata matches in ${(sqliteMs / 1000).toFixed(1)}s`);
                }

                if (rows.length === 0) {
                    p.log.info("No messages found matching your query.");
                    cleanup();
                    return;
                }

                // Enrich with attachments
                const isFts = searchMethod === "fts";
                const rowids = rows.map((r) => r.rowid);
                const attachmentsMap = getAttachments(rowids);
                const messages: MailMessage[] = rows.map((row) => {
                    const msg = rowToMessage(row);
                    msg.attachments = attachmentsMap.get(row.rowid) ?? [];
                    msg.bodyMatchesQuery = isFts;
                    return msg;
                });

                // Phase 3: Semantic re-ranking via Apple NaturalLanguage framework.
                // Uses on-device sentence similarity (not tied to the indexer's embedding model/provider).
                // Works regardless of which provider built the index. Opt out with --no-semantic.
                let semanticActive = false;

                if (options.semantic !== false && messages.length > 0) {
                    spinner.start(`Ranking ${messages.length} results by semantic similarity...`);

                    try {
                        const maxDist = parseFloat(options.maxDistance ?? "1.2");
                        const items = messages.map((m) => ({
                            ...m,
                            text: [m.subject, m.senderName, m.senderAddress].filter(Boolean).join(" "),
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
                    semanticActive,
                    columnsExplicit: options.columns !== undefined,
                });

                // Enrich with recipients if any recipient column is selected
                if (needsRecipients(finalColumns)) {
                    const recipientsMap = getRecipients(rowids);

                    for (const msg of messages) {
                        msg.recipients = recipientsMap.get(msg.rowid) ?? [];
                    }
                }

                // Output results
                await outputFormattedResults({
                    messages,
                    columns: finalColumns,
                    format: options.format ?? "table",
                });

                if ((options.format ?? "table") === "table") {
                    p.log.info(`${messages.length} results. Use 'tools macos mail download <dir>' to export.`);
                }

                // Save results for download command
                const mailStorage = new MailStorage();
                const resultsPath = mailStorage.saveSearchResults(messages);
                logger.debug(`Saved search results to ${resultsPath}`);
            } catch (error) {
                p.log.error(error instanceof Error ? error.message : String(error));
                process.exit(1);
            } finally {
                cleanup();
            }
        });
}
