import { isInteractive, suggestCommand } from "@app/utils/cli/executor";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import { TaskSessionStore } from "../lib/session-store";
import { statusError, statusLine } from "../lib/stderr-status";

export function registerCleanCommand(program: Command): void {
    program
        .command("clean")
        .description("Remove session log files")
        .option("--all", "Remove all sessions")
        .action(async (opts: { all?: boolean }) => {
            const globalOpts = program.opts<{ session?: string }>();
            const store = new TaskSessionStore();

            if (opts.all) {
                const names = await store.listSessionNames();

                if (names.length === 0) {
                    statusLine("No sessions to clean.");
                    return;
                }

                if (isInteractive()) {
                    const confirmed = await p.confirm({
                        message: `Delete all ${names.length} task sessions?`,
                    });

                    if (p.isCancel(confirmed) || !confirmed) {
                        statusLine("Cancelled.");
                        return;
                    }
                }

                for (const name of names) {
                    await store.deleteSession(name);
                }

                statusLine(`Removed ${names.length} session(s).`);
                return;
            }

            let session = globalOpts.session;
            if (!session) {
                if (!isInteractive()) {
                    statusError("--session or --all required in non-interactive mode.");
                    process.stderr.write(
                        `${suggestCommand("tools task", { add: ["clean", "--session", "my-session"] })}\n`
                    );
                    process.exit(1);
                }

                const names = await store.listSessionNames();
                if (names.length === 0) {
                    statusLine("No sessions to clean.");
                    return;
                }

                const picked = await p.select({
                    message: "Select session to clean",
                    options: names.map((n) => ({ value: n, label: n })),
                });

                if (p.isCancel(picked)) {
                    statusLine("Cancelled.");
                    return;
                }

                session = picked;
            } else {
                session = await store.resolveSession(session);
            }

            await store.deleteSession(session);
            statusLine(`Removed session: ${session}`);
        });
}
