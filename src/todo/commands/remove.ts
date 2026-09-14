import {
    PROJECT_OPTION_DESCRIPTION,
    reportMissingTodo,
    resolveProjectRoot,
    storeForProject,
} from "@app/todo/lib/project";
import * as p from "@clack/prompts";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import pc from "picocolors";

export function createRemoveCommand(): Command {
    return new Command("remove")
        .alias("rm")
        .description("Remove a todo")
        .argument("<id>", "Todo ID")
        .option("--project <path>", PROJECT_OPTION_DESCRIPTION)
        .option("-y, --yes", "Skip confirmation (required in non-interactive mode)")
        .action(async (id, opts) => {
            const projectRoot = resolveProjectRoot(opts.project);
            const store = storeForProject(opts.project);
            const existing = await store.get(id);

            if (!existing) {
                const missing = await reportMissingTodo(id, projectRoot);

                out.error(pc.red(missing.message));

                process.exit(1);
            }

            if (!isInteractive() && !opts.yes) {
                out.error("Error: --yes required for non-interactive removal.");
                out.error(suggestCommand("tools todo remove", { add: [id, "--yes"] }));
                process.exit(1);
            }

            if (isInteractive() && !opts.yes) {
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
                out.println(`Removed ${id}`);
            } else {
                out.error(`Failed to remove ${id}`);
                process.exit(1);
            }
        });
}
