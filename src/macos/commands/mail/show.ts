import { EmlxBodyExtractor } from "@app/macos/lib/mail/emlx";
import { cleanup, getAttachments, getMessageById, getRecipients } from "@app/macos/lib/mail/sqlite";
import { rowToMessage, truncateBody } from "@app/macos/lib/mail/transform";
import { SafeJSON } from "@app/utils/json";
import chalk from "chalk";
import type { Command } from "commander";

export function registerShowCommand(program: Command): void {
    program
        .command("show <message-id>")
        .description("Show full email details including body")
        .option("--body-max-chars <n>", "Max body characters to display", "5000")
        .option("--raw", "Show raw body (no truncation)")
        .option("--json", "Output as JSON")
        .action(async (messageIdArg: string, options: { bodyMaxChars?: string; raw?: boolean; json?: boolean }) => {
            try {
                const rowid = Number.parseInt(messageIdArg, 10);

                if (Number.isNaN(rowid)) {
                    console.error("Invalid message ID. Use the numeric ROWID from search results.");
                    process.exit(1);
                }

                const row = getMessageById(rowid);

                if (!row) {
                    console.error(`Message ${rowid} not found.`);
                    process.exit(1);
                }

                const msg = rowToMessage(row);

                // Enrich with recipients and attachments
                const recipientsMap = getRecipients([rowid]);
                msg.recipients = recipientsMap.get(rowid) ?? [];
                const attachmentsMap = getAttachments([rowid]);
                msg.attachments = attachmentsMap.get(rowid) ?? [];

                // Get body via EmlxBodyExtractor
                const emlx = await EmlxBodyExtractor.create();
                const body = await emlx.getBody(rowid);
                emlx.dispose();

                const maxChars = options.raw ? Infinity : Number.parseInt(options.bodyMaxChars ?? "5000", 10);
                const truncatedBody = body ? truncateBody(body, maxChars) : null;

                if (options.json) {
                    console.log(SafeJSON.stringify({ ...msg, body: truncatedBody }, null, 2));
                    return;
                }

                // Pretty print
                const isTTY = process.stdout.isTTY;
                const dim = isTTY ? chalk.dim : (s: string) => s;
                const bold = isTTY ? chalk.bold : (s: string) => s;

                console.log();
                console.log(bold(msg.subject));
                console.log(dim("─".repeat(Math.min(msg.subject.length, 80))));
                console.log(`From:     ${msg.senderName} <${msg.senderAddress}>`);

                const toRecipients = msg.recipients?.filter((r) => r.type === "to") ?? [];

                if (toRecipients.length > 0) {
                    console.log(
                        `To:       ${toRecipients.map((r) => (r.name ? `${r.name} <${r.address}>` : r.address)).join(", ")}`
                    );
                }

                const ccRecipients = msg.recipients?.filter((r) => r.type === "cc") ?? [];

                if (ccRecipients.length > 0) {
                    console.log(
                        `CC:       ${ccRecipients.map((r) => (r.name ? `${r.name} <${r.address}>` : r.address)).join(", ")}`
                    );
                }

                console.log(`Date:     ${msg.dateSent.toLocaleString()}`);
                console.log(`Mailbox:  ${msg.mailbox}`);
                console.log(`Size:     ${(msg.size / 1024).toFixed(1)} KB`);
                console.log(`ID:       ${rowid}`);

                if (msg.attachments.length > 0) {
                    console.log(`Attach:   ${msg.attachments.map((a) => a.name).join(", ")}`);
                }

                console.log();

                if (truncatedBody) {
                    console.log(truncatedBody);
                } else {
                    console.log(dim("(no body content available)"));
                }

                console.log();
            } catch (error) {
                console.error(error instanceof Error ? error.message : String(error));
                process.exit(1);
            } finally {
                cleanup();
            }
        });
}
