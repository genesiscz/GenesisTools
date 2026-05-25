import { out } from "@app/logger";
import type { Command } from "commander";
import { buildLogQueryOpts, tailOrQuery } from "../lib/build-log-query-opts";
import { TaskSessionStore } from "../lib/session-store";

export function registerTailCommand(program: Command): void {
    program
        .command("tail")
        .description("Follow session logs live (same as logs --tail)")
        .option("-n, --lines <count>", "Show last N existing lines before follow", "10")
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
            const store = new TaskSessionStore();

            try {
                const session = await store.resolveSession(globalOpts.session);
                const queryOpts = buildLogQueryOpts(session, opts);
                await tailOrQuery(queryOpts, true);
            } catch (err) {
                out.error(err instanceof Error ? err.message : String(err));
                process.exit(1);
            }
        });
}
