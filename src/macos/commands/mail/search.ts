import logger from "@app/logger";
import { ALL_COLUMN_KEYS, type MailColumnKey } from "@app/macos/lib/mail/columns";
import { needsRecipients, outputFormattedResults, resolveColumnsFromFlag } from "@app/macos/lib/mail/command-helpers";
import { searchBodies } from "@app/macos/lib/mail/jxa";
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
import type { MailMessage, SearchOptions } from "@app/macos/lib/mail/types";
import { closeDarwinKit, rankBySimilarity } from "@app/utils/macos";
import * as p from "@clack/prompts";
import type { Command } from "commander";

interface SearchCommandOptions {
    withoutBody?: boolean;
    receiver?: string;
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
        .option("--without-body", "Skip body search (faster, SQLite-only)")
        .option("--receiver <email>", "Filter by receiver email address")
        .option("--help-receivers", "List all receiver accounts/addresses")
        .option("--from <date>", "Search from date (ISO format, e.g. 2026-01-01)")
        .option("--to <date>", "Search to date (ISO format)")
        .option("--mailbox <name>", "Restrict to specific mailbox (e.g. INBOX, Sent)")
        .option("--limit <n>", "Max results", "100")
        .option("--no-semantic", "Disable semantic re-ranking (faster, uses keyword order only)")
        .option("--max-distance <n>", "Max semantic distance to include (0–2, default: 1.2)", "1.2")
        .option("--columns [cols]", "Columns to show (" + ALL_COLUMN_KEYS.join(",") + ")")
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
                    from: parseDate(options.from),
                    to: parseDate(options.to),
                    mailbox: options.mailbox,
                    limit: Number.parseInt(options.limit ?? "100", 10),
                };

                // Phase 1: SQLite metadata search
                const spinner = p.spinner();
                const totalMessages = getMessageCount();
                spinner.start(`Searching metadata across ${totalMessages.toLocaleString()} messages (SQLite)...`);

                const startSqlite = performance.now();
                const rows = searchMessages(searchOpts);
                const sqliteMs = performance.now() - startSqlite;

                spinner.stop(`Found ${rows.length} metadata matches in ${(sqliteMs / 1000).toFixed(1)}s`);

                if (rows.length === 0) {
                    p.log.info("No messages found matching your query.");
                    cleanup();
                    return;
                }

                // Enrich with attachments
                const rowids = rows.map((r) => r.rowid);
                const attachmentsMap = getAttachments(rowids);
                const messages: MailMessage[] = rows.map((row) => {
                    const msg = rowToMessage(row);
                    msg.attachments = attachmentsMap.get(row.rowid) ?? [];
                    return msg;
                });

                // Phase 2: JXA body search (unless --without-body)
                if (!searchOpts.withoutBody && rows.length > 0) {
                    spinner.start(`Searching body content in ${rows.length} messages (JXA)...`);

                    const startJxa = performance.now();
                    const bodyMatches = await searchBodies(
                        messages.map((m) => ({
                            rowid: m.rowid,
                            subject: m.subject,
                            mailbox: m.mailbox,
                        })),
                        query
                    );
                    const jxaMs = performance.now() - startJxa;

                    for (const msg of messages) {
                        msg.bodyMatchesQuery = bodyMatches.has(msg.rowid);
                    }

                    const bodyMatchCount = bodyMatches.size;
                    spinner.stop(
                        `Body search complete: ${bodyMatchCount} body matches in ${(jxaMs / 1000).toFixed(1)}s`
                    );
                }

                // Phase 3: Semantic re-ranking via darwinkit (default ON, opt out with --no-semantic)
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
