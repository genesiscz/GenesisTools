import { runAttach } from "@app/tmux/commands/session";
import type { Command } from "commander";

export function registerAttachCommand(program: Command): void {
    program
        .command("attach <query>")
        .description("Attach to a session (shortcut for `session attach`)")
        .action(async (query: string) => {
            await runAttach(query);
        });
}
