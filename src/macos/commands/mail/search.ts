import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexerManager } from "@app/indexer/lib/manager";
import logger from "@app/logger";
import { formatResultsTable } from "@app/macos/lib/mail/format";
import { searchBodies } from "@app/macos/lib/mail/jxa";
import { cleanup, getAttachments, getMessageCount, listReceivers, searchMessages } from "@app/macos/lib/mail/sqlite";
import { rowToMessage } from "@app/macos/lib/mail/transform";
import type { MailMessage, SearchOptions } from "@app/macos/lib/mail/types";
import { Embedder } from "@app/utils/ai";
import { SafeJSON } from "@app/utils/json";
import { cosineDistance } from "@app/utils/math";
import * as p from "@clack/prompts";
import type { Command } from "commander";

const MAIL_INDEX_NAME = "macos-mail";

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
    dumb?: boolean;
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
        .option("--max-distance <n>", "Max semantic distance to include (0-2, default: 1.2)", "1.2")
        .option("--dumb", "Use legacy real-time search (skip index)")
        .action(async (query: string, options: SearchCommandOptions) => {
            try {
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

                if (options.dumb) {
                    await legacySearch(query, options);
                    return;
                }

                const manager = await IndexerManager.load();
                const hasIndex = manager.getIndexNames().includes(MAIL_INDEX_NAME);

                if (hasIndex) {
                    await indexedSearch(manager, query, options);
                } else if (process.stdout.isTTY) {
                    const create = await p.confirm({
                        message: "No mail index found. Create one now? (enables fast semantic search)",
                        initialValue: true,
                    });

                    if (!p.isCancel(create) && create) {
                        p.log.info("Run: tools macos mail index");
                        p.log.info("Falling back to legacy search for now...");
                    }

                    await manager.close();
                    await legacySearch(query, options);
                } else {
                    await manager.close();
                    await legacySearch(query, options);
                }
            } catch (error) {
                p.log.error(error instanceof Error ? error.message : String(error));
                process.exit(1);
            } finally {
                cleanup();
            }
        });
}

async function indexedSearch(manager: IndexerManager, query: string, options: SearchCommandOptions): Promise<void> {
    const spinner = p.spinner();
    const limit = Number.parseInt(options.limit ?? "100", 10);

    try {
        spinner.start("Syncing mail index...");
        const indexer = await manager.getIndex(MAIL_INDEX_NAME);
        const syncStats = await indexer.sync();

        const totalChanges = syncStats.chunksAdded + syncStats.chunksUpdated + syncStats.chunksRemoved;

        if (totalChanges > 0) {
            spinner.stop(`Index synced (+${syncStats.chunksAdded} -${syncStats.chunksRemoved})`);
        } else {
            spinner.stop("Index up to date");
        }

        spinner.start(`Searching index...`);
        const results = await indexer.search(query, {
            mode: "fulltext",
            limit,
        });
        spinner.stop(`Found ${results.length} results`);

        if (results.length === 0) {
            p.log.info("No messages found matching your query.");
            await manager.close();
            return;
        }

        const messages: MailMessage[] = [];

        for (const result of results) {
            const doc = result.doc;
            const content = doc.content ?? "";
            const lines = content.split("\n");

            const subject = extractHeader(lines, "Subject:") ?? "(no subject)";
            const fromLine = extractHeader(lines, "From:") ?? "";
            const dateLine = extractHeader(lines, "Date:") ?? "";
            const mailbox = extractHeader(lines, "Mailbox:") ?? "";

            const fromMatch = fromLine.match(/^(.*?)\s*<(.+?)>$/);
            const senderName = fromMatch?.[1]?.trim() ?? "";
            const senderAddress = fromMatch?.[2] ?? fromLine;

            const dateSent = dateLine ? new Date(dateLine) : new Date(0);

            messages.push({
                rowid: Number(doc.id) || 0,
                subject,
                senderName,
                senderAddress,
                dateSent,
                dateReceived: dateSent,
                mailbox,
                account: "",
                read: true,
                flagged: false,
                size: content.length,
                attachments: [],
                bodyMatchesQuery: true,
                semanticScore: 1 - result.score,
            });
        }

        console.log("");
        console.log(
            formatResultsTable(messages, {
                showBodyMatch: false,
                showSemanticScore: false,
            })
        );
        console.log("");
        p.log.info(`${messages.length} results from index.`);

        const tempResults = SafeJSON.stringify(
            messages.map((m) => ({
                ...m,
                dateSent: m.dateSent.toISOString(),
                dateReceived: m.dateReceived.toISOString(),
            }))
        );
        const resultsPath = join(tmpdir(), "macos-mail-last-search.json");
        await Bun.write(resultsPath, tempResults);
    } finally {
        await manager.close();
    }
}

function extractHeader(lines: string[], prefix: string): string | null {
    for (const line of lines) {
        if (line.startsWith(prefix)) {
            return line.slice(prefix.length).trim();
        }

        if (line === "") {
            break;
        }
    }

    return null;
}

async function legacySearch(query: string, options: SearchCommandOptions): Promise<void> {
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

    const searchOpts: SearchOptions = {
        query,
        withoutBody: options.withoutBody,
        receiver: options.receiver,
        from: parseDate(options.from),
        to: parseDate(options.to),
        mailbox: options.mailbox,
        limit: Number.parseInt(options.limit ?? "100", 10),
    };

    const spinner = p.spinner();
    const totalMessages = getMessageCount();
    spinner.start(`Searching metadata across ${totalMessages.toLocaleString()} messages (SQLite)...`);

    const startSqlite = performance.now();
    const rows = searchMessages(searchOpts);
    const sqliteMs = performance.now() - startSqlite;

    spinner.stop(`Found ${rows.length} metadata matches in ${(sqliteMs / 1000).toFixed(1)}s`);

    if (rows.length === 0) {
        p.log.info("No messages found matching your query.");
        return;
    }

    const rowids = rows.map((r) => r.rowid);
    const attachmentsMap = getAttachments(rowids);
    const messages: MailMessage[] = rows.map((row) => {
        const msg = rowToMessage(row);
        msg.attachments = attachmentsMap.get(row.rowid) ?? [];
        return msg;
    });

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
        spinner.stop(`Body search complete: ${bodyMatchCount} body matches in ${(jxaMs / 1000).toFixed(1)}s`);
    }

    let semanticActive = false;

    if (options.semantic !== false && messages.length > 0) {
        spinner.start(`Ranking ${messages.length} results by semantic similarity...`);
        let embedder: Embedder | null = null;

        try {
            embedder = await Embedder.create();
            const maxDist = Number.parseFloat(options.maxDistance ?? "1.2");

            const queryResult = await embedder.embed(query);
            const texts = messages.map((m) => [m.subject, m.senderName, m.senderAddress].filter(Boolean).join(" "));
            const embeddings = await embedder.embedMany(texts);

            const scored = messages.map((msg, i) => ({
                msg,
                distance: cosineDistance(queryResult.vector, embeddings[i].vector),
            }));

            scored.sort((a, b) => a.distance - b.distance);

            const reordered: MailMessage[] = [];

            for (const { msg, distance } of scored) {
                msg.semanticScore = distance;

                if (distance <= maxDist) {
                    reordered.push(msg);
                }
            }

            for (const { msg, distance } of scored) {
                if (distance > maxDist) {
                    reordered.push(msg);
                }
            }

            messages.length = 0;
            messages.push(...reordered);
            semanticActive = true;

            const relevantCount = scored.filter((s) => s.distance <= maxDist).length;
            spinner.stop(`Semantic ranking complete (${relevantCount} relevant results, ${embedder.dimensions}-dim)`);
        } catch (err) {
            spinner.stop(`Semantic ranking skipped: ${err instanceof Error ? err.message : String(err)}`);
            logger.warn(`Semantic ranking failed, falling back to keyword order: ${err}`);
        } finally {
            embedder?.dispose();
        }
    }

    console.log("");
    console.log(
        formatResultsTable(messages, {
            showBodyMatch: !searchOpts.withoutBody,
            showSemanticScore: semanticActive,
        })
    );
    console.log("");
    p.log.info(`${messages.length} results. Use 'tools macos mail download <dir>' to export.`);

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
}
