import type { Command } from "commander";
import { buildLogQueryOpts, tailOrQuery } from "@app/task/lib/build-log-query-opts";
import { applyGrepImpliesAll, applyLogWindowDefaults } from "@app/task/lib/log-window";
import { waitForSession } from "@app/task/lib/wait-for-session";
import { withResolvedSession } from "@app/task/lib/with-resolved-session";
import type { LogCliOpts } from "@app/task/types";

export function registerTailCommand(program: Command): void {
    program
        .command("tail")
        .description("Follow session logs live (same as logs --follow)")
        .option("--session <name>", "Session name (fuzzy-matched; inherits global if unset)")
        .option("-H, --head <count>", "Show first N existing lines before follow")
        .option("-t, --tail <count>", "Show last N existing lines before follow")
        .option("--all", "Show all existing lines before follow — overrides --head/--tail")
        .option("--from-seq <n>", "Start at seq N (inclusive)")
        .option("--to-seq <n>", "End at seq N (inclusive)")
        .option("--grep <pat>", "Filter lines matching pattern")
        .option("--jsonl", "JSONL records on stdout")
        .option("--raw", "Plain text on stdout (grep-safe)")
        .option("--stdout", "Stdout stream only")
        .option("--stderr", "Stderr stream only")
        .option("-f, --follow", "Follow live (default for tail)")
        .option("--exit-on-match <pat>", "Exit 0 as soon as PATTERN appears (regex)")
        .option("--propagate-exit", "Exit with the session's exit code when it ends")
        .action(async (opts: LogCliOpts & { exitOnMatch?: string; propagateExit?: boolean }) => {
            const globalOpts = program.opts<{ session?: string }>();
            const sessionFlag = opts.session ?? globalOpts.session;
            let resolvedOpts = applyGrepImpliesAll(opts);
            resolvedOpts = applyLogWindowDefaults(resolvedOpts, { ttyTail: "10" });

            await withResolvedSession(sessionFlag, async (session) => {
                if (opts.exitOnMatch) {
                    const result = await waitForSession({
                        session,
                        exitOnMatch: new RegExp(opts.exitOnMatch),
                        waitForExit: true,
                    });

                    if (result.reason === "match") {
                        if (result.matchedLine) {
                            process.stdout.write(`${result.matchedLine}\n`);
                        }

                        process.exit(0);
                    }

                    process.exit(1);
                }

                const queryOpts = buildLogQueryOpts(session, resolvedOpts);
                const sessionExitCode = await tailOrQuery(queryOpts, true, {
                    propagateExit: Boolean(opts.propagateExit),
                });

                if (opts.propagateExit && typeof sessionExitCode === "number") {
                    process.exit(sessionExitCode);
                }
            });
        });
}
