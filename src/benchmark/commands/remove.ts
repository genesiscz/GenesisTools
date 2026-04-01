import * as p from "@clack/prompts";
import type { Command } from "commander";
import { BUILTIN_SUITES, getCustomSuites, saveCustomSuites } from "../lib/suites";

export async function cmdRemove(name: string): Promise<void> {
    if (BUILTIN_SUITES.some((s) => s.name === name)) {
        p.log.error(`Cannot delete built-in suite "${name}".`);
        process.exit(1);
    }

    const custom = await getCustomSuites();
    const idx = custom.findIndex((s) => s.name === name);

    if (idx === -1) {
        p.log.error(`Suite "${name}" not found.`);
        process.exit(1);
    }

    custom.splice(idx, 1);
    await saveCustomSuites(custom);
    p.log.success(`Suite "${name}" removed.`);
}

export function registerRemoveCommand(program: Command): void {
    program
        .command("remove")
        .description("Remove a custom benchmark suite")
        .argument("<name>", "Suite name to remove")
        .action(async (name: string) => {
            await cmdRemove(name);
        });
}
