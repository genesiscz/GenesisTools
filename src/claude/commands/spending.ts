import { registerSpendCommand } from "@app/ai-spend/lib/register";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import type { Command } from "commander";

export function registerSpendingCommand(program: Command): void {
    const spending = program
        .command("spending")
        .description(
            `Claude Code token & cost analytics across all local sessions (alias of \`${toolCommand("ai-spend")}\`)`
        );
    registerSpendCommand(spending);
}
