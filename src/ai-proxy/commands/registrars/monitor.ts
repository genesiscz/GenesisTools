import { type MonitorOptions, runMonitorCommand } from "@app/ai-proxy/commands/monitor";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("monitor")
        .description(
            "Live requests and compaction events, one line each (filters: session, model, compaction, slow, errors)"
        )
        .option(
            "--session <prefix>",
            "Only this session: the proxy record, Claude Code's id, or a request's session tag"
        )
        .option("--model <text>", "Only models whose id contains this")
        .option("--compaction", "Only compaction requests and compaction events")
        .option("--slow <secs>", "Only requests at least this slow (events always print)", Number.parseFloat)
        .option("--errors", "Only failed requests and warning events (retry, missed, wasted, failed, blocked)")
        .option("--since <minutes>", "Print the last N minutes first", Number.parseFloat)
        .option("--once", "Print the --since backlog and stop")
        .option("--json", "One JSON object per line")
        .action((options: MonitorOptions) => {
            runMonitorCommand(options);
        });
}
