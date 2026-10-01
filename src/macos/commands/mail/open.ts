import { openMailMessage } from "@app/macos/lib/mail/open";
import { suggestCommand } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function registerOpenCommand(program: Command): void {
    program
        .command("open [rowid]")
        .description("Open a message in Mail, by the ROWID from search results or by its Message-ID")
        .option("-m, --message-id <id>", "The RFC Message-ID, with or without angle brackets")
        .action(async (rowidArg: string | undefined, options: { messageId?: string }) => {
            const rowid = rowidArg === undefined ? Number.NaN : Number(rowidArg);

            if (options.messageId === undefined && !Number.isInteger(rowid)) {
                out.error("Pass a numeric ROWID or --message-id.");
                out.info(suggestCommand("tools macos mail", { replaceCommand: ["open", "<rowid>"] }));
                process.exitCode = 1;
                return;
            }

            try {
                const opened = await openMailMessage(
                    options.messageId === undefined ? { rowid } : { messageId: options.messageId }
                );
                out.println(`Opened ${opened.messageId} in Mail`);
            } catch (error) {
                out.error(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}
