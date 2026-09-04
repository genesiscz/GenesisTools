import { parseMailDate } from "@app/macos/lib/mail/command-helpers";
import { parseAttachmentsFilter, saveConversationExport } from "@app/macos/lib/messages/export";
import * as p from "@clack/prompts";
import { isInteractive, suggestEnumFlag } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { iMessagesDatabase } from "@genesiscz/utils/macos/iMessagesDatabase";
import type { Command } from "commander";

export const MESSAGES_SHOW_FORMATS = ["text", "markdown"] as const;

export type MessagesShowFormat = (typeof MESSAGES_SHOW_FORMATS)[number];

function isMessagesShowFormat(value: string): value is MessagesShowFormat {
    return (MESSAGES_SHOW_FORMATS as readonly string[]).includes(value);
}

export type ShowFormatResolution =
    | { status: "ok"; format: MessagesShowFormat }
    | { status: "missing-enum"; help: string };

/**
 * `--format` is a closed set, so an unknown value must stop the command.
 *
 * It used to be cast straight into the union, so `--format json` rendered plain
 * text and, with `--output-dir`, wrote that text into a `.md` file. Commander
 * also carried a `"text"` default, which made an explicit `--format text`
 * indistinguishable from "flag not given" and silently ignored under
 * `--output-dir`. The default now lives here instead.
 */
export function resolveShowFormat(args: { raw: string | true | undefined; outputDir: boolean }): ShowFormatResolution {
    const { raw, outputDir } = args;

    if (raw === undefined) {
        return { status: "ok", format: outputDir ? "markdown" : "text" };
    }

    if (raw !== true && isMessagesShowFormat(raw)) {
        return { status: "ok", format: raw };
    }

    return {
        status: "missing-enum",
        help: suggestEnumFlag("tools macos messages show", "--format", MESSAGES_SHOW_FORMATS, {
            // `tools macos …` execs this script with "macos" already stripped,
            // so only the words after it are in argv.
            subcommand: ["messages", "show"],
            given: raw === true ? undefined : raw,
        }),
    };
}

async function promptShowFormat(): Promise<MessagesShowFormat | null> {
    const picked = await p.select({
        message: "Output format",
        options: [
            { value: "text", label: "text — plain transcript" },
            { value: "markdown", label: "markdown — headings and quotes" },
        ],
    });

    if (p.isCancel(picked)) {
        return null;
    }

    return picked;
}

export function registerMessagesShowCommand(program: Command): void {
    program
        .command("show <identifier>")
        .description("Show a conversation thread (phone number or group ID)")
        .option("--from <date>", "Show messages after this date")
        .option("--to <date>", "Show messages before this date")
        .option("--format [type]", "Output format: text or markdown (default: text; markdown when --output-dir)")
        .option("--no-contacts", "Don't resolve contact names")
        .option("--no-group", "Don't group consecutive messages from the same sender")
        .option("--output-dir <dir>", "Write markdown (and optional attachments/) instead of printing")
        .option("--md-name <file>", "Markdown filename inside --output-dir (default: conversation.md)")
        .option("--save-attachments", "With --output-dir: copy attachments into output-dir/attachments/")
        .option("--attachments-only", "With --output-dir: skip markdown; implies --save-attachments")
        .option(
            "--attachments-filter <pattern>",
            "With --save-attachments: comma/# ID list, or regex against attachment name"
        )
        .action(
            async (
                identifier: string,
                opts: {
                    from?: string;
                    to?: string;
                    format?: string | true;
                    contacts?: boolean;
                    group?: boolean;
                    outputDir?: string;
                    mdName?: string;
                    saveAttachments?: boolean;
                    attachmentsOnly?: boolean;
                    attachmentsFilter?: string;
                }
            ) => {
                // Before the database opens: a bad flag must not surface as a
                // Full Disk Access error from chat.db.
                const resolved = resolveShowFormat({ raw: opts.format, outputDir: Boolean(opts.outputDir) });
                let format: MessagesShowFormat;

                if (resolved.status === "ok") {
                    format = resolved.format;
                } else if (isInteractive()) {
                    const picked = await promptShowFormat();

                    if (picked === null) {
                        return;
                    }

                    format = picked;
                } else {
                    out.error(resolved.help);
                    process.exitCode = 1;
                    return;
                }

                const db = new iMessagesDatabase();
                const from = opts.from ? parseMailDate(opts.from) : undefined;
                const to = opts.to ? parseMailDate(opts.to, true) : undefined;
                const resolveContacts = opts.contacts !== false;
                const groupByTime = opts.group !== false;

                if (opts.outputDir) {
                    if (opts.attachmentsFilter && !opts.saveAttachments && !opts.attachmentsOnly) {
                        out.error("--attachments-filter requires --save-attachments or --attachments-only.");
                        process.exit(1);
                    }

                    try {
                        // Compile it here so a bad pattern is one error line, not a
                        // raw SyntaxError stack out of the middle of the export.
                        parseAttachmentsFilter(opts.attachmentsFilter);
                    } catch (err) {
                        out.error(err instanceof Error ? err.message : String(err));
                        process.exit(1);
                    }

                    const result = saveConversationExport({
                        db,
                        chatIdentifier: identifier,
                        outputDir: opts.outputDir,
                        from,
                        to,
                        filter: opts.attachmentsFilter,
                        saveAttachments: opts.saveAttachments === true || opts.attachmentsOnly === true,
                        attachmentsOnly: opts.attachmentsOnly === true,
                        mdName: opts.mdName,
                        format,
                        resolveContacts,
                        groupByTime,
                    });

                    if (result.markdownPath) {
                        out.println(`Wrote ${result.markdownPath}`);
                    }

                    if (result.attachmentsDir) {
                        out.println(
                            `Attachments: ${result.saved} saved, ${result.missing} missing on disk` +
                                (result.skippedByFilter ? `, ${result.skippedByFilter} skipped by filter` : "") +
                                ` (${result.matched}/${result.attachmentTotal} matched) → ${result.attachmentsDir}`
                        );

                        if (result.missingIds.length > 0 && result.missingIds.length <= 20) {
                            out.println(
                                `Missing #IDs (iCloud not downloaded?): ${result.missingIds.map((id) => `#${id}`).join(", ")}`
                            );
                        } else if (result.missingIds.length > 20) {
                            out.println(
                                `Missing #IDs (first 20): ${result.missingIds
                                    .slice(0, 20)
                                    .map((id) => `#${id}`)
                                    .join(", ")} …`
                            );
                        }
                    }

                    return;
                }

                if (opts.saveAttachments || opts.attachmentsOnly || opts.attachmentsFilter) {
                    out.error("--save-attachments / --attachments-only / --attachments-filter require --output-dir.");
                    process.exit(1);
                }

                const output = db.exportConversation(identifier, {
                    from,
                    to,
                    format,
                    resolveContacts,
                    groupByTime,
                });

                out.println(output);
            }
        );
}
