import { resolve } from "node:path";
import { parseTime } from "@app/recorder/commands/registrars/parse";
import { finishExport } from "@app/recorder/lib/edit";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { out } from "@genesiscz/utils/logger";
import { timeToUs } from "@genesiscz/utils/recording-editor/plan";
import type { Command } from "commander";

export function register(program: Command): void {
    program
        .command("finish")
        .description(
            "After an export: write the subtitle file and put the markers into an MP4 as chapters, by the edit's settings"
        )
        .argument("<recording>", "the edit the movie was exported from")
        .argument("<movie>", "the exported movie")
        .option(
            "--from <time>",
            "the movie holds only the part from this OUTPUT time (seconds or m:ss), with no intro or end card"
        )
        .option("--to <time>", "the movie holds only the part up to this OUTPUT time")
        .action(async (value: string, movie: string, flags: { from?: string; to?: string }) => {
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
                const answer = await finishExport({ value, answer: { ok: true, path: resolve(movie) }, part });
                out.result(answer);

                for (const warning of answer.warnings ?? []) {
                    out.printlnErr(warning);
                }

                // A skipped step is said too: a subtitle file only when the edit asks for one.
                if (!answer.subtitles && !answer.warnings?.some((warning) => warning.startsWith("no subtitles"))) {
                    out.printlnErr(
                        `no subtitles: the edit asks for none (${toolCommand("recorder export", value, "--subtitles", "srt")} writes them)`
                    );
                }
            } catch (error) {
                out.printlnErr(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        });
}
