import { SessionManager } from "@app/har-analyzer/core/session-manager";
import { formatTable } from "@app/utils/table";
import type { Command } from "commander";

export function registerSessionsCommand(program: Command): void {
    program
        .command("sessions")
        .description("List and manage HAR sessions")
        .option("--clean", "Remove expired sessions")
        .action(async (options: { clean?: boolean }) => {
            const sm = new SessionManager();

            if (options.clean) {
                const deleted = await sm.cleanExpiredSessions();
                console.log(`Cleaned ${deleted} expired session${deleted === 1 ? "" : "s"}.`);
                return;
            }

            const sessions = await sm.listSessions();

            if (sessions.length === 0) {
                console.log("No sessions found. Use `load <file>` to create one.");
                return;
            }

            const lastHash = await sm.getLastSessionHash();

            const headers = ["Hash", "Source", "Entries", "Created"];
            const rows = sessions
                .sort((a, b) => b.createdAt - a.createdAt)
                .map((s) => {
                    const active = s.hash === lastHash ? " *" : "";
                    const created = new Date(s.createdAt).toLocaleString();
                    return [s.hash.slice(0, 8) + active, s.sourceFile, String(s.entryCount), created];
                });

            console.log("Sessions (* = active):");
            console.log(formatTable(rows, headers, { alignRight: [2] }));
        });
}
