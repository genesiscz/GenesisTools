import type { Command } from "commander";
import { buildLogQueryOpts, tailOrQuery } from "../lib/build-log-query-opts";
import { TaskSessionStore } from "../lib/session-store";
import { statusError } from "../lib/stderr-status";

export function registerLogsCommand(program: Command): void {
    program
        .command("logs")
        .description("Read session log content (snapshot or live with --tail/--follow)")
        .option("-n, --lines <count>", "Last N lines", "50")
        .option("--from-seq <n>", "Start at seq N (inclusive)")
        .option("--to-seq <n>", "End at seq N (inclusive)")
        .option("--grep <pat>", "Filter lines matching pattern")
        .option("--jsonl", "JSONL records on stdout")
        .option("--raw", "Plain text on stdout (grep-safe)")
        .option("--stdout", "Stdout stream only")
        .option("--stderr", "Stderr stream only")
        .option("--tail", "Follow live (same as task tail)")
        .option("-f, --follow", "Alias for --tail")
        .action(async (opts) => {
            const globalOpts = program.opts<{ session?: string }>();
            const store = new TaskSessionStore();

            try {
                const session = await store.resolveSession(globalOpts.session);
                const queryOpts = buildLogQueryOpts(session, opts);
                await tailOrQuery(queryOpts, Boolean(opts.tail || opts.follow));
            } catch (err) {
                statusError(err instanceof Error ? err.message : String(err));
                process.exit(1);
            }
        });
}
