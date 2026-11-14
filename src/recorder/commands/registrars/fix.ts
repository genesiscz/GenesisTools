import { recordingMovie } from "@app/recorder/lib/toolset";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("fix")
        .description(
            "Runs every fix `check` offers (removes what never shows, moves a cut marker to the nearest kept moment, lengthens what is too short to read, moves a text off another) in one save and one undo step"
        )
        .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
        .action(async (value: string) => {
            try {
                const answer = await recordingMovie(value).fix();

                for (const message of answer.fixed) {
                    out.printlnErr(`fixed  ${message}`);
                }

                for (const warning of answer.warnings ?? []) {
                    out.printlnErr(warning);
                }

                out.result(answer);
            } catch (error) {
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}
