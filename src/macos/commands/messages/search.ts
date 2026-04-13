import { parseMailDate } from "@app/macos/lib/mail/command-helpers";
import { iMessagesDatabase } from "@app/utils/macos/iMessagesDatabase";
import { MacContactsDatabase } from "@app/utils/macos/MacContactsDatabase";
import chalk from "chalk";
import type { Command } from "commander";

export function registerMessagesSearchCommand(program: Command): void {
    program
        .command("search <query>")
        .description("Search iMessage conversations by text content")
        .option("--chat <identifier>", "Scope search to a specific chat (phone number or group ID)")
        .option("--from <date>", "Search messages after this date")
        .option("--to <date>", "Search messages before this date")
        .option("--limit <n>", "Maximum results", "20")
        .option("--page <n>", "Page number for pagination")
        .action((query: string, opts) => {
            const db = new iMessagesDatabase();
            const contacts = new MacContactsDatabase();

            const messages = db.searchMessages(query, {
                chatIdentifier: opts.chat,
                from: opts.from ? parseMailDate(opts.from) : undefined,
                to: opts.to ? parseMailDate(opts.to, true) : undefined,
                limit: Number.parseInt(opts.limit, 10),
                page: opts.page ? Number.parseInt(opts.page, 10) : undefined,
            });

            if (messages.length === 0) {
                console.log("No messages found.");
                return;
            }

            // Collect all sender identifiers for contact resolution
            const senderIds = [...new Set(messages.filter((m) => !m.isFromMe).map((m) => m.sender))];
            const nameMap = contacts.resolveAll(senderIds);

            for (const msg of messages) {
                const senderName = msg.isFromMe ? chalk.cyan("Me") : chalk.bold(nameMap.get(msg.sender) ?? msg.sender);

                const date = msg.date.toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                });

                const chatLabel = chalk.dim(`[${msg.chatIdentifier}]`);
                const text = msg.text ?? chalk.dim("[no text]");

                console.log(`${senderName} ${chalk.dim(date)} ${chatLabel}`);
                console.log(`  ${text}`);
                console.log();
            }

            console.log(chalk.dim(`${messages.length} result(s)`));
        });
}
