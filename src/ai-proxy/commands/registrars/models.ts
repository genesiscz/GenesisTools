import { runModelsCommand } from "@app/ai-proxy/commands/models";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("models")
        .description("List proxy model ids and metadata")
        .option("--provider <slug>", "Filter by provider slug")
        .option("--visibility <tier>", "Filter by visibility: high|medium|low")
        .option("--json", "Machine-readable output")
        .option("--cursor-ids", "Print only proxy ids")
        .action(async (options) => {
            await runModelsCommand(options);
        });
}
