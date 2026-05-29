import { registerTmuxCreateCommand } from "@app/cmux/commands/tmux/create";
import type { Command } from "commander";

export function registerTmuxCommand(program: Command): void {
    const tmux = program.command("tmux").description("Standalone tmux sessions for dev-dashboard handoff");

    registerTmuxCreateCommand(tmux);
}
