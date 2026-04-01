import { findProjectRoot } from "@app/todo/lib/context";
import { TodoStore } from "@app/todo/lib/store";
import { isInteractive } from "@app/utils/cli";
import * as p from "@clack/prompts";
import { Command } from "commander";

export function createRemoveCommand(): Command {
    return new Command("remove")
        .alias("rm")
        .description("Remove a todo")
        .argument("<id>", "Todo ID")
        .action(async (id) => {
            const projectRoot = findProjectRoot(process.cwd()) ?? process.cwd();
            const store = TodoStore.forProject(projectRoot);
            const existing = await store.get(id);

            if (!existing) {
                console.error(`Todo not found: ${id}`);
                process.exit(1);
            }

            if (isInteractive()) {
                const confirm = await p.confirm({
                    message: `Remove "${existing.title}" (${id})?`,
                });

                if (p.isCancel(confirm) || !confirm) {
                    p.cancel("Cancelled.");
                    process.exit(0);
                }
            }

            const removed = await store.remove(id);

            if (removed) {
                console.log(`Removed ${id}`);
            } else {
                console.error(`Failed to remove ${id}`);
                process.exit(1);
            }
        });
}
