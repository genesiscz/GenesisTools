import { out } from "@app/logger";
import { isStructuredFormat, printStructured } from "@app/macos/lib/mail/command-helpers";
import { EmlxBodyExtractor } from "@app/macos/lib/mail/emlx";
import { rowToMessage, truncateBody } from "@app/macos/lib/mail/transform";
import { printLn } from "@app/utils/cli";
import { formatBytes } from "@app/utils/format";
import { MailDatabase } from "@app/utils/macos/MailDatabase";
import chalk from "chalk";
import type { Command } from "commander";

type BodyFormat = "text" | "markdown" | "html" | "raw";

interface ShowOptions {
    maxChars?: string;
    json?: boolean;
    format?: string;
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
        .option("-f, --format <type>", "Output format: text, json, toon", "text")
        .option("--json", "Output as JSON (alias for --format json)")
        .action(async (messageIdArg: string, options: ShowOptions) => {
            const db = new MailDatabase();

            try {
                const rowid = Number.parseInt(messageIdArg, 10);

                if (Number.isNaN(rowid)) {
                    out.error("Invalid message ID. Use the numeric ROWID from search results.");
                    process.exit(1);
                }

                const row = await db.getMessageById(rowid);

                if (!row) {
                    out.error(`Message ${rowid} not found.`);
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

                const format = options.json ? "json" : (options.format ?? "text");

                if (isStructuredFormat(format)) {
                    await printStructured(
                        {
                            ...msg,
                            body: bodyText,
                            bodyText,
                            bodyHtml,
                            bodyMarkdown,
                            bodyRaw,
                        },
                        format
                    );
                    return;
                }

                const isTTY = process.stdout.isTTY;
                const dim = isTTY ? chalk.dim : (s: string) => s;
                const bold = isTTY ? chalk.bold : (s: string) => s;
                // Renamed from `out` to avoid shadowing the `@app/logger` `out`
                // import added by the console-sweep codemod (would shadow the
                // imported writer used in the catch block below).
                const lines: string[] = [];

                lines.push("");
                lines.push(bold(msg.subject));
                lines.push(dim("─".repeat(Math.min(msg.subject.length, 80))));
                lines.push(`From:     ${msg.senderName ?? ""} <${msg.senderAddress ?? "(no sender)"}>`);

                const toRecipients = msg.recipients?.filter((r) => r.type === "to") ?? [];

                if (toRecipients.length > 0) {
                    lines.push(
                        `To:       ${toRecipients.map((r) => (r.name ? `${r.name} <${r.address}>` : r.address)).join(", ")}`
                    );
                }

                const ccRecipients = msg.recipients?.filter((r) => r.type === "cc") ?? [];

                if (ccRecipients.length > 0) {
                    lines.push(
                        `CC:       ${ccRecipients.map((r) => (r.name ? `${r.name} <${r.address}>` : r.address)).join(", ")}`
                    );
                }

                lines.push(`Date:     ${msg.dateSent.toLocaleString()}`);
                lines.push(`Mailbox:  ${msg.mailbox}`);
                lines.push(`Size:     ${formatBytes(msg.size)}`);
                lines.push(`ID:       ${rowid}`);
                lines.push(`Body:     ${bodyFormat}`);

                if (msg.attachments.length > 0) {
                    lines.push(`Attach:   ${msg.attachments.map((a) => a.name).join(", ")}`);
                }

                lines.push("");
                lines.push(displayBody ? displayBody : dim("(no body content available)"));
                lines.push("");

                await printLn(lines);
            } catch (error) {
                out.error(error instanceof Error ? error.message : String(error));
                process.exit(1);
            } finally {
                db.close();
            }
        });
}
