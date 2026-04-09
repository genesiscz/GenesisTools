import { cleanup, listAccounts } from "@app/macos/lib/mail/sqlite";
import { formatTable } from "@app/utils/table";
import type { Command } from "commander";

export function registerAccountsCommand(program: Command): void {
    program
        .command("accounts")
        .description("List configured mail accounts")
        .action(() => {
            try {
                const accounts = listAccounts();

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
            } finally {
                cleanup();
            }
        });
}
