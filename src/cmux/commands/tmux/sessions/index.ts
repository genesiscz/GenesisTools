import { registerDeletePresetCommand } from "@app/cmux/commands/tmux/sessions/delete-preset";
import { registerListCommand, runList } from "@app/cmux/commands/tmux/sessions/list";
import { registerListPresetsCommand } from "@app/cmux/commands/tmux/sessions/list-presets";
import { registerRestartMatchingCommand } from "@app/cmux/commands/tmux/sessions/restart-matching";
import { registerRestorePresetCommand } from "@app/cmux/commands/tmux/sessions/restore-preset";
import { registerSavePresetCommand } from "@app/cmux/commands/tmux/sessions/save-preset";
import type { Command } from "commander";

export function registerSessionsCommand(parent: Command): void {
    // Parent has NO options of its own — declaring options here (e.g. --prefix) would
    // shadow identically-named options on child commands and commander would route the
    // user's flag to the parent action instead of the child. Bare `sessions` → list all.
    const sessions = parent
        .command("sessions")
        .description("Inspect and manage tmux sessions (save / restore / restart presets)")
        .action((_opts: unknown, command: Command) => {
            if (command.args.length > 0) {
                return;
            }

            runList({});
        });

    registerListCommand(sessions);
    registerSavePresetCommand(sessions);
    registerRestorePresetCommand(sessions);
    registerListPresetsCommand(sessions);
    registerDeletePresetCommand(sessions);
    registerRestartMatchingCommand(sessions);
}
