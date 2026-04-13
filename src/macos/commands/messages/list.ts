import { iMessagesDatabase } from "@app/utils/macos/iMessagesDatabase";
import { MacContactsDatabase } from "@app/utils/macos/MacContactsDatabase";
import { parseMailDate } from "@app/macos/lib/mail/command-helpers";
import chalk from "chalk";
import type { Command } from "commander";

export function registerMessagesListCommand(program: Command): void {
    program
        .command("list")
        .description("List iMessage conversations")
        .option("--service <type>", "Filter by service: iMessage or SMS")
        .option("--from <date>", "Show chats with messages after this date")
        .option("--to <date>", "Show chats with messages before this date")
        .option("--limit <n>", "Number of chats to show", "20")
        .option("--page <n>", "Page number for pagination")
        .action((opts) => {
            const db = new iMessagesDatabase();
            const contacts = new MacContactsDatabase();

            const chats = db.listChats({
                service: opts.service,
                from: opts.from ? parseMailDate(opts.from) : undefined,
                to: opts.to ? parseMailDate(opts.to, true) : undefined,
                limit: Number.parseInt(opts.limit, 10),
                page: opts.page ? Number.parseInt(opts.page, 10) : undefined,
            });

            if (chats.length === 0) {
                console.log("No conversations found.");
                return;
            }

            // Resolve contact names for all participants
            const allIdentifiers = [...new Set(chats.flatMap((c) => c.participants))];
            const nameMap = contacts.resolveAll(allIdentifiers);

            for (const chat of chats) {
                const participantNames = chat.participants
                    .map((p) => nameMap.get(p) ?? p)
                    .join(", ");

                const displayName = chat.displayName
                    ? chalk.bold(chat.displayName)
                    : chalk.bold(participantNames);

                const lastMsg = chat.lastMessageDate
                    ? chat.lastMessageDate.toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                      })
                    : "—";

                const service = chat.serviceName === "iMessage"
                    ? chalk.blue("iMessage")
                    : chalk.green("SMS");

                const count = chalk.dim(`${chat.messageCount} msgs`);
                const style = chat.style === "group" ? chalk.dim(" [group]") : "";

                console.log(`  ${displayName}${style}  ${service}  ${count}  ${chalk.dim(lastMsg)}`);

                if (chat.displayName && chat.participants.length > 0) {
                    console.log(chalk.dim(`    ${participantNames}`));
                }

                console.log(chalk.dim(`    ID: ${chat.chatIdentifier}`));
                console.log();
            }
        });
}
