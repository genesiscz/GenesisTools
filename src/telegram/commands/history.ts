import { resolve } from "node:path";
import { parseDate } from "@app/utils/date";
import { formatNumber } from "@app/utils/format";
import { detectLanguage, embedText } from "@app/utils/macos/nlp";
import { formatTable } from "@app/utils/table";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { attachmentDownloader } from "../lib/AttachmentDownloader";
import { conversationSyncService } from "../lib/ConversationSyncService";
import { embedMessages } from "../lib/download";
import { type ExportFormat, formatMessages, VALID_EXPORT_FORMATS } from "../lib/export";
import { queryParser } from "../lib/QueryParser";
import { styleProfileEngine } from "../lib/StyleProfileEngine";
import { displayResults } from "../lib/search";
import { TelegramContact } from "../lib/TelegramContact";
import { TelegramHistoryStore } from "../lib/TelegramHistoryStore";
import { TelegramToolConfig } from "../lib/TelegramToolConfig";
import { TGClient } from "../lib/TGClient";
import type { ContactConfig, QueryRequest, SearchResult } from "../lib/types";
import { EMBEDDING_LANGUAGES } from "../lib/types";

async function ensureClient(config: TelegramToolConfig): Promise<TGClient | null> {
    if (!config.hasValidSession()) {
        p.log.error("Not configured. Run: tools telegram configure");
        return null;
    }

    const client = TGClient.fromConfig(config);
    const authorized = await client.connect();

    if (!authorized) {
        p.log.error("Session expired. Run: tools telegram configure");
        return null;
    }

    return client;
}

function resolveContact(contacts: ContactConfig[], nameOrId: string): ContactConfig | undefined {
    const lower = nameOrId.toLowerCase();

    return contacts.find((contact) => {
        if (contact.userId === nameOrId) {
            return true;
        }

        if (contact.displayName.toLowerCase() === lower) {
            return true;
        }

        if (contact.username?.toLowerCase() === lower) {
            return true;
        }

        if (contact.username?.toLowerCase() === lower.replace(/^@/, "")) {
            return true;
        }

        return false;
    });
}

async function pickContacts(contacts: ContactConfig[]): Promise<ContactConfig[] | null> {
    const selected = await p.select({
        message: "Which contact?",
        options: [
            ...contacts.map((contact) => ({
                value: contact.userId,
                label: contact.displayName,
                hint: contact.username ? `@${contact.username}` : contact.dialogType,
            })),
            { value: "__all__", label: "All configured contacts" },
        ],
    });

    if (p.isCancel(selected)) {
        return null;
    }

    if (selected === "__all__") {
        return contacts;
    }

    const match = contacts.find((contact) => contact.userId === selected);

    if (!match) {
        return null;
    }

    return [match];
}

function registerSyncCommand(history: Command): void {
    const runSync = async (
        contactName: string | undefined,
        opts: {
            since?: string;
            until?: string;
            limit?: number;
            all?: boolean;
        },
        title: string
    ) => {
        p.intro(pc.bgMagenta(pc.white(` ${title} `)));

        const config = new TelegramToolConfig();
        const data = await config.load();

        if (!data) {
            p.log.error("Not configured. Run: tools telegram configure");
            return;
        }

        if (data.contacts.length === 0) {
            p.log.warn("No contacts configured. Run: tools telegram configure");
            return;
        }

        let targetContacts: ContactConfig[] = [];

        if (opts.all) {
            targetContacts = data.contacts;
        } else if (contactName) {
            const match = resolveContact(data.contacts, contactName);

            if (!match) {
                p.log.error(`Contact "${contactName}" not found.`);
                return;
            }

            targetContacts = [match];
        } else {
            const picked = await pickContacts(data.contacts);

            if (!picked) {
                return;
            }

            targetContacts = picked;
        }

        const client = await ensureClient(config);

        if (!client) {
            return;
        }

        const store = new TelegramHistoryStore();
        store.open();

        try {
            const since = opts.since ? parseDate(opts.since) : undefined;
            const until = opts.until ? parseDate(opts.until) : undefined;

            for (const contact of targetContacts) {
                p.log.step(pc.bold(contact.displayName));

                if (since && until) {
                    await conversationSyncService.ensureRange(client, store, contact.userId, since, until, {
                        limit: opts.limit,
                    });
                } else {
                    await conversationSyncService.syncIncremental(client, store, contact.userId, {
                        since,
                        until,
                        limit: opts.limit,
                    });
                }
            }
        } finally {
            store.close();
            await client.disconnect();
        }

        p.outro("Sync complete.");
    };

    history
        .command("sync [contact]")
        .description("Sync conversation history to local SQLite storage")
        .option("--since <date>", "Start date (YYYY-MM-DD)")
        .option("--until <date>", "End date (YYYY-MM-DD)")
        .option("--limit <n>", "Max messages to sync", (value) => Number.parseInt(value, 10))
        .option("--all", "Sync all configured contacts")
        .action(async (contactName: string | undefined, opts) => runSync(contactName, opts, "telegram history sync"));

    history
        .command("download [contact]")
        .description("Alias for sync")
        .option("--since <date>", "Start date (YYYY-MM-DD)")
        .option("--until <date>", "End date (YYYY-MM-DD)")
        .option("--limit <n>", "Max messages to sync", (value) => Number.parseInt(value, 10))
        .option("--all", "Sync all configured contacts")
        .action(async (contactName: string | undefined, opts) =>
            runSync(contactName, opts, "telegram history download")
        );
}

function registerEmbedCommand(history: Command): void {
    history
        .command("embed [contact]")
        .description("Generate semantic embeddings for downloaded messages")
        .option("--all", "Embed all contacts")
        .action(async (contactName: string | undefined, opts: { all?: boolean }) => {
            p.intro(pc.bgMagenta(pc.white(" telegram history embed ")));

            const config = new TelegramToolConfig();
            const data = await config.load();

            if (!data) {
                p.log.error("Not configured. Run: tools telegram configure");
                return;
            }

            if (data.contacts.length === 0) {
                p.log.warn("No contacts configured.");
                return;
            }

            let targetContacts: ContactConfig[];

            if (opts.all) {
                targetContacts = data.contacts;
            } else if (contactName) {
                const found = resolveContact(data.contacts, contactName);

                if (!found) {
                    p.log.error(`Contact "${contactName}" not found.`);
                    return;
                }

                targetContacts = [found];
            } else {
                const selected = await pickContacts(data.contacts);

                if (!selected) {
                    return;
                }

                targetContacts = selected;
            }

            const store = new TelegramHistoryStore();
            store.open();

            try {
                for (const contact of targetContacts) {
                    p.log.step(pc.bold(contact.displayName));
                    const spinner = p.spinner();
                    spinner.start("Generating embeddings...");

                    const { embedded, skipped, unsupportedLangs } = await embedMessages(store, contact.userId);
                    const total = store.getEmbeddedCount(contact.userId);

                    spinner.stop(
                        `${pc.green(String(embedded))} new embeddings, ${skipped} skipped (${formatNumber(total)} total embedded)`
                    );

                    if (unsupportedLangs.size > 0) {
                        const langs = [...unsupportedLangs].join(", ");
                        p.log.warn(
                            `Unsupported semantic languages encountered (${langs}). Supported: ${[...EMBEDDING_LANGUAGES].join(", ")}`
                        );
                    }
                }
            } finally {
                store.close();
            }

            p.outro("Embedding complete.");
        });
}

function registerQueryCommand(history: Command): void {
    history
        .command("query")
        .description("Query messages by date/sender/text with optional auto-fetch")
        .requiredOption("--from <contact>", "Contact display name, username, or id")
        .option("--since <date>", "Start date (YYYY-MM-DD)")
        .option("--until <date>", "End date (YYYY-MM-DD)")
        .option("--sender <kind>", "me|them|any", "any")
        .option("--text <regex>", "Regex filter")
        .option("--limit <n>", "Maximum rows", (value) => Number.parseInt(value, 10))
        .option("--local-only", "Only query local DB")
        .option("--nl <query>", "Natural language helper query")
        .action(
            async (opts: {
                from: string;
                since?: string;
                until?: string;
                sender: "me" | "them" | "any";
                text?: string;
                localOnly?: boolean;
                nl?: string;
                limit?: number;
            }) => {
                p.intro(pc.bgMagenta(pc.white(" telegram history query ")));

                const config = new TelegramToolConfig();
                const data = await config.load();

                if (!data) {
                    p.log.error("Not configured. Run: tools telegram configure");
                    return;
                }

                const parsed = queryParser.parseFromFlags({
                    from: opts.from,
                    since: opts.since,
                    until: opts.until,
                    sender: opts.sender,
                    text: opts.text,
                    localOnly: opts.localOnly,
                    nl: opts.nl,
                    limit: opts.limit,
                } satisfies QueryRequest);
                const contact = resolveContact(data.contacts, parsed.from);

                if (!contact) {
                    p.log.error(`Contact "${parsed.from}" not found.`);
                    return;
                }

                const since = parsed.since ? parseDate(parsed.since) : undefined;
                const until = parsed.until ? parseDate(parsed.until) : undefined;
                const store = new TelegramHistoryStore();
                store.open();

                try {
                    if (!parsed.localOnly && since && until) {
                        const client = await ensureClient(config);

                        if (client) {
                            try {
                                await conversationSyncService.ensureRange(client, store, contact.userId, since, until, {
                                    limit: opts.limit,
                                });
                            } finally {
                                await client.disconnect();
                            }
                        }
                    }

                    const rows = store.queryMessages(contact.userId, {
                        since,
                        until,
                        sender: parsed.sender,
                        textRegex: parsed.text,
                        limit: parsed.limit,
                    });

                    if (rows.length === 0) {
                        p.log.warn("No messages found.");
                        return;
                    }

                    for (const row of rows) {
                        const who = row.is_outgoing ? pc.blue("You") : pc.cyan(contact.displayName);
                        const text = row.is_deleted ? pc.dim("[deleted]") : (row.text ?? row.media_desc ?? "(empty)");
                        const stamp = new Date(row.date_unix * 1000).toISOString();
                        p.log.info(`${pc.dim(stamp)} ${who}: ${text}`);
                    }

                    p.outro(`${rows.length} message(s)`);
                } finally {
                    store.close();
                }
            }
        );
}

function registerAttachmentsCommand(history: Command): void {
    const attachments = history.command("attachments").description("Attachment index and downloads");

    attachments
        .command("list")
        .description("List indexed attachments")
        .requiredOption("--from <contact>", "Contact display name, username, or id")
        .option("--since <date>", "Start date (YYYY-MM-DD)")
        .option("--until <date>", "End date (YYYY-MM-DD)")
        .option("--message-id <id>", "Specific message id", (value) => Number.parseInt(value, 10))
        .option("--limit <n>", "Maximum rows", (value) => Number.parseInt(value, 10))
        .action(async (opts: { from: string; since?: string; until?: string; messageId?: number; limit?: number }) => {
            const config = new TelegramToolConfig();
            const data = await config.load();

            if (!data) {
                p.log.error("Not configured. Run: tools telegram configure");
                return;
            }

            const contact = resolveContact(data.contacts, opts.from);

            if (!contact) {
                p.log.error(`Contact "${opts.from}" not found.`);
                return;
            }

            const store = new TelegramHistoryStore();
            store.open();

            try {
                const rows = store.listAttachments(contact.userId, {
                    since: opts.since ? parseDate(opts.since) : undefined,
                    until: opts.until ? parseDate(opts.until) : undefined,
                    messageId: opts.messageId,
                    limit: opts.limit,
                });

                if (rows.length === 0) {
                    p.log.warn("No attachments found.");
                    return;
                }

                const tableRows = rows.map((row) => [
                    String(row.message_id),
                    String(row.attachment_index),
                    row.kind,
                    row.file_name ?? "—",
                    row.mime_type ?? "—",
                    row.is_downloaded ? "yes" : "no",
                ]);

                console.log(
                    formatTable(tableRows, ["Message ID", "Index", "Kind", "File", "MIME", "Downloaded"], {
                        alignRight: [0, 1],
                    })
                );
            } finally {
                store.close();
            }
        });

    attachments
        .command("fetch")
        .description("Download one attachment by locator")
        .requiredOption("--from <contact>", "Contact display name, username, or id")
        .requiredOption("--message-id <id>", "Message id", (value) => Number.parseInt(value, 10))
        .requiredOption("--attachment-index <n>", "Attachment index", (value) => Number.parseInt(value, 10))
        .option("--output <path>", "Output path")
        .action(async (opts: { from: string; messageId: number; attachmentIndex: number; output?: string }) => {
            const config = new TelegramToolConfig();
            const data = await config.load();

            if (!data) {
                p.log.error("Not configured. Run: tools telegram configure");
                return;
            }

            const contact = resolveContact(data.contacts, opts.from);

            if (!contact) {
                p.log.error(`Contact "${opts.from}" not found.`);
                return;
            }

            const client = await ensureClient(config);

            if (!client) {
                return;
            }

            const store = new TelegramHistoryStore();
            store.open();

            try {
                const result = await attachmentDownloader.downloadByLocator(
                    client,
                    store,
                    {
                        chatId: contact.userId,
                        messageId: opts.messageId,
                        attachmentIndex: opts.attachmentIndex,
                    },
                    {
                        outputPath: opts.output ? resolve(opts.output) : undefined,
                    }
                );

                p.log.success(`Downloaded ${result.bytes} bytes to ${result.outputPath}`);
            } finally {
                store.close();
                await client.disconnect();
            }
        });
}

function registerStyleCommand(history: Command): void {
    const style = history.command("style").description("Style profile utilities");

    style
        .command("derive")
        .description("Derive writing style prompt from style profile rules")
        .requiredOption("--from <contact>", "Contact display name, username, or id")
        .action(async (opts: { from: string }) => {
            const config = new TelegramToolConfig();
            const data = await config.load();

            if (!data) {
                p.log.error("Not configured. Run: tools telegram configure");
                return;
            }

            const contactConfig = resolveContact(data.contacts, opts.from);

            if (!contactConfig) {
                p.log.error(`Contact "${opts.from}" not found.`);
                return;
            }

            const store = new TelegramHistoryStore();
            store.open();

            try {
                const contact = TelegramContact.fromConfig(contactConfig);
                const derived = await styleProfileEngine.deriveStylePrompt(contact, store);

                if (!derived) {
                    p.log.warn("No style profile rules or no matching messages.");
                    return;
                }

                contactConfig.styleProfile = {
                    ...contactConfig.styleProfile,
                    enabled: true,
                    refresh: "incremental",
                    rules: contactConfig.styleProfile?.rules ?? [],
                    previewInWatch: contactConfig.styleProfile?.previewInWatch ?? false,
                    derivedPrompt: derived.prompt,
                    derivedAt: derived.generatedAt,
                };

                await config.save({
                    ...data,
                    contacts: data.contacts.map((contact) =>
                        contact.userId === contactConfig.userId ? contactConfig : contact
                    ),
                    configuredAt: new Date().toISOString(),
                });

                p.log.success(`Derived style prompt from ${derived.sampleCount} sample messages.`);
                p.log.info(derived.prompt);
            } finally {
                store.close();
            }
        });
}

function registerSearchCommand(history: Command): void {
    history
        .command("search <contact> <query>")
        .description("Search conversation history (keyword, semantic, or hybrid)")
        .option("--since <date>", "Start date (YYYY-MM-DD)")
        .option("--until <date>", "End date (YYYY-MM-DD)")
        .option("--semantic", "Use semantic (vector) search instead of keyword")
        .option("--hybrid", "Use hybrid search (keyword + semantic combined)")
        .option("--limit <n>", "Max results (default: 20)", (value) => Number.parseInt(value, 10))
        .action(
            async (
                contactName: string,
                query: string,
                opts: {
                    since?: string;
                    until?: string;
                    semantic?: boolean;
                    hybrid?: boolean;
                    limit?: number;
                }
            ) => {
                p.intro(pc.bgMagenta(pc.white(" telegram history search ")));

                const config = new TelegramToolConfig();
                const data = await config.load();

                if (!data) {
                    p.log.error("Not configured. Run: tools telegram configure");
                    return;
                }

                const contact = resolveContact(data.contacts, contactName);

                if (!contact) {
                    p.log.error(`Contact "${contactName}" not found.`);
                    return;
                }

                const store = new TelegramHistoryStore();
                store.open();

                const searchOpts = {
                    since: opts.since ? parseDate(opts.since) : undefined,
                    until: opts.until ? parseDate(opts.until) : undefined,
                    limit: opts.limit ?? 20,
                };

                let results: SearchResult[];

                try {
                    if (opts.semantic || opts.hybrid) {
                        const spinner = p.spinner();
                        spinner.start("Generating query embedding...");

                        let queryEmbedding: Float32Array;

                        try {
                            const langResult = await detectLanguage(query);
                            const lang = EMBEDDING_LANGUAGES.has(langResult.language) ? langResult.language : "en";
                            const embedResult = await embedText(query, lang, "sentence");
                            queryEmbedding = new Float32Array(embedResult.vector);
                            spinner.stop("Query embedded");
                        } catch (err) {
                            spinner.stop("Embedding failed — falling back to keyword search");
                            p.log.warn(`Could not embed query: ${err}`);
                            results = store.search(contact.userId, query, searchOpts);
                            displayResults(results, contact.displayName);
                            return;
                        }

                        if (opts.hybrid) {
                            results = store.hybridSearch(contact.userId, query, queryEmbedding, searchOpts);
                        } else {
                            results = store.semanticSearch(contact.userId, queryEmbedding, searchOpts);
                        }
                    } else {
                        results = store.search(contact.userId, query, searchOpts);
                    }

                    displayResults(results, contact.displayName);
                    p.outro(`${results.length} result(s) found.`);
                } finally {
                    store.close();
                }
            }
        );
}

function registerExportCommand(history: Command): void {
    history
        .command("export <contact>")
        .description("Export conversation to file (JSON, CSV, or plain text)")
        .requiredOption("--format <fmt>", "Output format: json, csv, or txt")
        .option("--since <date>", "Start date (YYYY-MM-DD)")
        .option("--until <date>", "End date (YYYY-MM-DD)")
        .option("-o, --output <path>", "Output file path (default: stdout)")
        .action(
            async (
                contactName: string,
                opts: {
                    format: string;
                    since?: string;
                    until?: string;
                    output?: string;
                }
            ) => {
                if (!VALID_EXPORT_FORMATS.includes(opts.format as ExportFormat)) {
                    p.log.error(`Invalid format "${opts.format}". Use: ${VALID_EXPORT_FORMATS.join(", ")}`);
                    return;
                }

                const config = new TelegramToolConfig();
                const data = await config.load();

                if (!data) {
                    p.log.error("Not configured. Run: tools telegram configure");
                    return;
                }

                const contact = resolveContact(data.contacts, contactName);

                if (!contact) {
                    p.log.error(`Contact "${contactName}" not found.`);
                    return;
                }

                const store = new TelegramHistoryStore();
                store.open();

                const messages = store.getByDateRange(
                    contact.userId,
                    opts.since ? parseDate(opts.since) : undefined,
                    opts.until ? parseDate(opts.until) : undefined
                );
                store.close();

                if (messages.length === 0) {
                    p.log.warn("No messages found in the specified range.");
                    return;
                }

                const output = formatMessages(messages, opts.format as ExportFormat, contact.displayName);

                if (opts.output) {
                    const outputPath = resolve(opts.output);
                    await Bun.write(outputPath, output);
                    p.log.success(`Exported ${formatNumber(messages.length)} messages to ${outputPath}`);
                } else {
                    console.log(output);
                }
            }
        );
}

function registerStatsCommand(history: Command): void {
    history
        .command("stats [contact]")
        .description("Show statistics about downloaded conversations")
        .action(async (contactName: string | undefined) => {
            p.intro(pc.bgMagenta(pc.white(" telegram history stats ")));

            const config = new TelegramToolConfig();
            const data = await config.load();

            if (!data) {
                p.log.error("Not configured. Run: tools telegram configure");
                return;
            }

            const store = new TelegramHistoryStore();
            store.open();

            try {
                if (contactName) {
                    const contact = resolveContact(data.contacts, contactName);

                    if (!contact) {
                        p.log.error(`Contact "${contactName}" not found.`);
                        return;
                    }

                    const stats = store.getStats(contact.userId);

                    if (stats.length === 0) {
                        p.log.warn(
                            `No messages downloaded for ${contact.displayName}. Run: tools telegram history sync`
                        );
                        return;
                    }

                    const stat = stats[0];
                    p.log.info(
                        `${pc.bold(contact.displayName)}\n` +
                            `  Total messages:    ${formatNumber(stat.totalMessages)}\n` +
                            `  Sent:              ${formatNumber(stat.outgoingMessages)}\n` +
                            `  Received:          ${formatNumber(stat.incomingMessages)}\n` +
                            `  Embedded:          ${formatNumber(stat.embeddedMessages)}\n` +
                            `  First message:     ${stat.firstMessageDate ?? "—"}\n` +
                            `  Last message:      ${stat.lastMessageDate ?? "—"}`
                    );
                } else {
                    const allStats = store.getStats();

                    if (allStats.length === 0) {
                        p.log.warn("No messages downloaded yet. Run: tools telegram history sync");
                        return;
                    }

                    const contactMap = new Map<string, string>();

                    for (const contact of data.contacts) {
                        contactMap.set(contact.userId, contact.displayName);
                    }

                    const rows = allStats.map((stat) => [
                        contactMap.get(stat.chatId) ?? stat.chatId,
                        formatNumber(stat.totalMessages),
                        formatNumber(stat.incomingMessages),
                        formatNumber(stat.outgoingMessages),
                        formatNumber(stat.embeddedMessages),
                        stat.firstMessageDate?.slice(0, 10) ?? "—",
                        stat.lastMessageDate?.slice(0, 10) ?? "—",
                    ]);

                    console.log();
                    console.log(
                        formatTable(rows, ["Contact", "Total", "In", "Out", "Embedded", "First", "Last"], {
                            alignRight: [1, 2, 3, 4],
                        })
                    );
                    console.log();
                }
            } finally {
                store.close();
            }

            p.outro("Done.");
        });
}

export function registerHistoryCommand(program: Command): void {
    const history = program.command("history").description("Download, query, and export conversation history");

    registerSyncCommand(history);
    registerEmbedCommand(history);
    registerQueryCommand(history);
    registerAttachmentsCommand(history);
    registerStyleCommand(history);
    registerSearchCommand(history);
    registerExportCommand(history);
    registerStatsCommand(history);
}
