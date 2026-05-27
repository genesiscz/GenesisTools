import type { Command } from "commander";
import { buildLogQueryOpts, tailOrQuery } from "@app/task/lib/build-log-query-opts";
import { applyGrepImpliesAll, applyLogWindowDefaults } from "@app/task/lib/log-window";
import { withResolvedSession } from "@app/task/lib/with-resolved-session";
import type { LogCliOpts } from "@app/task/types";

export function registerLogsCommand(program: Command): void {
    program
        .command("logs")
        .description("Read session log content (snapshot or live with --follow)")
        .option("--session <name>", "Session name (fuzzy-matched; inherits global if unset)")
        .option("-H, --head <count>", "Show first N lines")
        .option("-t, --tail <count>", "Show last N lines")
        .option("--all", "Dump every line — overrides --head/--tail")
        .option("--from-seq <n>", "Start at seq N (inclusive)")
        .option("--to-seq <n>", "End at seq N (inclusive)")
        .option("--grep <pat>", "Filter lines matching pattern")
        .option("--jsonl", "JSONL records on stdout")
        .option("--raw", "Plain text on stdout (grep-safe)")
        .option("--stdout", "Stdout stream only")
        .option("--stderr", "Stderr stream only")
        .option("-f, --follow", "Follow live")
        .action(async (opts: LogCliOpts) => {
            const globalOpts = program.opts<{ session?: string }>();
            const sessionFlag = opts.session ?? globalOpts.session;
            let resolvedOpts = applyLogWindowDefaults(opts, { ttyTail: "50" });
            resolvedOpts = applyGrepImpliesAll(resolvedOpts);

            await withResolvedSession(sessionFlag, async (session) => {
                const queryOpts = buildLogQueryOpts(session, resolvedOpts);
                await tailOrQuery(queryOpts, Boolean(opts.follow));
            });
        });
}
