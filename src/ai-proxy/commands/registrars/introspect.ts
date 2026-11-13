import { runIntrospectCommand } from "@app/ai-proxy/commands/introspect";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("introspect")
        .alias("ls")
        .description("Print full copy-paste inventory for Cursor BYOK")
        .option("--json", "Machine-readable output")
        .option("--show-secrets", "Include full proxy API key in output")
        .option("--clipboard", "Copy output to clipboard")
        .option("--section <name>", "accounts|endpoints|models|cursor|all")
        .option("--account <name>", "Limit to one account")
        .action(async (options) => {
            await runIntrospectCommand(options);
        });
}
