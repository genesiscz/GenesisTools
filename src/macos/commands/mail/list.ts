import {
    ALL_COLUMN_KEYS,
    DEFAULT_LIST_COLUMNS,
    MAIL_COLUMNS,
    type MailColumnKey,
    RECIPIENT_COLUMNS,
} from "@app/macos/lib/mail/columns";
import { formatResultsTable } from "@app/macos/lib/mail/format";
import { cleanup, getAttachments, getRecipients, listMessages } from "@app/macos/lib/mail/sqlite";
import { rowToMessage } from "@app/macos/lib/mail/transform";
import { SafeJSON } from "@app/utils/json";
import type { MailMessage } from "@app/macos/lib/mail/types";
import { parseVariadic } from "@app/utils/cli/variadic";
import * as p from "@clack/prompts";
import type { Command } from "commander";

interface ListOptions {
    limit?: string;
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

export function registerListCommand(program: Command): void {
    program
        .command("list [mailbox]")
        .description("List recent emails from a mailbox (default: INBOX)")
        .option("--limit <n>", "Number of emails to show", "20")
        .option("--columns [cols]", "Columns to show (" + ALL_COLUMN_KEYS.join(",") + ")")
        .option("-f, --format <type>", "Output format: table, json, toon", "table")
        .action(async (mailbox: string | undefined, options: ListOptions) => {
            try {
                const targetMailbox = mailbox ?? "INBOX";
                const limit = Number.parseInt(options.limit ?? "20", 10);

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

                const columns = columnsResolved;

                const spinner = p.spinner();
                spinner.start(`Fetching latest ${limit} emails from ${targetMailbox}...`);

                const rows = listMessages(targetMailbox, limit);

                if (rows.length === 0) {
                    spinner.stop(`No messages found in ${targetMailbox}.`);
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

                // Enrich with recipients if any recipient column is selected
                if (needsRecipients(columns)) {
                    const recipientsMap = getRecipients(rowids);

                    for (const msg of messages) {
                        msg.recipients = recipientsMap.get(msg.rowid) ?? [];
                    }
                }

                spinner.stop(`${messages.length} emails from ${targetMailbox}`);

                const format = options.format ?? "table";

                if (format === "table") {
                    console.log("");
                    console.log(formatResultsTable(messages, columns));
                } else if (format === "json") {
                    console.log(formatJsonOutput(messages, columns));
                } else if (format === "toon") {
                    const jsonStr = formatJsonOutput(messages, columns);
                    const proc = Bun.spawn(["tools", "json"], {
                        stdin: new Blob([jsonStr]),
                        stdout: "inherit",
                        stderr: "inherit",
                    });
                    await proc.exited;
                } else {
                    p.log.warn(`Unknown format "${format}" — using table`);
                    console.log("");
                    console.log(formatResultsTable(messages, columns));
                }
            } catch (error) {
                p.log.error(error instanceof Error ? error.message : String(error));
                process.exit(1);
            } finally {
                cleanup();
            }
        });
}
