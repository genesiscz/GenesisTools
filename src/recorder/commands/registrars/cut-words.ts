import { parseTime } from "@app/recorder/commands/registrars/parse";
import { recordingMovie } from "@app/recorder/lib/toolset";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("cut-words")
        .description(
            "Cut words out of the transcript line spoken at a source time (every place that line says them, or --occurrence); one undo"
        )
        .argument("<recording>", "a library id, `last`, a meeting id, a recording folder, a movie or an edit.json")
        .requiredOption("--at <time>", "any source time inside the line (seconds, m:ss or h:mm:ss)")
        .requiredOption("--words <text>", "the word or words, in order")
        .option("--occurrence <n>", "only this place of the words in the line (1 is the first)")
        .option("--pad-ms <ms>", "kept off the words' edges", "40")
        .option("--dry-run", "list what it would cut, save nothing")
        .action(
            async (
                value: string,
                flags: { at: string; words: string; occurrence?: string; padMs?: string; dryRun?: boolean }
            ) => {
                try {
                    const movie = recordingMovie(value);
                    out.result(
                        await movie.cutWords({
                            at: parseTime(flags.at, "--at"),
                            words: flags.words,
                            ...(flags.occurrence !== undefined ? { occurrence: Number(flags.occurrence) } : {}),
                            padMs: Number(flags.padMs ?? 40),
                            dryRun: flags.dryRun,
                        })
                    );
                } catch (error) {
                    out.printlnErr(error instanceof Error ? error.message : String(error));
                    process.exitCode = 1;
                }
            }
        );
}
