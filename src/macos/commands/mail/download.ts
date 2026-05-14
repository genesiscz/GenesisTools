import logger from "@app/logger";
import { exportMessages, parseMailIds } from "@app/macos/lib/mail/export";
import { rowToMessage } from "@app/macos/lib/mail/transform";
import { MailDatabase } from "@app/utils/macos/MailDatabase";
import * as p from "@clack/prompts";
import type { Command } from "commander";

export function registerDownloadCommand(program: Command): void {
    program
        .command("download [ids...]")
        .description("Download specific emails by ID (with attachments) to a directory")
        .option("--ids <ids>", "Comma-delimited email IDs (alternative to positional args)")
        .option("--output-dir <dir>", "Directory to write into")
        .option("--save-attachments", "Download attachments to output-dir/attachments/")
        .option("--attachments-only", "Write only attachments, skip the .md files")
        .option("--body-max-chars <n>", "Max body characters per email")
        .option("--overwrite", "Overwrite existing index.md")
        .option("--append", "Append to existing index.md")
        .option("--yes", "Skip all confirmations")
        .action(
            async (
                idsArg: string[],
                options: {
                    ids?: string;
                    outputDir?: string;
                    saveAttachments?: boolean;
                    attachmentsOnly?: boolean;
                    bodyMaxChars?: string;
                    overwrite?: boolean;
                    append?: boolean;
                    yes?: boolean;
                }
            ) => {
                const db = new MailDatabase();

                try {
                    const ids = parseMailIds(idsArg ?? [], options.ids);

                    if (ids.length === 0) {
                        p.log.error(
                            "No email IDs given. Usage: tools macos mail download <id,id,...> --output-dir <dir>\n" +
                                "To export a whole search instead, use: tools macos mail search-download <query> --output-dir <dir>"
                        );
                        process.exit(1);
                    }

                    if (!options.outputDir) {
                        p.log.error("--output-dir is required.");
                        process.exit(1);
                    }

                    logger.info(`[mail/download] requested ids=${ids.join(",")} outputDir=${options.outputDir}`);

                    const rows = await db.getMessagesByRowids(ids);

                    if (rows.length === 0) {
                        p.log.error(`No emails found for the given IDs: ${ids.join(", ")}`);
                        process.exit(1);
                    }

                    if (rows.length < ids.length) {
                        const found = new Set(rows.map((r) => r.rowid));
                        const missing = ids.filter((id) => !found.has(id));
                        p.log.warn(`Not found: ${missing.join(", ")}`);
                    }

                    const messages = rows.map(rowToMessage);
                    const attachmentsMap = await db.getAttachments(messages.map((m) => m.rowid));

                    for (const m of messages) {
                        m.attachments = attachmentsMap.get(m.rowid) ?? [];
                    }

                    const result = await exportMessages({
                        messages,
                        outputDir: options.outputDir,
                        db,
                        saveAttachments: options.saveAttachments,
                        attachmentsOnly: options.attachmentsOnly,
                        bodyMaxChars: options.bodyMaxChars ? Number.parseInt(options.bodyMaxChars, 10) : undefined,
                        overwrite: options.overwrite,
                        append: options.append,
                        yes: options.yes,
                    });

                    p.log.success(`Downloaded ${result.emailCount} email(s) to ${result.outputDir}`);

                    if (result.emailsDir) {
                        p.log.info(`  Emails: ${result.emailsDir}/`);
                    }

                    if (result.attachmentsDir) {
                        p.log.info(`  Attachments: ${result.attachmentsDir}/`);
                    }
                } catch (error) {
                    p.log.error(error instanceof Error ? error.message : String(error));
                    logger.error(`[mail/download] ${error instanceof Error ? error.stack : String(error)}`);
                    process.exit(1);
                } finally {
                    db.close();
                }
            }
        );
}
