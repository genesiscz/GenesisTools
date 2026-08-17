import { ui } from "@genesiscz/utils/cli/ui";
import type { Command } from "commander";
import { findProjectRoot, mutateEntry } from "../lib/journal.ts";
import { commitStore } from "../lib/store.ts";

interface TagOptions {
    add?: string[];
    remove?: string[];
    project?: string;
    gate?: boolean;
    ungate?: boolean;
}

export function registerTag(program: Command): void {
    program
        .command("tag <name>")
        .description("Add or remove tags on a script; also toggles the project gate")
        .option("--add <tags...>", "Tags to add")
        .option("--remove <tags...>", "Tags to remove")
        .option("--project <name>", "Set the project label")
        .option("--gate", "Gate visibility to the current project tree")
        .option("--ungate", "Remove the visibility gate")
        .action(async (name: string, opts: TagOptions) => {
            if (opts.gate && opts.ungate) {
                throw new Error("Pass either --gate or --ungate, not both.");
            }

            // Mutate only this command's fields inside the journal lock, so a
            // concurrent run's counter bump cannot be clobbered by a stale copy.
            let summary = "";
            const found = await mutateEntry(name, (entry) => {
                const tags = new Set(entry.tags);
                for (const t of opts.add ?? []) {
                    tags.add(t);
                }

                for (const t of opts.remove ?? []) {
                    tags.delete(t);
                }

                entry.tags = [...tags];

                if (opts.project) {
                    entry.project = opts.project;
                }

                if (opts.gate) {
                    entry.gateDir = findProjectRoot(process.cwd()) ?? process.cwd();
                }

                if (opts.ungate) {
                    entry.gateDir = undefined;
                }

                entry.updatedAt = new Date().toISOString();
                summary = `${entry.name}: tags [${entry.tags.join(", ")}] project ${entry.project ?? "-"} gate ${entry.gateDir ?? "-"}`;
            });

            if (!found) {
                throw new Error(`No script named '${name}'.`);
            }

            await commitStore(`chore: tag ${name}`);
            ui.raw(summary);
        });
}
