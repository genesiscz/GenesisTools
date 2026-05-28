import { out } from "@app/logger";
import { getSessionInfo } from "@app/task/lib/get-session-info";
import { TaskSessionStore } from "@app/task/lib/session-store";
import { withResolvedSession } from "@app/task/lib/with-resolved-session";
import type { Command } from "commander";

export function registerGetCommand(program: Command): void {
    program
        .command("get")
        .description("Show session info panel (state, files, flags cheat sheet)")
        .option("--clear-older-than-seq <n>", "Remove log lines with seq <= N before showing info")
        .action(async (opts: { clearOlderThanSeq?: string }) => {
            const globalOpts = program.opts<{ session?: string }>();

            await withResolvedSession(globalOpts.session, async (session) => {
                if (opts.clearOlderThanSeq !== undefined) {
                    const seq = Number.parseInt(opts.clearOlderThanSeq, 10);

                    if (Number.isNaN(seq)) {
                        out.printlnErr("error: --clear-older-than-seq requires a number");
                        process.exit(1);
                    }

                    const store = new TaskSessionStore();
                    const removed = await store.clearOlderThanSeq(session, seq);
                    out.printlnErr(`cleared ${removed} line(s) with seq <= ${seq}`);
                }

                await getSessionInfo(session);
            });
        });
}
