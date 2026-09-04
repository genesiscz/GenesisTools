import { ALL_COLUMN_KEYS } from "@app/macos/lib/mail/columns";
import {
    enrichWithBodies,
    isStructuredFormat,
    needsRecipients,
    outputFormattedResults,
    resolveColumnsFromFlag,
    resolveListFilters,
} from "@app/macos/lib/mail/command-helpers";
import { MailStorage } from "@app/macos/lib/mail/mail-storage";
import { rowToMessage } from "@app/macos/lib/mail/transform";
import * as p from "@clack/prompts";
import { isQuietOutput } from "@genesiscz/utils/cli/output-mode";
import { createQuietSpinner } from "@genesiscz/utils/cli/quiet-spinner";
import { MailDatabase } from "@genesiscz/utils/macos/MailDatabase";
import type { MailMessage } from "@genesiscz/utils/macos/mail/types";
import type { Command } from "commander";

interface ListOptions {
    limit?: string;
    offset?: string;
    columns?: string | true;
    format?: string;
    sinceLastCheck?: boolean;
    from?: string;
    to?: string;
    sender?: string;
    receiver?: string;
    account?: string;
    unread?: boolean;
    read?: boolean;
    flagged?: boolean;
    hasAttachment?: boolean;
}

export function registerListCommand(program: Command): void {
    program
        .command("list [mailbox]")
        .description("List recent emails from a mailbox (default: INBOX, which means every account's inbox)")
        .option("--limit <n>", "Max emails to return after filters (default 20)", "20")
        .option("--offset <n>", "Skip the first N matching emails", "0")
        .option("--from <date>", "Only emails sent at or after this instant (14h, 7d, YYYY-MM-DD, ISO, now)")
        .option("--to <date>", "Only emails sent at or before this instant (date-only is end of that local day)")
        .option("--sender <text>", "Filter by sender address or name (substring)")
        .option("--receiver <email>", "Filter by recipient address (substring)")
        .option("--account <id>", "Filter by account (email address as shown by `accounts`, or UUID prefix)")
        .option("--unread", "Only unread emails")
        .option("--read", "Only read emails")
        .option("--flagged", "Only flagged emails")
        .option("--has-attachment", "Only emails with at least one attachment")
        .option("--columns [cols]", `Columns to show (${ALL_COLUMN_KEYS.join(",")})`)
        .option("-f, --format <type>", "Output format: table, json, toon", "table")
        .option("--since-last-check", "Show only emails since last monitor check")
        .action(async (mailbox: string | undefined, options: ListOptions) => {
            const db = new MailDatabase();

            try {
                const targetMailbox = mailbox ?? "INBOX";
                const { filters, limit, offset } = resolveListFilters(options);

                if (options.sinceLastCheck) {
                    const mailStorage = new MailStorage();
                    const store = mailStorage.openSeenStore();
                    filters.minRowid = store.getMaxSeenRowid();
                    store.close();
                }

                const columns = await resolveColumnsFromFlag(options.columns);

                if (!columns) {
                    return;
                }

                const format = options.format ?? "table";
                // Clack renders on stdout — a real spinner would corrupt
                // structured/piped output.
                const spinner = isQuietOutput(format) ? createQuietSpinner() : p.spinner();
                spinner.start(`Fetching latest ${limit} emails from ${targetMailbox}...`);

                const rows = await db.listMessages(targetMailbox, limit, { ...filters, offset });

                if (rows.length === 0) {
                    spinner.stop(`No messages found in ${targetMailbox}.`);

                    if (isStructuredFormat(format)) {
                        await outputFormattedResults({ messages: [], columns, format });
                    }

                    return;
                }

                const rowids = rows.map((r) => r.rowid);
                const attachmentsMap = await db.getAttachments(rowids);
                const messages: MailMessage[] = rows.map((row) => {
                    const msg = rowToMessage(row);
                    msg.attachments = attachmentsMap.get(row.rowid) ?? [];
                    return msg;
                });

                await enrichWithBodies(messages, columns);

                // Enrich with recipients if any recipient column is selected
                if (needsRecipients(columns)) {
                    const recipientsMap = await db.getRecipients(rowids);

                    for (const msg of messages) {
                        msg.recipients = recipientsMap.get(msg.rowid) ?? [];
                    }
                }

                spinner.stop(`${messages.length} emails from ${targetMailbox}`);

                await outputFormattedResults({
                    messages,
                    columns,
                    format,
                });
            } catch (error) {
                p.log.error(error instanceof Error ? error.message : String(error));
                process.exit(1);
            } finally {
                db.close();
            }
        });
}
