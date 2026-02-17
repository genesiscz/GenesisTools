import * as p from "@clack/prompts";
import type { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join, resolve } from "path";
import logger from "@app/logger";
import { getRecipients, cleanup } from "@app/macos/lib/mail/sqlite";
import { getMessageBody, saveAttachment } from "@app/macos/lib/mail/jxa";
import {
    generateEmailMarkdown,
    generateIndexMarkdown,
    generateSlug,
} from "@app/macos/lib/mail/format";
import type { MailMessage } from "@app/macos/lib/mail/types";

/** Load the last search results from temp file */
function loadLastSearchResults(): MailMessage[] | null {
    const path = join(tmpdir(), "macos-mail-last-search.json");
    if (!existsSync(path)) return null;

    try {
        const raw = readFileSync(path, "utf-8");
        const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
        return parsed.map(m => ({
            ...m,
            dateSent: new Date(m.dateSent as string),
            dateReceived: new Date(m.dateReceived as string),
        })) as MailMessage[];
    } catch {
        return null;
    }
}

export function registerDownloadCommand(program: Command): void {
    program
        .command("download <output-dir>")
        .description("Download search results as markdown files")
        .option("--yes", "Skip all confirmations")
        .option("--overwrite", "Overwrite existing index.md")
        .option("--append", "Append to existing index.md")
        .option("--save-attachments", "Download attachments to output-dir/attachments/")
        .action(async (outputDirArg: string, options: {
            yes?: boolean;
            overwrite?: boolean;
            append?: boolean;
            saveAttachments?: boolean;
        }) => {
            try {
                const outputDir = resolve(outputDirArg);
                const isTTY = process.stdout.isTTY;

                // Load last search results
                const messages = loadLastSearchResults();
                if (!messages || messages.length === 0) {
                    p.log.error(
                        "No search results found. Run 'tools macos mail search <query>' first."
                    );
                    process.exit(1);
                }

                p.log.info(`Downloading ${messages.length} emails to ${outputDir}`);

                // Check for existing index.md
                const indexPath = join(outputDir, "index.md");
                if (existsSync(indexPath) && !options.overwrite && !options.append) {
                    if (!isTTY && !options.yes) {
                        p.log.error(
                            `${indexPath} already exists. Use --overwrite, --append, or --yes.`
                        );
                        process.exit(1);
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
                            p.cancel("Download cancelled.");
                            process.exit(0);
                        }

                        if (action === "overwrite") options.overwrite = true;
                        if (action === "append") options.append = true;
                    }
                }

                // Warn on large result sets
                if (messages.length > 100 && !options.yes) {
                    if (!isTTY) {
                        p.log.error(
                            `${messages.length} messages to download. Use --yes to confirm.`
                        );
                        process.exit(1);
                    }

                    const proceed = await p.confirm({
                        message: `Download ${messages.length} emails? This may take a while.`,
                    });
                    if (p.isCancel(proceed) || !proceed) {
                        p.cancel("Download cancelled.");
                        process.exit(0);
                    }
                }

                // Create directories
                const emailsDir = join(outputDir, "emails");
                mkdirSync(emailsDir, { recursive: true });

                if (options.saveAttachments) {
                    mkdirSync(join(outputDir, "attachments"), { recursive: true });
                }

                // Fetch recipients for all messages
                const rowids = messages.map(m => m.rowid);
                const recipientsMap = getRecipients(rowids);

                // Process each email
                const spinner = p.spinner();
                spinner.start("Processing emails...");
                let processed = 0;

                for (const msg of messages) {
                    processed++;
                    spinner.message(
                        `[${processed}/${messages.length}] ${msg.subject.slice(0, 50)}...`
                    );

                    // Attach recipients
                    msg.recipients = recipientsMap.get(msg.rowid) ?? [];

                    // Get body via JXA
                    const body = await getMessageBody(
                        msg.subject,
                        msg.dateSent,
                        msg.senderAddress,
                    );
                    msg.body = body ?? undefined;

                    // Generate markdown
                    const slug = generateSlug(msg);
                    const emailMd = generateEmailMarkdown(msg);
                    writeFileSync(join(emailsDir, `${slug}.md`), emailMd);

                    // Save attachments if requested
                    if (options.saveAttachments && msg.attachments.length > 0) {
                        for (const att of msg.attachments) {
                            const safeAttName = basename(att.name).replace(/[^\w.\-]/g, "_");
                            const attPath = join(outputDir, "attachments", safeAttName);
                            if (!existsSync(attPath)) {
                                await saveAttachment(
                                    msg.subject,
                                    msg.senderAddress,
                                    att.name,
                                    attPath,
                                );
                            } else {
                                // Disambiguate with rowid to avoid silently dropping duplicates
                                const dotIdx = safeAttName.lastIndexOf(".");
                                const ext = dotIdx !== -1 ? safeAttName.slice(dotIdx) : "";
                                const base = safeAttName.slice(0, safeAttName.length - ext.length);
                                const disambiguated = `${base}_${msg.rowid}${ext}`;
                                const altPath = join(outputDir, "attachments", disambiguated);
                                logger.debug(`Attachment collision: ${safeAttName} → saving as ${disambiguated}`);
                                await saveAttachment(msg.subject, msg.senderAddress, att.name, altPath);
                            }
                        }
                    }
                }
                spinner.stop(`Processed ${processed} emails`);

                // Generate index.md
                const indexMd = generateIndexMarkdown(messages);
                if (options.append && existsSync(indexPath)) {
                    const existing = readFileSync(indexPath, "utf-8");
                    writeFileSync(indexPath, existing + "\n\n---\n\n" + indexMd);
                } else {
                    writeFileSync(indexPath, indexMd);
                }

                p.log.success(`Downloaded to ${outputDir}`);
                p.log.info(`  Index: ${indexPath}`);
                p.log.info(`  Emails: ${emailsDir}/ (${messages.length} files)`);
                if (options.saveAttachments) {
                    p.log.info(`  Attachments: ${join(outputDir, "attachments")}/`);
                }

            } catch (error) {
                p.log.error(
                    error instanceof Error ? error.message : String(error)
                );
                process.exit(1);
            } finally {
                cleanup();
            }
        });
}
