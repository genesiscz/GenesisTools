import { resolve } from "node:path";
import { runTool, suggestEnumFlag } from "@genesiscz/utils/cli";
import { pickEnumFlag } from "@genesiscz/utils/cli/enum-flag";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { out } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { prepareVideoEvidence } from "@genesiscz/utils/video/evidence";
import { probeVideo } from "@genesiscz/utils/video/probe";
import {
    encoderUnavailableReason,
    findEncoder,
    isVideoEncoderCodec,
    VIDEO_ENCODER_CODECS,
} from "@genesiscz/utils/video/reencode";
import { secondsToMicroseconds } from "@genesiscz/utils/video/sampling";
import { VIDEO_FPS, VIDEO_GROUPS, videoSettingsSchema } from "@genesiscz/utils/video/types";
import { Command } from "commander";
import { encodeVideos, exitCodeFor, renderRows, summarize } from "./encode";

export function registerVideoCommands(program: Command): void {
    program
        .command("probe <input>")
        .description("Inspect a local video, including silent videos")
        .option("--json", "Print structured metadata")
        .action(async (input: string) => {
            await withInterrupt(async (signal) => out.result(await probeVideo({ input, signal })), {
                handleTermination: true,
            });
        });
    program
        .command("encode <paths...>")
        .description(
            "Re-encode videos with the hardware encoder (HEVC on macOS), keeping a result only when it is verified"
        )
        .option("--quality <n>", "Encoder quality, higher is better (hevc: 58 matches libx265 crf 26)", "58")
        .option("--codec [name]", `Target codec: ${VIDEO_ENCODER_CODECS.join(", ")}`, "hevc")
        .option("--jobs <n>", "Files encoded at once (the hardware encoder has few sessions)", "2")
        .option("--min-saving <percent>", "Discard an output that is less than this much smaller", "25")
        .option(
            "--replace",
            'Put the result at the original path and move the original to the GenesisTools trash. An agent cannot replace a file the rm rules mark "ask": the result stays beside it. A bare trash restore refuses while the new file sits at the original path: move it to <name>.hevc.<ext> first. The summary prints both undo steps'
        )
        .option("--dry-run", "List what would happen, with input sizes and skip reasons; write nothing")
        .option("--json", "Print one row per file")
        .action(
            async (
                paths: string[],
                options: {
                    quality: string;
                    codec: string | boolean;
                    jobs: string;
                    minSaving: string;
                    replace?: boolean;
                    dryRun?: boolean;
                    json?: boolean;
                }
            ) => {
                const codec = await pickEnumFlag({
                    tool: "tools video encode",
                    subcommand: ["encode"],
                    flag: "--codec",
                    given: options.codec,
                    values: VIDEO_ENCODER_CODECS,
                    fallback: "hevc",
                    accepts: isVideoEncoderCodec,
                });
                const encoder = codec === null ? undefined : findEncoder(codec);

                if (!encoder) {
                    process.exitCode = 1;
                    return;
                }

                const quality = Number(options.quality);
                const jobs = Number(options.jobs);
                const minSavingPct = Number(options.minSaving);

                if (
                    !Number.isFinite(quality) ||
                    quality < 0 ||
                    quality > 100 ||
                    !Number.isInteger(jobs) ||
                    jobs < 1 ||
                    !Number.isFinite(minSavingPct)
                ) {
                    out.log.error("Use --quality 0 to 100, --jobs 1 or more, and --min-saving as a number.");
                    process.exitCode = 1;
                    return;
                }

                const unavailable = await encoderUnavailableReason(encoder);

                if (unavailable) {
                    out.log.error(`Cannot encode: ${unavailable}`);
                    process.exitCode = 1;
                    return;
                }

                await withInterrupt(
                    async (signal) => {
                        const started = performance.now();
                        const rows = await encodeVideos({
                            paths,
                            encoder,
                            quality,
                            jobs,
                            minSavingPct,
                            replace: options.replace === true,
                            dryRun: options.dryRun === true,
                            signal,
                        });

                        const exitCode = exitCodeFor(rows);

                        if (exitCode !== 0) {
                            process.exitCode = exitCode;
                        }

                        if (options.json) {
                            out.result(rows);
                            return;
                        }

                        renderRows({
                            rows,
                            summary: summarize({ rows, seconds: (performance.now() - started) / 1000 }),
                            dryRun: options.dryRun === true,
                            encoder,
                        });
                    },
                    { handleTermination: true }
                );
            }
        );
    program
        .command("frames <input>")
        .description("Prepare timestamped PNG contact sheets and full-resolution frames")
        .option("--fps [value]", "Frames per second: 1, 2, 3, 4", "2")
        .option("--frames-per-image [value]", "Frames per PNG: 1, 4, 8, 16, 32", "16")
        .option("--difference <percent>", "Skip samples below this changed-pixel percentage", "0")
        .option("--start <seconds>", "Start sampling at this original timestamp (inclusive)")
        .option("--end <seconds>", "Stop sampling at this original timestamp (exclusive)")
        .option("--out <directory>", "Output root, with a new immutable generation per run")
        .option("--json", "Print the generation manifest")
        .action(
            async (
                input: string,
                options: {
                    fps: string | boolean;
                    framesPerImage: string | boolean;
                    difference: string;
                    start?: string;
                    end?: string;
                    out?: string;
                }
            ) => {
                for (const [flag, value, allowed] of [
                    ["--fps", options.fps, VIDEO_FPS],
                    ["--frames-per-image", options.framesPerImage, VIDEO_GROUPS],
                ] as const) {
                    if (typeof value !== "string" || !allowed.some((number) => number === Number(value))) {
                        out.log.error(suggestEnumFlag("tools video frames", flag, allowed.map(String)));
                        process.exitCode = 1;
                        return;
                    }
                }

                const parsed = videoSettingsSchema.safeParse({
                    fps: Number(options.fps),
                    framesPerImage: Number(options.framesPerImage),
                    minimumDifferencePct: Number(options.difference),
                    startUs: options.start === undefined ? undefined : secondsToMicroseconds(options.start),
                    endUs: options.end === undefined ? undefined : secondsToMicroseconds(options.end),
                });
                if (!parsed.success) {
                    out.log.error(parsed.error.issues.map((issue) => issue.message).join("; "));
                    process.exitCode = 1;
                    return;
                }
                const settings = parsed.data;
                await withInterrupt(
                    async (signal) => {
                        const manifest = await prepareVideoEvidence({
                            input,
                            settings,
                            signal,
                            outputRoot: options.out ? resolve(options.out) : toolDataDir("video", "evidence"),
                        });
                        out.result(manifest);
                    },
                    { handleTermination: true }
                );
            }
        );
}

if (import.meta.main) {
    const program = new Command().name("video").description("Local video inspection and evidence preparation");
    registerVideoCommands(program);
    await runTool(program, { tool: "video" });
}
