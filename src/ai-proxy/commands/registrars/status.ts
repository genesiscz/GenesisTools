import { runStatusCommand } from "@app/ai-proxy/commands/status";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("status")
        .description("Show ai-proxy and public exposure status")
        .option("--json", "Machine-readable output")
        .action(async (options) => {
            await runStatusCommand(options);
        });
}
