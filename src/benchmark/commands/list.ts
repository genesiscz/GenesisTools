import { formatTable } from "@app/utils/table";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import { getAllSuites } from "../lib/suites";

export async function cmdList(): Promise<void> {
    const allSuites = await getAllSuites();

    if (allSuites.length === 0) {
        p.log.info("No benchmark suites defined.");
        return;
    }

    const rows = allSuites.map((s) => [
        s.name,
        s.builtIn ? pc.dim("built-in") : "custom",
        String(s.commands.length),
        s.commands.map((c) => c.label).join(", "),
    ]);

    const table = formatTable(rows, ["Name", "Type", "Cmds", "Labels"], { alignRight: [2] });
    p.note(table, "Benchmark Suites");
}

export function registerListCommand(program: Command): void {
    program
        .command("list")
        .description("List all benchmark suites")
        .action(async () => {
            await cmdList();
        });
}
