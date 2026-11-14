import { parseTime } from "@app/recorder/commands/registrars/parse";
import { transcriptWords } from "@app/recorder/lib/edit";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("words")
        .description(
            "The words of each transcript line as cut-words splits and times them (the editor's word pick reads this)"
        )
        .argument("<recording>", "a library id, `last`, a meeting id, a recording folder, a movie or an edit.json")
        .option("--at <time>", "only the line spoken at this source time (seconds, m:ss or h:mm:ss)")
        .action(async (value: string, flags: { at?: string }) => {
            try {
                out.result(await transcriptWords(value, flags.at ? { at: parseTime(flags.at, "--at") } : {}));
            } catch (error) {
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}
