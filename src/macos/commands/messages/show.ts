import { iMessagesDatabase } from "@app/utils/macos/iMessagesDatabase";
import { parseMailDate } from "@app/macos/lib/mail/command-helpers";
import type { Command } from "commander";

export function registerMessagesShowCommand(program: Command): void {
    program
        .command("show <identifier>")
        .description("Show a conversation thread (phone number or group ID)")
        .option("--from <date>", "Show messages after this date")
        .option("--to <date>", "Show messages before this date")
        .option("--format <type>", "Output format: text or markdown", "text")
        .option("--no-contacts", "Don't resolve contact names")
        .option("--no-group", "Don't group consecutive messages from the same sender")
        .action((identifier: string, opts) => {
            const db = new iMessagesDatabase();

            const output = db.exportConversation(identifier, {
                from: opts.from ? parseMailDate(opts.from) : undefined,
                to: opts.to ? parseMailDate(opts.to, true) : undefined,
                format: opts.format,
                resolveContacts: opts.contacts !== false,
                groupByTime: opts.group !== false,
            });

            console.log(output);
        });
}
