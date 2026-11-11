import { runUpCommand } from "@app/ai-proxy/commands/up";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("up")
        .description("Start ai-proxy (and optional public exposure tunnel)")
        .action(async () => {
            await runUpCommand();
        });
}
