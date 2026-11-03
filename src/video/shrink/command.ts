import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { isInteractive, parseByteSize, parseNonNegativeInt } from "@genesiscz/utils/cli";
import { pickEnumFlag } from "@genesiscz/utils/cli/enum-flag";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { formatBytes, formatDuration } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { createBoxTable } from "@genesiscz/utils/table";
import { primaryVideo } from "@genesiscz/utils/video/media-facts";
import {
    type AudioRequest,
    isVideoPreset,
    parseAudioRequest,
    TARGET_BAND,
    VIDEO_PRESET_NAMES,
    type VideoPreset,
} from "@genesiscz/utils/video/reencode";
import type { Command } from "commander";
import pc from "picocolors";
import type { EncodeRow } from "../encode";
import { createEncodeReporter, ENCODE_FORMATS, isEncodeFormat } from "../encode-progress";
import {
    type FinalCheck,
    isWritten,
    runShrinkWorkflow,
    type ShrinkEvent,
    ShrinkFailedError,
    type ShrinkOutcome,
} from "../lib/shrink";
import { formatClock, type HeightRequest, missesTarget, type PresetPreview, type ShrinkPlan } from "./preview";
import { PRESET_TRADE } from "./recommend";

interface ShrinkFlags {
    to?: string;
    height: string;
    audio: string;
    preset?: string | boolean;
    window: string;
    yes?: boolean;
    previewOnly?: boolean;
    preview: boolean;
    compare?: boolean;
    replace?: boolean;
    progress?: boolean;
    format?: string | boolean;
    json?: boolean;
}

export function registerShrinkCommand(program: Command): void {
    program
        .command("shrink <file>")
        .description(
            "Make a video smaller without guessing ffmpeg settings: it tries every preset on the hardest, a typical and the easiest 10 s of the video, scores each against the source (VMAF and SSIM), shows the size, time and quality of each, recommends one, encodes it and checks the result"
        )
        .option("--to <size>", "Fit the whole file into this size (400MB, 1.5GB; a bare number is MB)")
        .option(
            "--height <px|auto|source>",
            "Picture height: auto picks the tallest height the size target can feed (0.015 bits per pixel), source keeps it",
            "auto"
        )
        .option(
            "--audio <mode>",
            "auto (copy, but AAC 96 kbit/s when copied audio would take over 15% of --to), copy, or an AAC bitrate in kbit/s",
            "auto"
        )
        .option(
            "--preset [name]",
            `Encode with this preset and preview only it: ${VIDEO_PRESET_NAMES.map((name) => `${name} (${PRESET_TRADE[name]})`).join("; ")}`
        )
        .option("--window <seconds>", "Length of each sample window", "10")
        .option("--yes", "Encode with the recommended preset without asking")
        .option("--preview-only", "Show the comparison and stop; encode nothing")
        .option("--no-preview", "Skip the sample encodes (needs --preset or --yes; --yes then takes compatible)")
        .option("--compare", "Write a 2x2 video of the hardest window (source, then each preset) and open it")
        .option("--replace", "Put the result at the original path; the original goes to the GenesisTools trash")
        .option("--progress", "Show the final encode's progress (a bar in a terminal, JSON lines otherwise)")
        .option("--format [value]", `Output: ${ENCODE_FORMATS.join(", ")}`)
        .option("--json", "Print the whole report as JSON (same as --format json)")
        .action(async (file: string, flags: ShrinkFlags) => {
            await withInterrupt((signal) => runShrink({ file, flags, signal }), { handleTermination: true });
        });
}

function parseHeight(value: string): HeightRequest {
    if (value === "auto" || value === "source") {
        return value;
    }

    const height = parseNonNegativeInt(value.replace(/p$/i, ""), "--height");

    if (height < 144 || height % 2 !== 0) {
        throw new Error("--height must be auto, source, or an even number of pixels, 144 or more.");
    }

    return height;
}

function scoreText(score: { vmaf: number | null; ssim: number }): string {
    return score.vmaf === null ? `SSIM ${score.ssim.toFixed(4)}` : `VMAF ${score.vmaf.toFixed(1)}`;
}

function renderPlan(plan: ShrinkPlan, targetBytes: number | undefined): void {
    const video = primaryVideo(plan.facts);
    const lines = [
        `${basename(plan.facts.path)}: ${formatBytes(plan.facts.bytes)}, ${formatDuration((plan.facts.durationSec ?? 0) * 1000)}, ${video?.width ?? "?"}x${video?.height ?? "?"} ${video?.codec ?? ""}`,
        targetBytes === undefined
            ? "No size target: each preset uses its default quality."
            : `Target ${formatBytes(targetBytes)}: ${plan.kbps} kbit/s for the video.`,
        `Picture: ${plan.height.height === undefined ? "source size" : `${plan.height.height}p`} (${plan.height.reason})${plan.heightAuto ? "; one step taller is measured next" : ""}.`,
        `Audio: ${plan.audio.kind === "copy" ? "copied" : `AAC ${plan.audio.kbps} kbit/s`}.`,
        `Windows: ${plan.windows.map((window) => `${window.label} at ${formatClock(window.startSec)} (${Math.round(window.sourceKbps)} kbit/s in the source)`).join(", ")}.`,
    ];
    out.log.info(lines.join("\n"));
}

function renderPreviews({
    plan,
    previews,
    recommended,
}: {
    plan: ShrinkPlan;
    previews: PresetPreview[];
    recommended: VideoPreset | undefined;
}): void {
    const table = createBoxTable(["PRESET", "QUALITY (MEAN / WORST)", "SSIM", "SIZE", "TIME", "TRADE"]);

    for (const preview of previews) {
        const name = preview.preset === recommended ? pc.green(`${preview.preset} ★`) : preview.preset;
        const quality =
            preview.vmaf === null || preview.minVmaf === null
                ? "no libvmaf"
                : `VMAF ${preview.vmaf.toFixed(1)} / ${preview.minVmaf.toFixed(1)}`;
        table.push([
            name,
            quality,
            preview.ssim.toFixed(4),
            missesTarget(plan, preview)
                ? pc.yellow(`~${formatBytes(preview.predictedBytes)} (over)`)
                : `~${formatBytes(preview.predictedBytes)}`,
            `~${formatDuration(preview.predictedSeconds * 1000)}`,
            PRESET_TRADE[preview.preset],
        ]);
    }

    out.println(table.toString());
    out.println(
        pc.dim(
            "VMAF: 95+ is hard to tell from the source, 90 is good, under 80 shows artifacts. WORST is the hardest window."
        )
    );
}

function openInPlayer(path: string): void {
    if (process.platform !== "darwin" || !isInteractive()) {
        return;
    }

    const child = spawn("open", [path], { stdio: "ignore", detached: true });
    child.on("error", (error) => logger.debug({ error, path }, "open could not start"));
    child.unref();
}

async function choosePreset({
    flags,
    previews,
    recommended,
}: {
    flags: ShrinkFlags;
    previews: PresetPreview[];
    recommended: VideoPreset | undefined;
}): Promise<VideoPreset | null> {
    if (flags.yes) {
        return recommended ?? "compatible";
    }

    if (!isInteractive()) {
        return null;
    }

    const order = [...previews].sort((a, b) => Number(b.preset === recommended) - Number(a.preset === recommended));
    const picked = await p.select({
        message: "Encode with which preset?",
        options: [
            ...order.map((preview) => ({
                value: preview.preset,
                label: `${preview.preset}${preview.preset === recommended ? " (recommended)" : ""}: ${scoreText(preview)}, ~${formatBytes(preview.predictedBytes)}, ~${formatDuration(preview.predictedSeconds * 1000)}`,
            })),
            { value: "none", label: "None, stop here" },
        ],
        initialValue: recommended,
    });
    const value = String(picked);
    return isVideoPreset(value) ? value : null;
}

async function runShrink({ file, flags, signal }: { file: string; flags: ShrinkFlags; signal: AbortSignal }) {
    const input = resolve(file);
    const tool = toolCommand("video", "shrink");
    const format = await pickEnumFlag({
        tool,
        subcommand: ["shrink"],
        flag: "--format",
        given: flags.format ?? (flags.json ? "json" : undefined),
        values: ENCODE_FORMATS,
        fallback: "text",
        accepts: isEncodeFormat,
    });

    if (format === null) {
        process.exitCode = 1;
        return;
    }

    const preset =
        flags.preset === undefined
            ? undefined
            : await pickEnumFlag({
                  tool,
                  subcommand: ["shrink"],
                  flag: "--preset",
                  given: flags.preset,
                  values: VIDEO_PRESET_NAMES,
                  fallback: "compatible",
                  accepts: isVideoPreset,
              });

    if (preset === null) {
        process.exitCode = 1;
        return;
    }

    let targetBytes: number | undefined;
    let heightRequest: HeightRequest;
    let audioRequest: AudioRequest;
    let windowSec: number;

    try {
        targetBytes = flags.to === undefined ? undefined : parseByteSize(flags.to, "--to");
        heightRequest = parseHeight(flags.height);
        audioRequest = parseAudioRequest(flags.audio);
        windowSec = parseNonNegativeInt(flags.window, "--window");

        if (windowSec < 2 || windowSec > 120) {
            throw new Error("--window takes 2 to 120 seconds.");
        }
    } catch (error) {
        out.log.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
        return;
    }

    if (!flags.preview && !preset && !flags.yes) {
        out.log.error("--no-preview needs --preset <name> or --yes, since nothing is measured to choose from.");
        process.exitCode = 1;
        return;
    }

    const text = format === "text";
    const emit = (event: object) => {
        if (format === "jsonl") {
            out.println(SafeJSON.stringify(event));
        }
    };
    const spinner = text ? out.spinner() : null;
    const onEvent = (event: ShrinkEvent) => {
        switch (event.type) {
            case "reading":
                spinner?.start("Reading the video");
                return;
            case "plan":
                spinner?.stop("Plan ready");
                emit({ type: "plan", ...planJson(event.plan) });

                if (text) {
                    renderPlan(event.plan, targetBytes);
                }

                return;
            case "skip":
                out.log.warn(`${event.skip.preset}: ${event.skip.reason}`);
                return;
            case "sampling":
                spinner?.start("Cutting the sample windows");
                return;
            case "step":
                spinner?.message(event.message);
                emit(event);
                return;
            case "window":
                emit(event);
                return;
            case "height":
                emit({ type: "height", height: event.plan.height });

                if (text) {
                    spinner?.stop("Height measured");
                    out.log.info(
                        `Picture: ${event.plan.height.height === undefined ? "source size" : `${event.plan.height.height}p`} (${event.plan.height.reason}).`
                    );
                    spinner?.start("Encoding the sample windows");
                }

                return;
            case "sampled":
                spinner?.stop(
                    `Tried ${event.previews.length} preset${event.previews.length === 1 ? "" : "s"} on ${event.plan.windows.length} windows`
                );
                return;
            case "previews":
                emit({
                    type: "previews",
                    previews: event.previews.map(previewJson),
                    recommendation: event.recommendation,
                });

                if (text && event.previews.length > 0) {
                    renderPreviews({ plan: event.plan, previews: event.previews, recommended: event.recommended });

                    if (event.recommendation) {
                        out.log.info(
                            `Recommended: ${pc.green(event.recommendation.preset)}, ${event.recommendation.reason}.`
                        );
                    }
                }

                return;
            case "comparing":
                spinner?.start("Building the comparison video");
                return;
            case "compared":
                spinner?.stop(`Comparison: ${event.path}`);

                if (text) {
                    out.log.info(
                        `Cells, left to right, top to bottom: source, ${event.previews.map((preview) => preview.preset).join(", ")}.`
                    );
                }

                openInPlayer(event.path);
                return;
        }
    };

    try {
        const outcome = await runShrinkWorkflow({
            input,
            targetBytes,
            heightRequest,
            audioRequest,
            windowSec,
            preset,
            preview: flags.preview,
            previewOnly: flags.previewOnly === true,
            compare: flags.compare === true,
            replace: flags.replace === true,
            signal,
            onEvent,
            choosePreset: ({ previews, recommended }) => choosePreset({ flags, previews, recommended }),
            startEncode: () => {
                const reporter = createEncodeReporter({ format, progress: flags.progress === true || text, files: 1 });
                return {
                    onProgress: reporter.onProgress,
                    onRow: format === "jsonl" ? reporter.onRow : undefined,
                    stop: () => reporter.stop(),
                };
            },
        });
        renderOutcome({ outcome, format, flags, tool, input, targetBytes });

        if (signal.aborted) {
            // Ctrl-C while the finished result was scored: the row above is reported, the run still ends as stopped.
            process.exitCode = 130;
        }
    } catch (error) {
        spinner?.stop("Stopped");

        if (signal.aborted) {
            process.exitCode = 130;
            return;
        }

        const workDir = error instanceof ShrinkFailedError ? error.workDir : undefined;
        logger.warn(
            { error: error instanceof ShrinkFailedError ? error.cause : error, input, workDir },
            "shrink failed"
        );
        out.log.error(
            `${error instanceof Error ? error.message : String(error)}${workDir ? ` (samples kept in ${workDir})` : ""}`
        );
        process.exitCode = 1;
    }
}

function renderOutcome({
    outcome,
    format,
    flags,
    tool,
    input,
    targetBytes,
}: {
    outcome: ShrinkOutcome;
    format: string;
    flags: ShrinkFlags;
    tool: string;
    input: string;
    targetBytes: number | undefined;
}): void {
    if (outcome.kind === "no-preset") {
        out.log.error("No preset can encode this file on this machine.");
        process.exitCode = 1;
        return;
    }

    const { plan, previews, recommendation, compareGrid } = outcome;
    const report = { format, plan, previews, recommendation, compareGrid };

    if (outcome.kind === "previewed") {
        finishJson({ ...report, chosen: null, row: null, final: null });
        return;
    }

    if (outcome.kind === "not-chosen") {
        if (!isInteractive() && !flags.yes) {
            out.log.info(
                `Not a terminal, so nothing was encoded. Encode the recommendation: ${tool} ${input} ${flags.to ? `--to ${flags.to} ` : ""}--yes`
            );
        }

        finishJson({ ...report, chosen: null, row: null, final: null });
        return;
    }

    if (outcome.kind === "no-encoder") {
        process.exitCode = 1;
        return;
    }

    const { row, final, chosen } = outcome;

    if (!row || !isWritten(row)) {
        out.log.error(`The encode did not finish: ${row?.reason ?? "no result"}`);
        process.exitCode = 1;
    } else if (format === "text") {
        renderFinal({ row, targetBytes, final, previews, chosen });
    }

    finishJson({ ...report, chosen, row, final });
}

function renderFinal({
    row,
    targetBytes,
    final,
    previews,
    chosen,
}: {
    row: EncodeRow;
    targetBytes: number | undefined;
    final: FinalCheck | null;
    previews: PresetPreview[];
    chosen: VideoPreset;
}): void {
    const bytes = row.output ? statSync(row.output).size : 0;
    const missed = targetBytes !== undefined && bytes > targetBytes * TARGET_BAND.high;
    const lines = [
        `${missed ? pc.yellow("Done, over the size") : pc.green("Done")}: ${row.output}`,
        `${formatBytes(bytes)}${targetBytes === undefined ? "" : ` (${((bytes / targetBytes) * 100).toFixed(0)}% of the target)`}, from ${formatBytes(row.inputBytes ?? 0)}.`,
    ];

    if (final) {
        const preview = previews.find((entry) => entry.preset === chosen);
        lines.push(
            `Quality of the result: ${final.windows
                .map((window) => {
                    const sample = preview?.windows.find((entry) => entry.label === window.label);
                    return `${window.label} ${scoreText(window)}${sample ? ` (sample ${scoreText(sample)})` : ""}`;
                })
                .join(", ")}.`
        );
    }

    out.log.info(lines.join("\n"));
}

function planJson(plan: ShrinkPlan) {
    return {
        input: plan.facts.path,
        bytes: plan.facts.bytes,
        durationSec: plan.facts.durationSec,
        videoKbps: plan.kbps,
        height: plan.height,
        audio: plan.audio,
        windows: plan.windows,
    };
}

function previewJson(preview: PresetPreview) {
    const { encoder, ...rest } = preview;
    return { ...rest, codec: encoder.codec };
}

function finishJson({
    format,
    plan,
    previews,
    ...rest
}: {
    format: string;
    plan: ShrinkPlan;
    previews: PresetPreview[];
    recommendation: unknown;
    compareGrid: string | null;
    chosen: VideoPreset | null;
    row: EncodeRow | null;
    final: FinalCheck | null;
}): void {
    const report = { plan: planJson(plan), previews: previews.map(previewJson), ...rest };

    if (format === "json") {
        out.result(report);
    } else if (format === "jsonl") {
        out.println(SafeJSON.stringify({ type: "result", ...report }));
    }
}
