import { resolve } from "node:path";
import { parseByteSize, parseNonNegativeInt, runTool, suggestEnumFlag } from "@genesiscz/utils/cli";
import { pickEnumFlag } from "@genesiscz/utils/cli/enum-flag";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { out } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { prepareVideoEvidence } from "@genesiscz/utils/video/evidence";
import { probeVideo } from "@genesiscz/utils/video/probe";
import {
    type AudioRequest,
    encoderUnavailableReason,
    findEncoder,
    isVideoEncoderCodec,
    isVideoPreset,
    parseAudioRequest,
    VIDEO_ENCODER_CODECS,
    VIDEO_ENCODERS,
    VIDEO_PRESET_NAMES,
    VIDEO_PRESETS,
} from "@genesiscz/utils/video/reencode";
import { secondsToMicroseconds } from "@genesiscz/utils/video/sampling";
import { VIDEO_FPS, VIDEO_GROUPS, videoSettingsSchema } from "@genesiscz/utils/video/types";
import { Command } from "commander";
import { collectInputs, encodeVideos, exitCodeFor, renderRows, summarize } from "./encode";
import { createEncodeReporter, ENCODE_FORMATS, isEncodeFormat } from "./encode-progress";
import { registerShrinkCommand } from "./shrink/command";
import { registerStreamCommands } from "./stream/command";

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
            "Re-encode videos (HEVC on the GPU by default, or x264, x265 or AV1 on the CPU), keeping a result only when it is verified"
        )
        .option(
            "--preset [name]",
            `A named starting point: ${VIDEO_PRESET_NAMES.map((name) => `${name} (${VIDEO_PRESETS[name]})`).join(", ")}`
        )
        .option(
            "--quality <n>",
            `Constant quality in the encoder's own scale, ignored with --target-size. ${VIDEO_ENCODER_CODECS.map((codec) => `${codec}: ${VIDEO_ENCODERS[codec].qualityHelp}, default ${VIDEO_ENCODERS[codec].defaultQuality}`).join("; ")}`
        )
        .option(
            "--codec [name]",
            `Target encoder (default hevc): ${VIDEO_ENCODER_CODECS.map((codec) => `${codec}: ${VIDEO_ENCODERS[codec].label}`).join("; ")}`
        )
        .option("--jobs <n>", "Files encoded at once (the hardware encoder has few sessions)", "2")
        .option("--min-saving <percent>", "Discard an output that is less than this much smaller", "25")
        .option(
            "--target-size <size>",
            "Aim each output at this size (400MB, 1.5GB; a bare number is MB) instead of --quality; the video gets what the audio leaves, and a missed size is corrected by up to two more passes"
        )
        .option("--height <px>", "Scale a taller video down to this height (Lanczos, which beat the GPU scaler)")
        .option(
            "--audio <mode>",
            "auto (copy, but re-encode to AAC 96 kbit/s when copied audio would take over 15% of --target-size), copy, or an AAC bitrate in kbit/s",
            "auto"
        )
        .option(
            "--replace",
            'Put the result at the original path and move the original to the GenesisTools trash. An agent cannot replace a file the rm rules mark "ask": the result stays beside it. A bare trash restore refuses while the new file sits at the original path: move it to <name>.hevc.<ext> first. The summary prints the undo line, which never writes over an existing <name>.hevc.<ext>'
        )
        .option("--dry-run", "List what would happen, with input sizes and skip reasons; write nothing")
        .option(
            "--progress",
            "Report each encode as it runs: a bar in a terminal, JSON lines with --format json (stderr) or jsonl (stdout)"
        )
        .option("--format [value]", `Output: ${ENCODE_FORMATS.join(", ")} (jsonl streams one row per finished file)`)
        .option("--json", "Print one row per file (same as --format json)")
        .action(
            async (
                paths: string[],
                options: {
                    quality?: string;
                    codec?: string | boolean;
                    preset?: string | boolean;
                    jobs: string;
                    minSaving: string;
                    targetSize?: string;
                    height?: string;
                    audio: string;
                    replace?: boolean;
                    dryRun?: boolean;
                    progress?: boolean;
                    format?: string | boolean;
                    json?: boolean;
                }
            ) => {
                if (options.preset !== undefined && options.codec !== undefined) {
                    out.log.error("Pass --preset or --codec, not both: a preset names its encoder.");
                    process.exitCode = 1;
                    return;
                }

                const preset =
                    options.preset === undefined
                        ? undefined
                        : await pickEnumFlag({
                              tool: toolCommand("video", "encode"),
                              subcommand: ["encode"],
                              flag: "--preset",
                              given: options.preset,
                              values: VIDEO_PRESET_NAMES,
                              fallback: "fast",
                              accepts: isVideoPreset,
                          });

                if (preset === null) {
                    process.exitCode = 1;
                    return;
                }

                const codec = preset
                    ? VIDEO_PRESETS[preset]
                    : await pickEnumFlag({
                          tool: toolCommand("video", "encode"),
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

                const quality = options.quality === undefined ? encoder.defaultQuality : Number(options.quality);
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

                let targetBytes: number | undefined;
                let height: number | undefined;
                let audio: AudioRequest;

                try {
                    audio = parseAudioRequest(options.audio);
                    targetBytes =
                        options.targetSize === undefined
                            ? undefined
                            : parseByteSize(options.targetSize, "--target-size");
                    height = options.height === undefined ? undefined : parseNonNegativeInt(options.height, "--height");
                } catch (error) {
                    out.log.error(error instanceof Error ? error.message : String(error));
                    process.exitCode = 1;
                    return;
                }

                if (height !== undefined && (height < 144 || height % 2 !== 0)) {
                    out.log.error("--height must be an even number of pixels, 144 or more.");
                    process.exitCode = 1;
                    return;
                }

                const format = await pickEnumFlag({
                    tool: toolCommand("video", "encode"),
                    subcommand: ["encode"],
                    flag: "--format",
                    given: options.format ?? (options.json ? "json" : undefined),
                    values: ENCODE_FORMATS,
                    fallback: "text",
                    accepts: isEncodeFormat,
                });

                if (format === null) {
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
                        const reporter = createEncodeReporter({
                            format,
                            progress: options.progress === true && options.dryRun !== true,
                            files: collectInputs({ paths, encoder }).length,
                        });
                        const rows = await encodeVideos({
                            paths,
                            encoder,
                            quality,
                            targetBytes,
                            height,
                            audio,
                            jobs,
                            minSavingPct,
                            replace: options.replace === true,
                            dryRun: options.dryRun === true,
                            signal,
                            onProgress: reporter.onProgress,
                            onRow: reporter.onRow,
                        }).finally(() => reporter.stop());

                        const exitCode = exitCodeFor(rows);

                        if (exitCode !== 0) {
                            process.exitCode = exitCode;
                        }

                        if (format === "jsonl") {
                            return;
                        }

                        if (format === "json") {
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
    registerShrinkCommand(program);
    registerStreamCommands(program);
}

if (import.meta.main) {
    const program = new Command()
        .name("video")
        .description("Local video inspection, evidence preparation and HLS stream downloads");
    registerVideoCommands(program);
    await runTool(program, { tool: "video" });
}
