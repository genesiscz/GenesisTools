import { runInstallCommand } from "@app/ai-proxy/commands/daemon";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("install")
        .description("Install the launchd agent so ai-proxy starts at login and respawns on crash (macOS)")
        .option("--json", "Machine-readable output")
        .action(async (options) => {
            await runInstallCommand(options);
        });
}
