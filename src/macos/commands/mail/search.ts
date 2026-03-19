import { tmpdir } from "node:os";
import { join } from "node:path";
import logger from "@app/logger";
import {
    ALL_COLUMN_KEYS,
    DEFAULT_LIST_COLUMNS,
    MAIL_COLUMNS,
    type MailColumnKey,
    RECIPIENT_COLUMNS,
} from "@app/macos/lib/mail/columns";
import { formatResultsTable } from "@app/macos/lib/mail/format";
import { searchBodies } from "@app/macos/lib/mail/jxa";
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
import { parseVariadic } from "@app/utils/cli/variadic";
import { SafeJSON } from "@app/utils/json";
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

function resolveColumns(rawColumns: string | true | undefined): MailColumnKey[] | "interactive" {
    if (rawColumns === undefined) {
        return DEFAULT_LIST_COLUMNS;
    }

    if (rawColumns === true) {
        return "interactive";
    }

    const parsed = parseVariadic(rawColumns);
    const valid: MailColumnKey[] = [];

    for (const col of parsed) {
        if (ALL_COLUMN_KEYS.includes(col as MailColumnKey)) {
            valid.push(col as MailColumnKey);
        } else {
            p.log.warn(`Unknown column "${col}" — available: ${ALL_COLUMN_KEYS.join(", ")}`);
        }
    }

    if (valid.length === 0) {
        return DEFAULT_LIST_COLUMNS;
    }

    return valid;
}

async function pickColumnsInteractively(): Promise<MailColumnKey[] | null> {
    const result = await p.multiselect({
        message: "Select columns to display:",
        options: ALL_COLUMN_KEYS.map((key) => ({
            value: key,
            label: MAIL_COLUMNS[key].label,
            hint: DEFAULT_LIST_COLUMNS.includes(key) ? "default" : undefined,
        })),
        initialValues: [...DEFAULT_LIST_COLUMNS],
        required: true,
    });

    if (p.isCancel(result)) {
        p.cancel("Operation cancelled");
        return null;
    }

    return result as MailColumnKey[];
}

function needsRecipients(columns: MailColumnKey[]): boolean {
    return columns.some((col) => RECIPIENT_COLUMNS.includes(col));
}

function formatJsonOutput(messages: MailMessage[], columns: MailColumnKey[]): string {
    const data = messages.map((msg) => {
        const obj: Record<string, string> = {};

        for (const col of columns) {
            obj[col] = MAIL_COLUMNS[col].get(msg);
        }

        return obj;
    });

    return SafeJSON.stringify(data, null, 2);
}

function buildSearchColumns({
    columns,
    withBody,
    semanticActive,
}: {
    columns: MailColumnKey[];
    withBody: boolean;
    semanticActive: boolean;
}): MailColumnKey[] {
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
                let columnsResolved = resolveColumns(options.columns);

                if (columnsResolved === "interactive") {
                    if (!process.stdout.isTTY) {
                        columnsResolved = DEFAULT_LIST_COLUMNS;
                    } else {
                        const picked = await pickColumnsInteractively();

                        if (!picked) {
                            return;
                        }

                        columnsResolved = picked;
                    }
                }

                const baseColumns = columnsResolved;

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
                });

                // Enrich with recipients if any recipient column is selected
                if (needsRecipients(finalColumns)) {
                    const recipientsMap = getRecipients(rowids);

                    for (const msg of messages) {
                        msg.recipients = recipientsMap.get(msg.rowid) ?? [];
                    }
                }

                // Output results
                const format = options.format ?? "table";

                if (format === "table") {
                    console.log("");
                    console.log(formatResultsTable(messages, finalColumns));
                    console.log("");
                    p.log.info(`${messages.length} results. Use 'tools macos mail download <dir>' to export.`);
                } else if (format === "json") {
                    console.log(formatJsonOutput(messages, finalColumns));
                } else if (format === "toon") {
                    const jsonStr = formatJsonOutput(messages, finalColumns);
                    const proc = Bun.spawn(["tools", "json"], {
                        stdin: new Blob([jsonStr]),
                        stdout: "inherit",
                        stderr: "inherit",
                    });
                    await proc.exited;
                } else {
                    p.log.warn(`Unknown format "${format}" — using table`);
                    console.log("");
                    console.log(formatResultsTable(messages, finalColumns));
                    console.log("");
                    p.log.info(`${messages.length} results. Use 'tools macos mail download <dir>' to export.`);
                }

                // Save results to temp file for download command
                const tempResults = SafeJSON.stringify(
                    messages.map((m) => ({
                        ...m,
                        dateSent: m.dateSent.toISOString(),
                        dateReceived: m.dateReceived.toISOString(),
                    }))
                );
                const resultsPath = join(tmpdir(), "macos-mail-last-search.json");
                await Bun.write(resultsPath, tempResults);
                logger.debug(`Saved search results to ${resultsPath}`);
            } catch (error) {
                p.log.error(error instanceof Error ? error.message : String(error));
                process.exit(1);
            } finally {
                cleanup();
            }
        });
}
