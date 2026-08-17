import { ui } from "@genesiscz/utils/cli/ui";
import type { Command } from "commander";
import { trashEntry } from "../lib/journal.ts";
import { commitStore } from "../lib/store.ts";

export function registerRm(program: Command): void {
    program
        .command("rm <name>")
        .description("Move a script to trash/ and drop its journal entry. Never deletes outright.")
        .action(async (name: string) => {
            const result = await trashEntry(name);

            if (!result) {
                throw new Error(`No script named '${name}'.`);
            }

            await commitStore(`chore: trash ${name}`);

            if (!result.moved) {
                ui.warn(`${result.from} was already gone; dropped the stale journal entry`);
                return;
            }

            ui.ok(`moved ${result.from}`);
            ui.kv("to", result.to);
            ui.dim(`restore: mv "${result.to}" "${result.from}"`);
        });
}
