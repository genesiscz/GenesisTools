import { out } from "@app/logger";
import { isStructuredFormat, printStructured } from "@app/macos/lib/mail/command-helpers";
import { isQuietOutput } from "@app/utils/cli";
import { MailDatabase } from "@app/utils/macos/MailDatabase";
import { formatTable } from "@app/utils/table";
import * as p from "@clack/prompts";
import type { Command } from "commander";

export function registerAccountsCommand(program: Command): void {
    program
        .command("accounts")
        .description("List configured mail accounts")
        .option("-f, --format <type>", "Output format: table, json, toon", "table")
        .action(async (options: { format?: string }) => {
            const db = new MailDatabase();
            const format = options.format ?? "table";

            try {
                const accounts = await db.listAccounts();

                if (isStructuredFormat(format)) {
                    await printStructured(accounts, format);
                    return;
                }

                if (accounts.length === 0) {
                    out.println("No mail accounts found.");
                    return;
                }

                const headers = ["Email", "Protocol", "Mailboxes", "Messages", "UUID"];
                const rows = accounts.map((a) => [
                    a.email,
                    a.protocol.toUpperCase(),
                    String(a.mailboxCount),
                    a.messageCount.toLocaleString(),
                    `${a.uuid.slice(0, 8)}...`,
                ]);

                out.println();
                out.println(formatTable(rows, headers, { alignRight: [2, 3] }));
                out.println();

                const unknownCount = accounts.filter((a) => a.email === "unknown").length;
                if (unknownCount > 0 && !isQuietOutput()) {
                    p.log.info(
                        `${unknownCount} account(s) have no sent mail and no type=0 recipient data — verify in Mail.app → Settings → Accounts.`
                    );
                }
            } finally {
                db.close();
            }
        });
}
