import { out } from "@app/logger";
import { isInteractive, suggestCommand } from "@app/utils/cli";
import { withCancel } from "@app/utils/prompts/clack/helpers";
import { TmuxPresetStore } from "@app/utils/tmux/snapshot-store";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

interface DeleteFlags {
    yes?: boolean;
}

export function registerPresetDeleteCommand(parent: Command): void {
    parent
        .command("delete <name>")
        .description("Delete a saved tmux session preset")
        .option("-y, --yes", "Skip the confirmation prompt")
        .action(async (name: string, flags: DeleteFlags) => {
            await runDeletePreset(name, flags);
        });
}

export async function runDeletePreset(name: string, flags: DeleteFlags): Promise<void> {
    const store = new TmuxPresetStore();

    if (!store.exists(name)) {
        out.error(`No preset named "${name}"`);
        process.exitCode = 1;
        return;
    }

    if (!flags.yes) {
        if (!isInteractive()) {
            out.error(
                `Pass --yes to skip the confirmation in non-interactive mode. ${suggestCommand(`tools tmux presets delete ${name} --yes`)}`
            );
            process.exitCode = 1;
            return;
        }

        const proceed = await withCancel(
            p.confirm({ message: `Delete preset "${name}"?`, initialValue: false })
        );

        if (!proceed) {
            p.cancel("Aborted.");
            return;
        }
    }

    const removed = store.delete(name);

    if (removed) {
        out.println(pc.green(`✓ deleted preset ${pc.cyan(name)}`));
    } else {
        out.error(`Failed to delete preset "${name}"`);
        process.exitCode = 1;
    }
}
