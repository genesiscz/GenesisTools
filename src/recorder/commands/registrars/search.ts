import { searchLibrary } from "@app/recorder/lib/moments";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable } from "@genesiscz/utils/table";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("search")
        .description(
            "Find a moment across the library: titles, marker labels and cached transcript lines (case and accents ignored)"
        )
        .argument("<text>", "what to look for")
        .option("--json", "JSON on stdout")
        .action((text: string, flags: { json?: boolean }) => {
            const hits = searchLibrary(text);

            if (flags.json) {
                out.result(hits);
                return;
            }

            if (!hits.length) {
                out.println(`Nothing in the library matches "${text}".`);
                return;
            }

            const table = createBoxTable(["RECORDING", "KIND", "AT", "TEXT"]);
            for (const hit of hits) {
                table.push([hit.recording, hit.kind, `${hit.at.toFixed(1)} s`, hit.text.slice(0, 80)]);
            }

            out.println(table.toString());
        });
}
