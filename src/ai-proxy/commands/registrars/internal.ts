import { runUpdateModelsCommand } from "@app/ai-proxy/commands/internal/update-models";
import type { Command } from "commander";

export function register(program: Command): void {
    const internalCmd = program.command("internal").description("Internal maintenance commands").showHelpAfterError();

    internalCmd
        .command("update-models")
        .description("Probe upstream models and write ~/.genesis-tools/ai-proxy/models-catalog.json")
        .option("--account <name>", "Limit to one account")
        .option("--provider <slug>", "Filter by provider slug (grok, github-copilot)")
        .option("--dry-run", "Print would-be catalog without writing")
        .option("--no-probe", "Picker catalog only")
        .action(async (options) => {
            await runUpdateModelsCommand(options);
        });
}
