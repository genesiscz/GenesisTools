import { out } from "@app/logger";
import { isInteractive, suggestCommand } from "@app/utils/cli/executor";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import { TaskSessionStore } from "@app/task/lib/session-store";

export function registerCleanCommand(program: Command): void {
    program
        .command("clean")
        .description("Remove session log files (--session <name> for one, --all for all)")
        .option("--session <name>", "Remove a single session by name (fuzzy-matched)")
        .option("--all", "Remove all sessions")
        .action(async (opts: { all?: boolean; session?: string }) => {
            const globalOpts = program.opts<{ session?: string }>();
            const store = new TaskSessionStore();

            if (opts.all) {
                const names = await store.listSessionNames();

                if (names.length === 0) {
                    out.printlnErr("No sessions to clean.");
                    return;
                }

                if (isInteractive()) {
                    const confirmed = await p.confirm({
                        message: `Delete all ${names.length} task sessions?`,
                    });

                    if (p.isCancel(confirmed) || !confirmed) {
                        out.printlnErr("Cancelled.");
                        return;
                    }
                }

                for (const name of names) {
                    await store.deleteSession(name);
                }

                out.printlnErr(`Removed ${names.length} session(s).`);
                return;
            }

            let session = opts.session ?? globalOpts.session;
            if (!session) {
                if (!isInteractive()) {
                    out.printlnErr("error: --session or --all required in non-interactive mode.");
                    out.printlnErr(suggestCommand("tools task", { add: ["clean", "--session", "my-session"] }));
                    process.exit(1);
                }

                const names = await store.listSessionNames();
                if (names.length === 0) {
                    out.printlnErr("No sessions to clean.");
                    return;
                }

                const picked = await p.select({
                    message: "Select session to clean",
                    options: names.map((n) => ({ value: n, label: n })),
                });

                if (p.isCancel(picked)) {
                    out.printlnErr("Cancelled.");
                    return;
                }

                session = picked;
            } else {
                session = await store.resolveSession(session);
            }

            await store.deleteSession(session);
            out.printlnErr(`Removed session: ${session}`);
        });
}
