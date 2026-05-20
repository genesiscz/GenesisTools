import { logger } from "@app/logger";
import { parseMailDate } from "@app/macos/lib/mail/command-helpers";
import { exportMessages } from "@app/macos/lib/mail/export";
import { resolveMailSearchMode, runMailSearch } from "@app/macos/lib/mail/search-runner";
import { MailDatabase } from "@app/utils/macos/MailDatabase";
import * as p from "@clack/prompts";
import type { Command } from "commander";

export function registerSearchDownloadCommand(program: Command): void {
    program
        .command("search-download <query>")
        .description("Re-run a search and write all results to disk as markdown")
        .option("--output-dir <dir>", "Directory to write into")
        .option("--receiver <email>", "Filter by receiver email address")
        .option("--account <id>", "Filter by account (email address or UUID prefix)")
        .option("--from <date>", "Search from date (ISO format)")
        .option("--to <date>", "Search to date (ISO format)")
        .option("--mailbox <name>", "Restrict to a specific mailbox")
        .option("--limit <n>", "Max results", "100")
        .option("--mode <mode>", "Search mode: auto | fulltext | hybrid | vector", "auto")
        .option("--jxa", "Skip the FTS index, use SQLite LIKE search only")
        .option("--without-body", "Skip body search entirely (metadata-only)")
        .option("--yes", "Skip all confirmations")
        .option("--overwrite", "Overwrite existing index.md")
        .option("--append", "Append to existing index.md")
        .option("--save-attachments", "Download attachments to output-dir/attachments/")
        .option("--attachments-only", "Write only attachments, skip the .md files")
        .option("--body-max-chars <n>", "Max body characters per email")
        .action(
            async (
                query: string,
                options: {
                    outputDir?: string;
                    receiver?: string;
                    account?: string;
                    from?: string;
                    to?: string;
                    mailbox?: string;
                    limit?: string;
                    mode?: string;
                    jxa?: boolean;
                    withoutBody?: boolean;
                    yes?: boolean;
                    overwrite?: boolean;
                    append?: boolean;
                    saveAttachments?: boolean;
                    attachmentsOnly?: boolean;
                    bodyMaxChars?: string;
                }
            ) => {
                const db = new MailDatabase();

                try {
                    if (!options.outputDir) {
                        p.log.error("--output-dir is required.");
                        process.exit(1);
                    }

                    const searchOpts = db.resolveMailboxFilter({
                        query,
                        withoutBody: options.withoutBody,
                        receiver: options.receiver,
                        account: options.account,
                        from: parseMailDate(options.from),
                        to: parseMailDate(options.to, true),
                        mailbox: options.mailbox,
                        limit: Number.parseInt(options.limit ?? "100", 10),
                        offset: 0,
                    });
                    const spinner = p.spinner();
                    const outcome = await runMailSearch(query, {
                        searchOpts,
                        mode: resolveMailSearchMode(options.mode),
                        jxa: options.jxa,
                        db,
                        onProgress: spinner,
                    });

                    if (outcome.messages.length === 0) {
                        p.log.info("No messages found matching your query.");
                        return;
                    }

                    const result = await exportMessages({
                        messages: outcome.messages,
                        outputDir: options.outputDir,
                        db,
                        query,
                        saveAttachments: options.saveAttachments,
                        attachmentsOnly: options.attachmentsOnly,
                        bodyMaxChars: options.bodyMaxChars ? Number.parseInt(options.bodyMaxChars, 10) : undefined,
                        yes: options.yes,
                        overwrite: options.overwrite,
                        append: options.append,
                    });

                    p.log.success(`Downloaded ${result.emailCount} emails to ${result.outputDir}`);

                    if (result.indexPath) {
                        p.log.info(`  Index: ${result.indexPath}`);
                    }

                    if (result.attachmentsDir) {
                        p.log.info(`  Attachments: ${result.attachmentsDir}/`);
                    }
                } catch (error) {
                    p.log.error(error instanceof Error ? error.message : String(error));
                    logger.error(`[mail/search-download] ${error instanceof Error ? error.stack : String(error)}`);
                    process.exit(1);
                } finally {
                    db.close();
                }
            }
        );
}
