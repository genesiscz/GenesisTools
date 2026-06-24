import { bar, readState } from "@app/aliases/lib/analysis";
import { out } from "@app/logger";
import type { Command } from "commander";

async function statusAction(): Promise<void> {
    const state = await readState();
    const entries = Object.values(state.paths).sort((a, b) => b.level - a.level);

    if (entries.length === 0) {
        out.result("No alias-level state yet. Run `tools aliases analyze` first.");
        return;
    }

    const lines: string[] = [`aliases state — ${entries.length} path(s)`, ""];
    for (const entry of entries) {
        lines.push(
            `  ${bar(entry.level)}  level ${entry.level.toFixed(1)}  ×${entry.count}  ${entry.commands.join("  →  ")}`
        );
    }

    out.result(lines.join("\n"));
}

export function registerStatusCommand(program: Command): void {
    program.command("status").description("Show the persisted alias-level state, no scan").action(statusAction);
}
