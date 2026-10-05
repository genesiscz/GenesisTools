import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { out } from "@genesiscz/utils/logger";
import { UNSUPPORTED_IN_NOTES } from "@genesiscz/utils/markdown/includes";
import { createBoxTable, renderCliHeader } from "@genesiscz/utils/table";
import { defaultTransclusionRegistry, formatParamList } from "@genesiscz/utils/transclude";
import type { Command } from "commander";
import pc from "picocolors";

export function registerTokensCommand(program: Command): void {
    program
        .command("tokens")
        .description("List the {{kind …}} tokens a markdown file may carry, and the ones it may not")
        .option("--json", "machine-readable output")
        .action((flags: { json?: boolean }) => {
            const kinds = defaultTransclusionRegistry()
                .list()
                .map((definition) => ({
                    name: definition.name,
                    params: formatParamList(definition),
                    description: definition.description,
                    supported: !UNSUPPORTED_IN_NOTES[definition.name],
                    why: UNSUPPORTED_IN_NOTES[definition.name] ?? null,
                }));

            if (flags.json) {
                out.result(kinds);
                return;
            }

            renderCliHeader("Markdown tokens", `${toolCommand("markdown resolve")} <file.md>`);
            const table = createBoxTable(["KIND", "PARAMS", "IN A NOTE"]);

            for (const kind of kinds) {
                table.push([
                    pc.white(kind.name),
                    kind.params,
                    kind.supported ? pc.green("yes") : pc.red(`no: ${kind.why}`),
                ]);
            }

            out.println(table.toString());
            out.println(
                pc.dim(
                    "A bare {{name}} (no key=value) is a prompt variable and stays as written. mdBook {{#include path:10:20}} works too."
                )
            );
        });
}
