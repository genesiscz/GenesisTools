import { logger } from "@app/logger";
import { ALL_COLUMN_KEYS, type MailColumnKey } from "@app/macos/lib/mail/columns";
import {
    enrichWithBodies,
    needsRecipients,
    outputFormattedResults,
    parseMailDate,
    printStructured,
    resolveColumnsFromFlag,
} from "@app/macos/lib/mail/command-helpers";
import { resolveMailSearchMode, runMailSearch } from "@app/macos/lib/mail/search-runner";
import type { SearchOptions } from "@app/macos/lib/mail/types";
import { isQuietOutput } from "@app/utils/cli/output-mode";
import { createQuietSpinner } from "@app/utils/cli/quiet-spinner";
import { MailDatabase } from "@app/utils/macos/MailDatabase";
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
                    const receivers = await db.listReceivers();

                    if (isStructuredOutput) {
                        await printStructured(receivers, options.format ?? "json");
                        return;
                    }

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

                const searchOpts: SearchOptions = db.resolveMailboxFilter({
                    query,
                    withoutBody: options.withoutBody,
                    receiver: options.receiver,
                    account: options.account,
                    from: parseMailDate(options.from),
                    to: parseMailDate(options.to, true),
                    mailbox: options.mailbox,
                    limit: Number.parseInt(options.limit ?? "100", 10),
                    offset: Number.parseInt(options.offset ?? "0", 10),
                });

                const outcome = await runMailSearch(query, {
                    searchOpts,
                    mode: resolveMailSearchMode(options.mode),
                    jxa: options.jxa,
                    semantic: options.semantic,
                    maxDistance: options.maxDistance ? Number.parseFloat(options.maxDistance) : undefined,
                    db,
                    onProgress: spinner,
                    onWarning: (message): void => {
                        if (isStructuredOutput || quiet) {
                            process.stderr.write(`WARN: ${message}\n`);
                            return;
                        }

                        logger.warn(message);
                    },
                });
                const messages = outcome.messages;

                if (messages.length === 0) {
                    announce("No messages found matching your query.");

                    if (isStructuredOutput) {
                        await outputFormattedResults({
                            messages: [],
                            columns: baseColumns,
                            format: options.format ?? "table",
                        });
                    }

                    return;
                }

                await enrichWithBodies(messages, baseColumns);

                const finalColumns = buildSearchColumns({
                    columns: baseColumns,
                    withBody: !searchOpts.withoutBody,
                    ftsActive: outcome.searchMethod === "fts",
                    semanticActive: messages.some((m) => m.semanticScore !== undefined),
                    columnsExplicit: options.columns !== undefined,
                });

                if (needsRecipients(finalColumns)) {
                    const recipientsMap = await db.getRecipients(messages.map((m) => m.rowid));

                    for (const msg of messages) {
                        msg.recipients = recipientsMap.get(msg.rowid) ?? [];
                    }
                }

                const paginationOffset = searchOpts.offset ?? 0;
                const pageLimit = searchOpts.limit ?? 100;
                const totalCount = outcome.totalCount;
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
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                const verboseDetails = error instanceof Error ? (error.stack ?? error.message) : String(error);

                if (quiet) {
                    logger.error(msg);
                } else {
                    p.log.error(msg);
                }

                logger.debug(`[mail/search] stack trace:\n${verboseDetails}`);

                process.exit(1);
            } finally {
                db.close();
            }
        });
}
