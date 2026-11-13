import { runLinkCommand } from "@app/ai-proxy/commands/link";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("link")
        .description("Register this proxy as an AI-config account so @proxy/<slug>/<model> refs resolve")
        .option("--status", "Report the link without changing anything")
        .action(async (options: { status?: boolean }) => {
            await runLinkCommand(options);
        });
}
