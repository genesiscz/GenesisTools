import type { Command } from "commander";
import { buildLogQueryOpts, tailOrQuery } from "../lib/build-log-query-opts";
import { withResolvedSession } from "../lib/with-resolved-session";

export function registerTailCommand(program: Command): void {
    program
        .command("tail")
        .description("Follow session logs live (same as logs --tail)")
        .option("-n, --lines <count>", "Show last N existing lines before follow", "10")
        .option("--all", "Return all matching lines (ignore --lines default)")
        .option("--from-seq <n>", "Start at seq N (inclusive)")
        .option("--to-seq <n>", "End at seq N (inclusive)")
        .option("--grep <pat>", "Filter lines matching pattern")
        .option("--jsonl", "JSONL records on stdout")
        .option("--raw", "Plain text on stdout (grep-safe)")
        .option("--stdout", "Stdout stream only")
        .option("--stderr", "Stderr stream only")
        .option("-f, --follow", "Follow live (default for tail)")
        .action(async (opts) => {
            const globalOpts = program.opts<{ session?: string }>();

            await withResolvedSession(globalOpts.session, async (session) => {
                const queryOpts = buildLogQueryOpts(session, opts);
                await tailOrQuery(queryOpts, true);
            });
        });
}
