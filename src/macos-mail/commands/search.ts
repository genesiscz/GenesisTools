import * as p from "@clack/prompts";
import type { Command } from "commander";
import logger from "@app/logger";
import {
    searchMessages,
    getAttachments,
    listReceivers,
    cleanup,
    getMessageCount,
} from "@app/macos-mail/lib/sqlite";
import { searchBodies } from "@app/macos-mail/lib/jxa";
import { formatResultsTable } from "@app/macos-mail/lib/format";
import { rowToMessage } from "@app/macos-mail/lib/transform";
import type { MailMessage, SearchOptions } from "@app/macos-mail/lib/types";

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
        .action(async (query: string, options: {
            withoutBody?: boolean;
            receiver?: string;
            helpReceivers?: boolean;
            from?: string;
            to?: string;
            mailbox?: string;
            limit?: string;
        }) => {
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
                    if (!s) return undefined;
                    const d = new Date(s);
                    if (Number.isNaN(d.getTime())) {
                        throw new Error(`Invalid date: ${s}`);
                    }
                    return d;
                };

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
                spinner.start(
                    `Searching metadata across ${totalMessages.toLocaleString()} messages (SQLite)...`
                );

                const startSqlite = performance.now();
                const rows = searchMessages(searchOpts);
                const sqliteMs = performance.now() - startSqlite;

                spinner.stop(
                    `Found ${rows.length} metadata matches in ${(sqliteMs / 1000).toFixed(1)}s`
                );

                if (rows.length === 0) {
                    p.log.info("No messages found matching your query.");
                    cleanup();
                    return;
                }

                // Enrich with attachments
                const rowids = rows.map(r => r.rowid);
                const attachmentsMap = getAttachments(rowids);
                const messages: MailMessage[] = rows.map(row => {
                    const msg = rowToMessage(row);
                    msg.attachments = attachmentsMap.get(row.rowid) ?? [];
                    return msg;
                });

                // Phase 2: JXA body search (unless --without-body)
                if (!searchOpts.withoutBody && rows.length > 0) {
                    spinner.start(
                        `Searching body content in ${rows.length} messages (JXA)...`
                    );

                    const startJxa = performance.now();
                    const bodyMatches = await searchBodies(
                        messages.map(m => ({
                            rowid: m.rowid,
                            subject: m.subject,
                            mailbox: m.mailbox,
                        })),
                        query,
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

                // Output results table
                console.log("");
                console.log(formatResultsTable(messages, {
                    showBodyMatch: !searchOpts.withoutBody,
                }));
                console.log("");
                p.log.info(`${messages.length} results. Use 'tools macos-mail download <dir>' to export.`);

                // Save results to temp file for download command
                const tempResults = JSON.stringify(
                    messages.map(m => ({
                        ...m,
                        dateSent: m.dateSent.toISOString(),
                        dateReceived: m.dateReceived.toISOString(),
                    }))
                );
                await Bun.write("/tmp/macos-mail-last-search.json", tempResults);
                logger.debug("Saved search results to /tmp/macos-mail-last-search.json");

            } catch (error) {
                p.log.error(
                    error instanceof Error ? error.message : String(error)
                );
                process.exit(1);
            } finally {
                cleanup();
            }
        });
}
