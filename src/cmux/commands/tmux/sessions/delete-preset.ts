import { out } from "@app/logger";
import { isInteractive, suggestCommand } from "@app/utils/cli";
import { TmuxPresetStore } from "@app/utils/tmux/snapshot-store";
import type { Command } from "commander";
import pc from "picocolors";

interface DeleteFlags {
    yes?: boolean;
}

export function registerDeletePresetCommand(parent: Command): void {
    parent
        .command("delete-preset <name>")
        .description("Delete a saved tmux session preset")
        .option("-y, --yes", "Skip the confirmation prompt")
        .action((name: string, flags: DeleteFlags) => {
            runDeletePreset(name, flags);
        });
}

export function runDeletePreset(name: string, flags: DeleteFlags): void {
    const store = new TmuxPresetStore();

    if (!store.exists(name)) {
        out.error(`No preset named "${name}"`);
        process.exitCode = 1;
        return;
    }

    if (!flags.yes) {
        if (!isInteractive()) {
            out.error(
                `Pass --yes to skip the confirmation in non-interactive mode. ${suggestCommand(`tools cmux tmux sessions delete-preset ${name} --yes`)}`
            );
            process.exitCode = 1;
            return;
        }

        out.error(`Refusing to delete preset "${name}" without --yes`);
        process.exitCode = 1;
        return;
    }

    const removed = store.delete(name);

    if (removed) {
        out.println(pc.green(`✓ deleted preset ${pc.cyan(name)}`));
    } else {
        out.error(`Failed to delete preset "${name}"`);
        process.exitCode = 1;
    }
}
