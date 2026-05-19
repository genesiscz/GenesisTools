import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { logger } from "@app/logger";
import { EmlxBodyExtractor } from "@app/macos/lib/mail/emlx";
import {
    generateAttachmentName,
    generateEmailMarkdown,
    generateIndexMarkdown,
    generateSlug,
} from "@app/macos/lib/mail/format";
import { saveAttachment } from "@app/macos/lib/mail/jxa";
import { truncateBody } from "@app/macos/lib/mail/transform";
import type { MailMessage } from "@app/macos/lib/mail/types";
import type { MailDatabase } from "@app/utils/macos/MailDatabase";
import * as p from "@clack/prompts";

export interface ExportOptions {
    messages: MailMessage[];
    outputDir: string;
    db?: MailDatabase;
    saveAttachments?: boolean;
    attachmentsOnly?: boolean;
    bodyMaxChars?: number;
    query?: string;
    overwrite?: boolean;
    append?: boolean;
    yes?: boolean;
}

export interface ExportResult {
    outputDir: string;
    emailCount: number;
    emailsDir?: string;
    attachmentsDir?: string;
    indexPath?: string;
}

export async function exportMessages(options: ExportOptions): Promise<ExportResult> {
    const outputDir = resolve(options.outputDir);
    const isTTY = process.stdout.isTTY;
    const messages = options.messages;
    const writeMarkdown = !options.attachmentsOnly;
    const saveAttachments = options.saveAttachments || options.attachmentsOnly === true;

    if (messages.length === 0) {
        p.log.info("No messages to export.");
        return { outputDir, emailCount: 0 };
    }

    logger.debug(
        `[mail/export] outputDir=${outputDir} count=${messages.length} ` +
            `writeMarkdown=${writeMarkdown} saveAttachments=${saveAttachments}`
    );

    const indexPath = join(outputDir, "index.md");
    const writeIndex = writeMarkdown && messages.length > 1;

    if (writeIndex && existsSync(indexPath) && !options.overwrite && !options.append) {
        if (!isTTY && !options.yes) {
            throw new Error(`${indexPath} already exists. Use --overwrite, --append, or --yes.`);
        }

        if (isTTY && !options.yes) {
            const action = await p.select({
                message: `${indexPath} already exists. What to do?`,
                options: [
                    { value: "overwrite", label: "Overwrite" },
                    { value: "append", label: "Append" },
                    { value: "skip", label: "Cancel" },
                ],
            });

            if (p.isCancel(action) || action === "skip") {
                p.cancel("Export cancelled.");
                process.exit(0);
            }

            if (action === "overwrite") {
                options.overwrite = true;
            }

            if (action === "append") {
                options.append = true;
            }
        }
    }

    if (messages.length > 100 && !options.yes) {
        if (!isTTY) {
            throw new Error(`${messages.length} messages to export. Use --yes to confirm.`);
        }

        const proceed = await p.confirm({ message: `Export ${messages.length} emails? This may take a while.` });

        if (p.isCancel(proceed) || !proceed) {
            p.cancel("Export cancelled.");
            process.exit(0);
        }
    }

    const emailsDir = join(outputDir, "emails");

    if (writeMarkdown) {
        mkdirSync(emailsDir, { recursive: true });
    }

    const attachmentsDir = join(outputDir, "attachments");

    if (saveAttachments) {
        mkdirSync(attachmentsDir, { recursive: true });
    }

    if (options.db) {
        const recipientsMap = await options.db.getRecipients(messages.map((m) => m.rowid));

        for (const m of messages) {
            m.recipients = recipientsMap.get(m.rowid) ?? [];
        }
    }

    const emlx = await EmlxBodyExtractor.create();
    const spinner = p.spinner();
    spinner.start("Processing emails...");
    let processed = 0;

    try {
        for (const msg of messages) {
            processed++;
            spinner.message(`[${processed}/${messages.length}] ${msg.subject.slice(0, 50)}...`);

            const body = await emlx.getBody(msg.rowid);
            msg.body = body && options.bodyMaxChars ? truncateBody(body, options.bodyMaxChars) : (body ?? undefined);

            if (writeMarkdown) {
                const slug = generateSlug(msg);
                writeFileSync(join(emailsDir, `${slug}.md`), generateEmailMarkdown(msg));
            }

            if (saveAttachments && msg.attachments.length > 0) {
                for (const att of msg.attachments) {
                    const attPath = join(attachmentsDir, generateAttachmentName(msg, att.name));
                    await saveAttachment(msg.subject, msg.senderAddress ?? "unknown-sender", att.name, attPath);
                }
            }
        }
    } finally {
        emlx.dispose();
        spinner.stop(`Processed ${processed} emails`);
    }

    let finalIndexPath: string | undefined;

    if (writeIndex) {
        const indexMd = generateIndexMarkdown(messages, options.query);

        if (options.append && existsSync(indexPath)) {
            writeFileSync(indexPath, `${readFileSync(indexPath, "utf-8")}\n\n---\n\n${indexMd}`);
        } else {
            writeFileSync(indexPath, indexMd);
        }

        finalIndexPath = indexPath;
    }

    return {
        outputDir,
        emailCount: messages.length,
        emailsDir: writeMarkdown ? emailsDir : undefined,
        attachmentsDir: saveAttachments ? attachmentsDir : undefined,
        indexPath: finalIndexPath,
    };
}

export function parseMailIds(positional: string[], idsFlag: string | undefined): number[] {
    const raw = [...positional, ...(idsFlag ? [idsFlag] : [])];
    const tokens = raw.flatMap((chunk) => chunk.split(/[,\s]+/)).filter((t) => t.length > 0);
    const seen = new Set<number>();
    const result: number[] = [];

    for (const token of tokens) {
        const n = Number.parseInt(token, 10);

        if (Number.isNaN(n) || n <= 0 || String(n) !== token) {
            throw new Error(`Invalid email ID: "${token}". IDs are numeric ROWIDs from search results.`);
        }

        if (!seen.has(n)) {
            seen.add(n);
            result.push(n);
        }
    }

    return result;
}
