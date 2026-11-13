import { runCallsCommand } from "@app/ai-proxy/commands/calls";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("calls")
        .description("Query proxied calls (session/stage/label/model/slow) and open full transcripts")
        .option("--session <id>", "Filter by x-gt-session (substring)")
        .option("--stage <name>", "Filter by x-gt-stage (exact)")
        .option("--label <text>", "Filter by x-gt-label (substring)")
        .option("--model <text>", "Filter by proxy model id (substring)")
        .option("--slower-than <secs>", "Only calls at least this slow", Number.parseFloat)
        .option("--since <minutes>", "Only calls from the last N minutes", Number.parseFloat)
        .option("--limit <n>", "Max rows (newest kept)", "40")
        .option("--show", "Print the full prompt + response of each match")
        .option("--timeline", "Show per-call phase breakdown (dispatch, TTFB, thinking, text)")
        .option("--json", "Machine-readable output")
        .action(
            (options: {
                session?: string;
                stage?: string;
                label?: string;
                model?: string;
                slowerThan?: number;
                since?: number;
                limit: string;
                show?: boolean;
                timeline?: boolean;
                json?: boolean;
            }) => {
                runCallsCommand({
                    session: options.session,
                    stage: options.stage,
                    label: options.label,
                    model: options.model,
                    slowerThan: options.slowerThan,
                    sinceMinutes: options.since,
                    limit: Number(options.limit),
                    show: options.show,
                    timeline: options.timeline,
                    json: options.json,
                });
            }
        );
}
