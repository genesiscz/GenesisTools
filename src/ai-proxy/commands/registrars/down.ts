import { runDownCommand } from "@app/ai-proxy/commands/down";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("down")
        .description("Stop ai-proxy only (never stops shared cloudflared tunnel)")
        .action(async () => {
            await runDownCommand();
        });
}
