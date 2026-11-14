import { parseSubtitleFormat, parseTime } from "@app/recorder/commands/registrars/parse";
import { writeSubtitles } from "@app/recorder/lib/edit";
import { out } from "@genesiscz/utils/logger";
import { timeToUs } from "@genesiscz/utils/recording-editor/plan";
import type { Command } from "commander";

interface SubtitlesFlags {
    format?: string;
    out?: string;
    from?: string;
    to?: string;
    outputTime?: boolean;
}

export function register(program: Command): void {
    program
        .command("subtitles")
        .description(
            "Write a recording's transcript as a subtitle file for its export (cut lines left out, fixes kept): the export's clock, so with an intro card every cue starts the card's length later"
        )
        .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
        .option("--format <format>", "srt (default) or vtt")
        .option("--out <file>", "the file to write (default beside the movie, named like its export)")
        .option("--from <time>", "only the part from this OUTPUT time, moved to start at 0 (an exported part)")
        .option("--to <time>", "only the part up to this OUTPUT time")
        .option("--output-time", "the movie's own times, without the intro card (a part never has one)")
        .action(async (value: string, flags: SubtitlesFlags) => {
            try {
                const part =
                    flags.from === undefined && flags.to === undefined
                        ? undefined
                        : {
                              fromUs: flags.from === undefined ? 0 : timeToUs(parseTime(flags.from, "--from")),
                              toUs:
                                  flags.to === undefined
                                      ? Number.MAX_SAFE_INTEGER
                                      : timeToUs(parseTime(flags.to, "--to")),
                          };
                out.result(
                    await writeSubtitles({
                        value,
                        format: flags.format === undefined ? "srt" : parseSubtitleFormat(flags.format),
                        out: flags.out,
                        part,
                        clock: flags.outputTime ? "output" : undefined,
                    })
                );
            } catch (error) {
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}
