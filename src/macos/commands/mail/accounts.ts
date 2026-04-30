import { isQuietOutput } from "@app/utils/cli";
import { MailDatabase } from "@app/utils/macos/MailDatabase";
import { formatTable } from "@app/utils/table";
import * as p from "@clack/prompts";
import type { Command } from "commander";

export function registerAccountsCommand(program: Command): void {
    program
        .command("accounts")
        .description("List configured mail accounts")
        .action(async () => {
            const db = new MailDatabase();

            try {
                const accounts = await db.listAccounts();

                if (accounts.length === 0) {
                    console.log("No mail accounts found.");
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

                console.log();
                console.log(formatTable(rows, headers, { alignRight: [2, 3] }));
                console.log();

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
