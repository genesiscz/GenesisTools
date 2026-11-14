import { parseSubtitleFormat, parseTime } from "@app/recorder/commands/registrars/parse";
import {
    EXPORT_FORMATS,
    type ExportFormat,
    exportAs,
    exportProgressPrinter,
    parseExportSize,
} from "@app/recorder/lib/edit";
import { ensureRecorderPart } from "@app/recorder/lib/library";
import { out } from "@genesiscz/utils/logger";
import { timeToUs } from "@genesiscz/utils/recording-editor/plan";
import type { Command } from "commander";

function parseFormat(raw: string): ExportFormat {
    const format = EXPORT_FORMATS.find((candidate) => candidate === raw.toLowerCase());

    if (!format) {
        throw new Error(`--format takes ${EXPORT_FORMATS.join(", ")} (got "${raw}")`);
    }

    return format;
}

export function register(program: Command): void {
    program
        .command("export")
        .description(
            "Render a recording's edit (or a whole movie) to an MP4 with the editor's own renderer, without a window"
        )
        .argument("<recording>", "a library id, `last`, a recording folder, a movie or an edit.json")
        .option(
            "--out <file>",
            "the file to write; the extension follows the format (default: the file chosen in the editor, else <name>-edited.<format> beside the source; a part adds -part-<from>-<to>; never an existing file without --overwrite)"
        )
        .option(
            "--format <format>",
            `${EXPORT_FORMATS.join(", ")} (default the --out extension, else mp4; a gif is 10 fps, at most 960 wide)`
        )
        .option("--from <time>", "export only the part from this OUTPUT time (seconds or m:ss; what plays)")
        .option("--to <time>", "export only the part up to this OUTPUT time")
        .option("--subtitles <format>", "also write the transcript beside the movie: srt or vtt")
        // R5 3 export overwrite, size, progress
        .option("--overwrite", "replace the file at --out (or the usual name) instead of refusing it")
        .option("--size <WxH>", "the picture's exact pixels: 1920x1080, 1920x (width) or x1080 (height)")
        .option("--json", "the result as JSON")
        .action(
            async (
                value: string,
                flags: {
                    out?: string;
                    format?: string;
                    from?: string;
                    to?: string;
                    subtitles?: string;
                    json?: boolean;
                    overwrite?: boolean;
                    size?: string;
                }
            ) => {
                try {
                    await ensureRecorderPart((line) => out.printlnErr(line));
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
                    const answer = await exportAs(value, {
                        out: flags.out,
                        format: flags.format === undefined ? undefined : parseFormat(flags.format),
                        part,
                        subtitles: flags.subtitles === undefined ? undefined : parseSubtitleFormat(flags.subtitles),
                        overwrite: flags.overwrite,
                        size: flags.size === undefined ? undefined : parseExportSize(flags.size),
                        // Progress on stderr every 10 %, so a long export shows it is alive (stdout stays the result).
                        onProgress: exportProgressPrinter((line) => out.printlnErr(line)),
                    });

                    if (flags.json) {
                        out.result(answer);
                    } else {
                        out.println(
                            answer.ok
                                ? `${answer.path} (${answer.bytes} bytes, ${answer.seconds} s${answer.chapters ? `, ${answer.chapters} chapters` : ""}${answer.replaced ? ", replaced the old file" : ""})${answer.subtitles ? `\n${answer.subtitles}` : ""}`
                                : `error: ${answer.error}`
                        );

                        for (const warning of answer.warnings ?? []) {
                            out.printlnErr(warning);
                        }
                    }

                    if (!answer.ok) {
                        process.exitCode = 1;
                    }
                } catch (error) {
                    out.printlnErr(error instanceof Error ? error.message : String(error));
                    process.exitCode = 1;
                }
            }
        );
}
