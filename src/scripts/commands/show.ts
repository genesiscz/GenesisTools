import { suggestCommand } from "@genesiscz/utils/cli";
import { ui } from "@genesiscz/utils/cli/ui";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { getEntry } from "../lib/journal.ts";

export function registerShow(program: Command): void {
    program
        .command("show <name>")
        .description("Print a script's metadata and source")
        .option("--json", "Metadata only, machine-readable")
        .action(async (name: string, opts: { json?: boolean }) => {
            const entry = await getEntry(name);

            if (!entry) {
                throw new Error(
                    `No script named '${name}'. Run '${suggestCommand("tools scripts", { replaceCommand: ["list"] })}'.`
                );
            }

            if (opts.json) {
                out.result(entry);
                return;
            }

            ui.header(`${entry.name}  ${entry.file}`);
            ui.kv("imports", entry.imports.join(", ") || "-");
            ui.kv("tools", entry.tools.join(", ") || "-");
            ui.kv("tags", entry.tags.join(", ") || "-");
            ui.kv("project", entry.project ?? "-");
            ui.kv("gated to", entry.gateDir ?? "-");
            ui.kv("created", `${entry.createdAt} from ${entry.createdFrom}`);
            ui.kv(
                "runs",
                `${entry.runs}${entry.lastRun ? ` (last exit ${entry.lastRun.exitCode}, ${entry.lastRun.durationMs}ms)` : ""}`
            );
            ui.raw("");
            const file = Bun.file(entry.file);

            if (!(await file.exists())) {
                throw new Error(
                    `Script '${name}' is in the journal but its file is missing at ${entry.file}. ` +
                        `Run '${suggestCommand("tools scripts", { replaceCommand: ["rm", name] })}' to drop the stale entry.`
                );
            }

            out.print(await file.text());
        });
}
