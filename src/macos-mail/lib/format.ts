import { formatTable } from "@app/utils/table";
import { formatRelativeTime, formatBytes } from "@app/utils/format";
import type { MailMessage } from "@app/macos-mail/lib/types";
import chalk from "chalk";

/**
 * Format search/list results as a table for terminal output.
 */
export function formatResultsTable(
    messages: MailMessage[],
    options?: { showBodyMatch?: boolean }
): string {
    const headers = ["Date", "From", "Subject", "Attachments"];
    if (options?.showBodyMatch) headers.push("Body");

    const rows = messages.map(msg => {
        const row = [
            formatRelativeTime(msg.dateSent, { compact: true }),
            formatSender(msg),
            msg.subject.slice(0, 60) + (msg.subject.length > 60 ? "..." : ""),
            msg.attachments.length > 0 ? `${msg.attachments.length}` : "",
        ];
        if (options?.showBodyMatch) {
            row.push(msg.bodyMatchesQuery ? chalk.green("yes") : "");
        }
        return row;
    });

    return formatTable(rows, headers, { maxColWidth: 60 });
}

function formatSender(msg: MailMessage): string {
    if (msg.senderName && msg.senderName !== msg.senderAddress) {
        return msg.senderName;
    }
    return msg.senderAddress;
}

/**
 * Generate markdown content for a single email.
 */
export function generateEmailMarkdown(msg: MailMessage): string {
    const lines: string[] = [];

    lines.push(`# ${msg.subject}`);
    lines.push("");
    lines.push("## Metadata");
    lines.push("");
    lines.push("| Field | Value |");
    lines.push("|-------|-------|");
    lines.push(`| From | ${msg.senderName} <${msg.senderAddress}> |`);

    if (msg.recipients && msg.recipients.length > 0) {
        const toRecipients = msg.recipients
            .filter(r => r.type === "to")
            .map(r => r.name ? `${r.name} <${r.address}>` : r.address);
        const ccRecipients = msg.recipients
            .filter(r => r.type === "cc")
            .map(r => r.name ? `${r.name} <${r.address}>` : r.address);

        if (toRecipients.length > 0) {
            lines.push(`| To | ${toRecipients.join(", ")} |`);
        }
        if (ccRecipients.length > 0) {
            lines.push(`| CC | ${ccRecipients.join(", ")} |`);
        }
    }

    lines.push(`| Date | ${msg.dateSent.toISOString()} |`);
    lines.push(`| Mailbox | ${msg.mailbox} |`);
    lines.push(`| Read | ${msg.read ? "Yes" : "No"} |`);
    if (msg.flagged) lines.push(`| Flagged | Yes |`);
    lines.push(`| Size | ${formatBytes(msg.size)} |`);

    if (msg.attachments.length > 0) {
        lines.push("");
        lines.push("## Attachments");
        lines.push("");
        for (const att of msg.attachments) {
            lines.push(`- ${att.name}`);
        }
    }

    if (msg.body) {
        lines.push("");
        lines.push("## Body");
        lines.push("");
        lines.push(msg.body);
    }

    return lines.join("\n");
}

/**
 * Generate the index.md summary table for downloaded emails.
 */
export function generateIndexMarkdown(
    messages: MailMessage[],
    query?: string,
): string {
    const lines: string[] = [];

    lines.push("# Email Export");
    lines.push("");
    if (query) lines.push(`Search query: \`${query}\``);
    lines.push(`Exported: ${new Date().toISOString()}`);
    lines.push(`Total: ${messages.length} emails`);
    lines.push("");
    lines.push("| # | Date | From | Subject | Attachments | File |");
    lines.push("|---|------|------|---------|-------------|------|");

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const slug = generateSlug(msg);
        const date = msg.dateSent.toISOString().slice(0, 10);
        const from = formatSender(msg).replace(/\|/g, "\\|");
        const subject = msg.subject.replace(/\|/g, "\\|").slice(0, 50);
        const attCount = msg.attachments.length > 0 ? `${msg.attachments.length}` : "";
        lines.push(`| ${i + 1} | ${date} | ${from} | ${subject} | ${attCount} | [email](emails/${slug}.md) |`);
    }

    return lines.join("\n");
}

/**
 * Generate a filename-safe slug from a message.
 * Format: YYYY-MM-DD-subject-slug-ROWID.md
 */
export function generateSlug(msg: MailMessage): string {
    const date = msg.dateSent.toISOString().slice(0, 10);
    const subjectSlug = msg.subject
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 50);
    return `${date}-${subjectSlug}-${msg.rowid}`;
}
