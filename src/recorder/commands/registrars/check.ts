import { Movie } from "@app/recorder/lib/toolset";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("check")
        .description(
            "What to fix before an export (items and markers whose time is cut, texts a cut shortens, missing music, captions or subtitles without a transcript) and what to look at; changes nothing"
        )
        .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
        .action(async (value: string) => {
            try {
                const answer = await new Movie(value).check();

                // R6 9: one line per kind of issue with its count; --json (the result) keeps every issue.
                for (const line of answer.summary) {
                    out.printlnErr(line);
                }

                if (!answer.issues.length) {
                    out.printlnErr("nothing to fix or check");
                }

                out.result(answer);
            } catch (error) {
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}
