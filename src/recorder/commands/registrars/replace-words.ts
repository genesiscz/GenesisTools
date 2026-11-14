import { recordingMovie } from "@app/recorder/lib/toolset";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("replace-words")
        .description(
            "Replace a word or phrase in every transcript line (captions and subtitles show the fixed words); one undo"
        )
        .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
        .requiredOption("--find <text>", "the words to find (whole words, any case)")
        .requiredOption("--replace <text>", "what goes in their place")
        .option("--match-case", "only where the case matches too")
        .option("--part-of-word", "also inside longer words")
        .action(
            async (
                value: string,
                flags: { find: string; replace: string; matchCase?: boolean; partOfWord?: boolean }
            ) => {
                try {
                    const answer = await recordingMovie(value).replaceWords({
                        find: flags.find,
                        replace: flags.replace,
                        matchCase: flags.matchCase,
                        wholeWord: !flags.partOfWord,
                    });
                    out.printlnErr(
                        `replaced in ${answer.replaced.length} line${answer.replaced.length === 1 ? "" : "s"}`
                    );
                    out.result({ replaced: answer.replaced });
                } catch (error) {
                    out.printlnErr(error instanceof Error ? error.message : String(error));
                    process.exitCode = 1;
                }
            }
        );
}
