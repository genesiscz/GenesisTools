import { ALL_COLUMN_KEYS } from "@app/macos/lib/mail/columns";
import { needsRecipients, outputFormattedResults, resolveColumnsFromFlag } from "@app/macos/lib/mail/command-helpers";
import { MailStorage } from "@app/macos/lib/mail/mail-storage";
import { cleanup, getAttachments, getRecipients, listMessages } from "@app/macos/lib/mail/sqlite";
import { rowToMessage } from "@app/macos/lib/mail/transform";
import type { MailMessage } from "@app/macos/lib/mail/types";
import * as p from "@clack/prompts";
import type { Command } from "commander";

interface ListOptions {
    limit?: string;
    columns?: string | true;
    format?: string;
    sinceLastCheck?: boolean;
}

export function registerListCommand(program: Command): void {
    program
        .command("list [mailbox]")
        .description("List recent emails from a mailbox (default: INBOX)")
        .option("--limit <n>", "Number of emails to show", "20")
        .option("--columns [cols]", `Columns to show (${ALL_COLUMN_KEYS.join(",")})`)
        .option("-f, --format <type>", "Output format: table, json, toon", "table")
        .option("--since-last-check", "Show only emails since last monitor check")
        .action(async (mailbox: string | undefined, options: ListOptions) => {
            try {
                const targetMailbox = mailbox ?? "INBOX";
                const limit = Number.parseInt(options.limit ?? "20", 10);

                const columns = await resolveColumnsFromFlag(options.columns);

                if (!columns) {
                    return;
                }

                const spinner = p.spinner();
                spinner.start(`Fetching latest ${limit} emails from ${targetMailbox}...`);

                let rows = listMessages(targetMailbox, limit);

                if (options.sinceLastCheck) {
                    const mailStorage = new MailStorage();
                    const store = mailStorage.openSeenStore();
                    const maxSeen = store.getMaxSeenRowid();
                    store.close();

                    rows = rows.filter((r) => r.rowid > maxSeen);
                }

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

                await outputFormattedResults({
                    messages,
                    columns,
                    format: options.format ?? "table",
                });
            } catch (error) {
                p.log.error(error instanceof Error ? error.message : String(error));
                process.exit(1);
            } finally {
                cleanup();
            }
        });
}
