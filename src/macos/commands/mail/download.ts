import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import logger from "@app/logger";
import { parseMailDate } from "@app/macos/lib/mail/command-helpers";
import { EmlxBodyExtractor } from "@app/macos/lib/mail/emlx";
import { generateEmailMarkdown, generateIndexMarkdown, generateSlug } from "@app/macos/lib/mail/format";
import { saveAttachment } from "@app/macos/lib/mail/jxa";
import { MailStorage } from "@app/macos/lib/mail/mail-storage";
import { truncateBody } from "@app/macos/lib/mail/transform";
import { MailDatabase } from "@app/utils/macos/MailDatabase";
import * as p from "@clack/prompts";
import type { Command } from "commander";

export function registerDownloadCommand(program: Command): void {
    program
        .command("download <output-dir>")
        .description("Download search results as markdown files")
        .option("--yes", "Skip all confirmations")
        .option("--overwrite", "Overwrite existing index.md")
        .option("--append", "Append to existing index.md")
        .option("--save-attachments", "Download attachments to output-dir/attachments/")
        .option("--from <date>", "Only download emails sent after date (ISO format)")
        .option("--to <date>", "Only download emails sent before date (ISO format)")
        .option("--body-max-chars <n>", "Max body characters per email")
        .action(
            async (
                outputDirArg: string,
                options: {
                    yes?: boolean;
                    overwrite?: boolean;
                    append?: boolean;
                    saveAttachments?: boolean;
                    from?: string;
                    to?: string;
                    bodyMaxChars?: string;
                }
            ) => {
                const db = new MailDatabase();

                try {
                    const outputDir = resolve(outputDirArg);
                    const isTTY = process.stdout.isTTY;

                    // Load last search results
                    const mailStorage = new MailStorage();
                    const messages = mailStorage.loadSearchResults();

                    if (!messages || messages.length === 0) {
                        p.log.error("No search results found. Run 'tools macos mail search <query>' first.");
                        process.exit(1);
                    }

                    p.log.info(`Downloading ${messages.length} emails to ${outputDir}`);

                    // Check for existing index.md
                    const indexPath = join(outputDir, "index.md");
                    if (existsSync(indexPath) && !options.overwrite && !options.append) {
                        if (!isTTY && !options.yes) {
                            p.log.error(`${indexPath} already exists. Use --overwrite, --append, or --yes.`);
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

                            if (action === "overwrite") {
                                options.overwrite = true;
                            }
                            if (action === "append") {
                                options.append = true;
                            }
                        }
                    }

                    // Warn on large result sets
                    if (messages.length > 100 && !options.yes) {
                        if (!isTTY) {
                            p.log.error(`${messages.length} messages to download. Use --yes to confirm.`);
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

                    // Apply date filters
                    let filteredMessages = messages;

                    const fromDate = parseMailDate(options.from);

                    if (fromDate) {
                        filteredMessages = filteredMessages.filter((m) => m.dateSent >= fromDate);
                    }

                    const toDate = parseMailDate(options.to, true);

                    if (toDate) {
                        filteredMessages = filteredMessages.filter((m) => m.dateSent <= toDate);
                    }

                    if (filteredMessages.length === 0) {
                        p.log.info("No messages match the date filter.");
                        return;
                    }

                    if (filteredMessages.length !== messages.length) {
                        p.log.info(
                            `Filtered to ${filteredMessages.length} of ${messages.length} messages by date range`
                        );
                    }

                    // Fetch recipients for all messages
                    const rowids = filteredMessages.map((m) => m.rowid);
                    const recipientsMap = db.getRecipients(rowids);

                    // Create EmlxBodyExtractor (fast: ~42 msg/s L2, instant L1)
                    const emlx = await EmlxBodyExtractor.create();
                    const bodyMaxChars = options.bodyMaxChars ? Number.parseInt(options.bodyMaxChars, 10) : undefined;

                    // Process each email
                    const spinner = p.spinner();
                    spinner.start("Processing emails...");
                    let processed = 0;

                    for (const msg of filteredMessages) {
                        processed++;
                        spinner.message(`[${processed}/${filteredMessages.length}] ${msg.subject.slice(0, 50)}...`);

                        // Attach recipients
                        msg.recipients = recipientsMap.get(msg.rowid) ?? [];

                        const body = await emlx.getBody(msg.rowid);
                        msg.body = body && bodyMaxChars ? truncateBody(body, bodyMaxChars) : (body ?? undefined);

                        // Generate markdown
                        const slug = generateSlug(msg);
                        const emailMd = generateEmailMarkdown(msg);
                        writeFileSync(join(emailsDir, `${slug}.md`), emailMd);

                        // Save attachments if requested
                        if (options.saveAttachments && msg.attachments.length > 0) {
                            for (const att of msg.attachments) {
                                const safeAttName = basename(att.name).replace(/[^\w.-]/g, "_");
                                const attPath = join(outputDir, "attachments", safeAttName);
                                if (!existsSync(attPath)) {
                                    await saveAttachment(msg.subject, msg.senderAddress, att.name, attPath);
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
                    emlx.dispose();
                    spinner.stop(`Processed ${processed} emails`);

                    // Generate index.md
                    const indexMd = generateIndexMarkdown(filteredMessages);
                    if (options.append && existsSync(indexPath)) {
                        const existing = readFileSync(indexPath, "utf-8");
                        writeFileSync(indexPath, `${existing}\n\n---\n\n${indexMd}`);
                    } else {
                        writeFileSync(indexPath, indexMd);
                    }

                    p.log.success(`Downloaded to ${outputDir}`);
                    p.log.info(`  Index: ${indexPath}`);
                    p.log.info(`  Emails: ${emailsDir}/ (${filteredMessages.length} files)`);
                    if (options.saveAttachments) {
                        p.log.info(`  Attachments: ${join(outputDir, "attachments")}/`);
                    }
                } catch (error) {
                    p.log.error(error instanceof Error ? error.message : String(error));
                    process.exit(1);
                } finally {
                    db.close();
                }
            }
        );
}
