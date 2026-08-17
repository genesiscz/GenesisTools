import { suggestCommand } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import type { Command } from "commander";
import pc from "picocolors";
import { renameScript } from "../lib/journal.ts";
import { commitStore } from "../lib/store.ts";

export function registerRename(program: Command): void {
    program
        .command("rename <from> <to>")
        .description("Rename a script: its directory, files, sidecars, tools import and journal entry")
        .action(async (from: string, to: string) => {
            const result = await renameScript(from, to);
            await commitStore(`refactor: rename ${from} to ${to}`);
            ui.ok(`renamed ${from} → ${to}`);
            ui.raw(`  ${pc.dim(result.dir)}`);

            for (const move of result.moved) {
                ui.raw(`  ${pc.dim(move)}`);
            }

            ui.kv("run", suggestCommand("tools scripts", { replaceCommand: ["run", to] }));
        });
}
