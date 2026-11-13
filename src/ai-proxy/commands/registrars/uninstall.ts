import { runUninstallCommand } from "@app/ai-proxy/commands/daemon";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("uninstall")
        .description("Unload and remove the launchd agent (the proxy stops)")
        .option("--json", "Machine-readable output")
        .action(async (options) => {
            await runUninstallCommand(options);
        });
}
