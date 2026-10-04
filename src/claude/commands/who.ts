import { runWho } from "@app/ai/lib/accounts/run-who";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import type { Command } from "commander";

/** A door onto the shared account lib. `tools ai accounts who` shows the same table. */
export function registerWhoCommand(program: Command): void {
    program
        .command("who")
        .alias("active")
        .description(
            "List live Claude Code processes with the account each one runs as " +
                `(read from TOOLS_CLAUDE_ACCOUNT in the process env; 'keychain?' = launched outside ${toolCommand("claude run")})`
        )
        .option("--json", "Machine-readable output")
        .option(
            "--all",
            `Include helper processes: \`${toolCommand("claude mcp")}\` servers (any tty) and SDK launchers sharing a TUI's tty`
        )
        .action(async (opts: { json?: boolean; all?: boolean }) => {
            await runWho(opts);
        });
}
