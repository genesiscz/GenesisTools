import { ui } from "@genesiscz/utils/cli/ui";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";
import { dictionaryRows, localAvailable } from "../lib/local";
import { errorText, fail, resolveEnum } from "./shared";

const FORMATS = ["table", "json"] as const;

async function list(opts: { format?: string | boolean; snippets?: boolean }): Promise<void> {
    const format = await resolveEnum({
        value: opts.format,
        fallback: "table",
        values: FORMATS,
        flag: "--format",
        subcommand: ["dictionary", "list"],
    });

    if (!format) {
        return;
    }

    if (!localAvailable()) {
        fail(
            "The dictionary is only in the local app data, and Wispr Flow's data is not on this Mac. The MCP has no dictionary."
        );
        return;
    }

    try {
        const rows = dictionaryRows({ withSnippets: opts.snippets });

        if (format === "json") {
            out.result(SafeJSON.stringify(rows, null, 2));
            return;
        }

        const table = createBoxTable(["PHRASE", "REPLACEMENT", "USES", "ADDED"]);

        for (const row of rows) {
            table.push([
                pc.white(truncateDisplay(row.phrase, 40)),
                truncateDisplay(row.replacement ?? "", 50) || "—",
                String(row.uses),
                row.manual ? "by hand" : "by the app",
            ]);
        }

        out.println(table.toString());
        ui.dim(
            `${rows.length} entries (read-only). Propose them for the meetings dictionary: tools meetings dictionary suggest`
        );
    } catch (err) {
        fail(errorText(err));
    }
}

export function registerDictionaryCommand(program: Command): void {
    const dictionary = program.command("dictionary").description("The app's own dictionary (read-only)");

    dictionary
        .command("list")
        .alias("ls")
        .description("Words the app was taught to spell, most used first")
        .option("--snippets", "include text snippets")
        .option("--format [format]", "table | json")
        .action(list);
}
