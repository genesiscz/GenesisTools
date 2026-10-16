import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { downloadClickyLibrary } from "../../lib/permissions/app";

export function registerClickyLibraryCommand(program: Command): void {
    const library = program.command("clicky-library").description("Clicky's sound library (a staging face)");

    library
        .command("download")
        .description("Download, verify and unpack the GenesisTools sound pack for Clicky's Sound libraries")
        .option("--json", "Print { path, reused } as JSON")
        .action(async (options: { json?: boolean }) => {
            const result = await downloadClickyLibrary();

            if (options.json) {
                out.result(result);
                return;
            }

            out.println(`${result.reused ? "Already downloaded" : "Downloaded"}: ${result.path}`);
        });
}
