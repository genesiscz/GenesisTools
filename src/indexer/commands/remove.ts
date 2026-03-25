import type { Command } from "commander";
import { IndexerManager } from "../lib/manager";
import { removeWorkflow } from "../lib/remove";

interface RemoveOptions {
    force?: boolean;
}

export function registerRemoveCommand(program: Command): void {
    program
        .command("remove")
        .description("Remove one or more indexes and their data")
        .argument("[name]", "Index name to remove (interactive multiselect if omitted)")
        .option("--force", "Skip confirmation (required in non-TTY)")
        .action(async (name: string | undefined, opts: RemoveOptions) => {
            const manager = await IndexerManager.load();

            try {
                await removeWorkflow({ manager, name, force: opts.force });
            } finally {
                await manager.close();
            }
        });
}
