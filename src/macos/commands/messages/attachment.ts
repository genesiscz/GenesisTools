import { copyFileSync, existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { out } from "@app/logger";
import { formatBytes } from "@app/utils/format";
import { iMessagesDatabase } from "@app/utils/macos/iMessagesDatabase";
import chalk from "chalk";
import type { Command } from "commander";

export function registerMessagesAttachmentCommand(program: Command): void {
    program
        .command("attachment <id>")
        .description("Download or open an iMessage attachment by ID (shown as #ID in show output)")
        .option("--download [dest]", "Copy attachment to destination (default: current directory)")
        .option("--open", "Open attachment with default app")
        .option("--info", "Show attachment metadata only")
        .action(async (idArg: string, opts: { download?: string | true; open?: boolean; info?: boolean }) => {
            const rowid = Number.parseInt(idArg.replace(/^#/, ""), 10);

            if (Number.isNaN(rowid)) {
                out.error("Invalid attachment ID. Use the numeric ID from 'messages show' output (e.g. #9865).");
                process.exit(1);
            }

            const db = new iMessagesDatabase();
            const att = db.getAttachment(rowid);

            if (!att) {
                out.error(`Attachment #${rowid} not found.`);
                process.exit(1);
            }

            if (!att.resolvedPath || !existsSync(att.resolvedPath)) {
                out.error(`Attachment file not found on disk: ${att.filename}`);
                out.error("The file may have been deleted or not yet downloaded from iCloud.");
                process.exit(1);
            }

            // Default to --info if no action specified
            if (!opts.download && !opts.open) {
                opts.info = true;
            }

            if (opts.info) {
                const name = att.transferName ?? basename(att.resolvedPath);
                out.println();
                out.println(`  ${chalk.bold(name)}`);
                out.println(`  Type:  ${att.mimeType ?? "unknown"}`);
                out.println(`  Size:  ${formatBytes(att.totalBytes)}`);
                out.println(`  Path:  ${att.resolvedPath}`);
                out.println(`  ID:    #${att.rowid}`);
                out.println();
                const base = `tools macos messages attachment ${rowid}`;
                out.println(chalk.dim(`  ${base} --download [dest]`));
                out.println(chalk.dim(`  ${base} --open`));
            }

            if (opts.download) {
                const destDir = typeof opts.download === "string" ? opts.download : ".";
                const name = att.transferName ?? basename(att.resolvedPath);
                const destPath = resolve(destDir, name);

                copyFileSync(att.resolvedPath, destPath);
                out.println(`Saved to ${destPath}`);
            }

            if (opts.open) {
                const openProc = Bun.spawn(["open", att.resolvedPath], { stdio: ["ignore", "ignore", "ignore"] });
                await openProc.exited;
            }
        });
}
