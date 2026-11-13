import { runUsageCommand } from "@app/ai-proxy/commands/usage";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("usage")
        .description("Show subscription or Management API usage")
        .option("--account <name>", "Limit to one account")
        .option("--provider <type>", "Filter by provider type or slug (e.g. openai-subscription, codex)")
        .option("--json", "Machine-readable output")
        .option("--recent <n>", "Include last N local request records", (value) => Number.parseInt(value, 10))
        .option("--breakdown", "Per-model aggregates over the trailing 30 days")
        .option("--paths", "Print local usage store file paths")
        .action(async (options) => {
            await runUsageCommand(options);
        });
}
