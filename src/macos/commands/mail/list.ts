import { formatResultsTable } from "@app/macos/lib/mail/format";
import { cleanup, getAttachments, listMessages } from "@app/macos/lib/mail/sqlite";
import { rowToMessage } from "@app/macos/lib/mail/transform";
import type { MailMessage } from "@app/macos/lib/mail/types";
import * as p from "@clack/prompts";
import type { Command } from "commander";

export function registerListCommand(program: Command): void {
    program
        .command("list [mailbox]")
        .description("List recent emails from a mailbox (default: INBOX)")
        .option("--limit <n>", "Number of emails to show", "20")
        .action(async (mailbox: string | undefined, options: { limit?: string }) => {
            try {
                const targetMailbox = mailbox ?? "INBOX";
                const limit = Number.parseInt(options.limit ?? "20", 10);

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

                spinner.stop(`${messages.length} emails from ${targetMailbox}`);

                console.log("");
                console.log(formatResultsTable(messages));
            } catch (error) {
                p.log.error(error instanceof Error ? error.message : String(error));
                process.exit(1);
            } finally {
                cleanup();
            }
        });
}
