import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { duplicateRecording } from "../lib/duplicate";

const { log } = logger.scoped("recorder-duplicate");

/** `tools recorder duplicate`: a copy of a recording and its edit, for a before and an after. */
export function registerDuplicateCommand(program: Command): void {
    program
        .command("duplicate")
        .description(
            'Copy a recording with its edit (APFS clones, no extra disk) to a new library recording titled "<title> (copy)", or to --to; prints the copy\'s edit path'
        )
        .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
        .option("--title <title>", "the copy's title")
        .option("--to <folder>", "a new or empty folder for the copy instead of the library")
        .option("--json", "print the whole answer as JSON")
        .action(async (value: string, flags: { title?: string; to?: string; json?: boolean }) => {
            try {
                const answer = await duplicateRecording(value, { title: flags.title, to: flags.to });

                if (flags.json) {
                    out.result(answer);
                    return;
                }

                out.println(answer.path);
                out.printlnErr(
                    `"${answer.title}"${answer.id ? ` is ${answer.id} in the library` : ` in ${answer.folder}`}.`
                );
            } catch (error) {
                log.debug({ error }, "duplicate failed");
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}
