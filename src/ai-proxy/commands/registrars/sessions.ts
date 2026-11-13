import { runSessionsCommand } from "@app/ai-proxy/commands/sessions";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("sessions")
        .description("One row per session record: accounts, model, requests, tokens, cache hit %, losses, last error")
        .option("--open", "Only sessions that are still open")
        .option("--since <when>", "Sessions active since a duration (1d, 7d) or a local date", "7d")
        .option("--json", "Machine-readable output")
        .action((options: { open?: boolean; since?: string; json?: boolean }) => {
            runSessionsCommand(options);
        });
}
