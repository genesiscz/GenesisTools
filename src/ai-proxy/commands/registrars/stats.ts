import { runStatsCommand } from "@app/ai-proxy/commands/sessions";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("stats")
        .description("Cache totals per agent: hit %, its spread per request and per session, losses by cause")
        .option("--session <id>", "One session only")
        .option("--agent <agent>", "codex, claude (or anthropic), grok, other")
        .option("--since <when>", "A duration (1d, 7d) or a local date", "7d")
        .option(
            "--from-transcripts",
            "Read Claude Code's own transcripts instead of the proxy ledger (the agent comes from the model id)"
        )
        .option("--json", "Machine-readable output")
        .action(
            (options: {
                session?: string;
                agent?: string;
                since?: string;
                json?: boolean;
                fromTranscripts?: boolean;
            }) => {
                runStatsCommand(options);
            }
        );
}
