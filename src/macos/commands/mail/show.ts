import { EmlxBodyExtractor } from "@app/macos/lib/mail/emlx";
import { rowToMessage, truncateBody } from "@app/macos/lib/mail/transform";
import { formatBytes } from "@app/utils/format";
import { SafeJSON } from "@app/utils/json";
import { MailDatabase } from "@app/utils/macos/MailDatabase";
import chalk from "chalk";
import type { Command } from "commander";

type BodyFormat = "text" | "markdown" | "html" | "raw";

interface ShowOptions {
    maxChars?: string;
    json?: boolean;
    bodyFormat?: BodyFormat;
}

function truncateOptionalBody(text: string | undefined, maxChars: number | undefined): string | undefined {
    if (!text) {
        return text;
    }

    return maxChars ? truncateBody(text, maxChars) : text;
}

function selectDisplayBody(
    parts: { text: string; markdown: string; html: string; raw: string } | null,
    format: BodyFormat
): string | undefined {
    if (!parts) {
        return undefined;
    }

    if (format === "markdown") {
        return parts.markdown;
    }

    if (format === "html") {
        return parts.html;
    }

    if (format === "raw") {
        return parts.raw;
    }

    return parts.text;
}

export function registerShowCommand(program: Command): void {
    program
        .command("show <message-id>")
        .description("Show full email details including body")
        .option("--max-chars <n>", "Truncate body to N characters")
        .option("--body-format <format>", "Body format for human output: text, markdown, html, raw", "text")
        .option("--json", "Output as JSON")
        .action(async (messageIdArg: string, options: ShowOptions) => {
            const db = new MailDatabase();

            try {
                const rowid = Number.parseInt(messageIdArg, 10);

                if (Number.isNaN(rowid)) {
                    console.error("Invalid message ID. Use the numeric ROWID from search results.");
                    process.exit(1);
                }

                const row = await db.getMessageById(rowid);

                if (!row) {
                    console.error(`Message ${rowid} not found.`);
                    process.exit(1);
                }

                const msg = rowToMessage(row);

                const recipientsMap = await db.getRecipients([rowid]);
                msg.recipients = recipientsMap.get(rowid) ?? [];
                const attachmentsMap = await db.getAttachments([rowid]);
                msg.attachments = attachmentsMap.get(rowid) ?? [];

                // Get body via EmlxBodyExtractor
                const emlx = await EmlxBodyExtractor.create();
                const bodyParts = await emlx.getBodyParts(rowid);
                emlx.dispose();

                const maxChars = options.maxChars ? Number.parseInt(options.maxChars, 10) : undefined;
                const bodyFormat = options.bodyFormat ?? "text";
                const bodyText = truncateOptionalBody(bodyParts?.text, maxChars);
                const bodyHtml = truncateOptionalBody(bodyParts?.html, maxChars);
                const bodyMarkdown = truncateOptionalBody(bodyParts?.markdown, maxChars);
                const bodyRaw = truncateOptionalBody(bodyParts?.raw, maxChars);
                const displayBody = truncateOptionalBody(selectDisplayBody(bodyParts, bodyFormat), maxChars);
                msg.body = bodyText;
                msg.bodyText = bodyText;
                msg.bodyHtml = bodyHtml;
                msg.bodyMarkdown = bodyMarkdown;
                msg.bodyRaw = bodyRaw;

                if (options.json) {
                    console.log(
                        SafeJSON.stringify(
                            {
                                ...msg,
                                body: bodyText,
                                bodyText,
                                bodyHtml,
                                bodyMarkdown,
                                bodyRaw,
                            },
                            null,
                            2
                        )
                    );
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
                console.log(`Size:     ${formatBytes(msg.size)}`);
                console.log(`ID:       ${rowid}`);
                console.log(`Body:     ${bodyFormat}`);

                if (msg.attachments.length > 0) {
                    console.log(`Attach:   ${msg.attachments.map((a) => a.name).join(", ")}`);
                }

                console.log();

                if (displayBody) {
                    console.log(displayBody);
                } else {
                    console.log(dim("(no body content available)"));
                }

                console.log();
            } catch (error) {
                console.error(error instanceof Error ? error.message : String(error));
                process.exit(1);
            } finally {
                db.close();
            }
        });
}
