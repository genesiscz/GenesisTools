import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { isInteractive, parseByteSize, parseNonNegativeInt } from "@genesiscz/utils/cli";
import { pickEnumFlag } from "@genesiscz/utils/cli/enum-flag";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { formatBytes, formatDuration } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { createBoxTable } from "@genesiscz/utils/table";
import { primaryVideo, readMediaFacts } from "@genesiscz/utils/video/media-facts";
import { buildCompareGrid, measureQuality, type QualityScore } from "@genesiscz/utils/video/quality";
import {
    type AudioRequest,
    findEncoder,
    isVideoPreset,
    parseAudioRequest,
    TARGET_BAND,
    VIDEO_PRESET_NAMES,
    VIDEO_PRESETS,
    type VideoPreset,
} from "@genesiscz/utils/video/reencode";
import type { Command } from "commander";
import pc from "picocolors";
import { type EncodeRow, encodeVideos } from "../encode";
import { createEncodeReporter, ENCODE_FORMATS, isEncodeFormat } from "../encode-progress";
import {
    availablePresets,
    cutReferences,
    formatClock,
    type HeightRequest,
    missesTarget,
    type PresetPreview,
    planShrink,
    previewPresets,
    type References,
    recommendFromPreviews,
    type ShrinkPlan,
    type ShrinkStep,
    settleHeight,
} from "./preview";
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

function audioRequestOf(plan: ShrinkPlan): AudioRequest {
    return plan.audio.kind === "copy" ? "copy" : plan.audio.kbps;
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
    const workDir = mkdtempSync(join(tmpdir(), "genesis-shrink-"));
    let keepWorkDir = false;

    try {
        spinner?.start("Reading the video");
        const facts = await readMediaFacts({ input, signal });
        let plan = await planShrink({ facts, targetBytes, heightRequest, audioRequest, windowSec, signal });
        spinner?.stop("Plan ready");
        emit({ type: "plan", ...planJson(plan) });

        if (text) {
            renderPlan(plan, targetBytes);
        }

        const wanted: VideoPreset[] = preset ? [preset] : [...VIDEO_PRESET_NAMES];
        const { usable, skipped } = await availablePresets(wanted);

        for (const skip of skipped) {
            out.log.warn(`${skip.preset}: ${skip.reason}`);
        }

        if (usable.length === 0) {
            out.log.error("No preset can run on this machine.");
            process.exitCode = 1;
            return;
        }

        let previews: PresetPreview[] = [];
        let references: References = new Map();

        if (flags.preview) {
            spinner?.start("Cutting the sample windows");
            const onStep = (step: ShrinkStep) => {
                if (step.type === "step") {
                    spinner?.message(step.message);
                }

                emit(step);
            };
            references = await cutReferences({ plan, workDir, onStep, signal });

            if (plan.heightAuto) {
                plan = await settleHeight({ plan, references, workDir, onStep, signal });
                emit({ type: "height", height: plan.height });

                if (text) {
                    spinner?.stop("Height measured");
                    out.log.info(
                        `Picture: ${plan.height.height === undefined ? "source size" : `${plan.height.height}p`} (${plan.height.reason}).`
                    );
                    spinner?.start("Encoding the sample windows");
                }
            }

            previews = await previewPresets({ plan, references, presets: usable, workDir, onStep, signal });
            spinner?.stop(
                `Tried ${previews.length} preset${previews.length === 1 ? "" : "s"} on ${plan.windows.length} windows`
            );
        }

        const recommendation = previews.length > 1 ? recommendFromPreviews(plan, previews) : null;
        const recommended = preset ?? recommendation?.preset ?? (flags.preview ? previews[0]?.preset : "compatible");
        emit({ type: "previews", previews: previews.map(previewJson), recommendation });

        if (text && previews.length > 0) {
            renderPreviews({ plan, previews, recommended });

            if (recommendation) {
                out.log.info(`Recommended: ${pc.green(recommendation.preset)}, ${recommendation.reason}.`);
            }
        }

        let compareGrid: string | null = null;
        const hardest = references.get("hardest") ?? [...references.values()][0];

        if (flags.compare && hardest && previews.length > 0) {
            spinner?.start("Building the comparison video");
            compareGrid = join(dirname(input), `${basename(input, extname(input))}.compare.mp4`);
            const label = references.has("hardest") ? "hardest" : plan.windows[0]?.label;
            const encodes = previews.flatMap((preview) =>
                preview.windows.filter((w) => w.label === label).map((w) => w.path)
            );
            const sourceHeight = primaryVideo(facts)?.height ?? 720;
            await buildCompareGrid({
                reference: hardest,
                encodes,
                output: compareGrid,
                cellHeight: Math.min(sourceHeight, 720),
                signal,
            });
            spinner?.stop(`Comparison: ${compareGrid}`);

            if (text) {
                out.log.info(
                    `Cells, left to right, top to bottom: source, ${previews.map((preview) => preview.preset).join(", ")}.`
                );
            }

            openInPlayer(compareGrid);
        }

        if (flags.previewOnly) {
            finishJson({ format, plan, previews, recommendation, compareGrid, chosen: null, row: null, final: null });
            return;
        }

        const chosen = preset ?? (await choosePreset({ flags, previews, recommended }));

        if (!chosen) {
            if (!isInteractive() && !flags.yes) {
                out.log.info(
                    `Not a terminal, so nothing was encoded. Encode the recommendation: ${tool} ${input} ${flags.to ? `--to ${flags.to} ` : ""}--yes`
                );
            }

            finishJson({ format, plan, previews, recommendation, compareGrid, chosen: null, row: null, final: null });
            return;
        }

        const encoder = findEncoder(VIDEO_PRESETS[chosen]);

        if (!encoder) {
            process.exitCode = 1;
            return;
        }

        const reporter = createEncodeReporter({ format, progress: flags.progress === true || text, files: 1 });
        const rows = await encodeVideos({
            paths: [input],
            encoder,
            quality: encoder.defaultQuality,
            targetBytes,
            height: plan.height.height,
            audio: audioRequestOf(plan),
            jobs: 1,
            minSavingPct: 0,
            replace: flags.replace === true,
            dryRun: false,
            signal,
            onProgress: reporter.onProgress,
            onRow: format === "jsonl" ? reporter.onRow : undefined,
        }).finally(() => reporter.stop());
        const row = rows[0] ?? null;
        const final =
            row?.output && isWritten(row) ? await verifyFinal({ plan, references, output: row.output, signal }) : null;

        if (!row || !isWritten(row)) {
            out.log.error(`The encode did not finish: ${row?.reason ?? "no result"}`);
            process.exitCode = 1;
        } else if (text) {
            renderFinal({ row, targetBytes, final, previews, chosen });
        }

        finishJson({ format, plan, previews, recommendation, compareGrid, chosen, row, final });
    } catch (error) {
        spinner?.stop("Stopped");

        if (signal.aborted) {
            process.exitCode = 130;
            return;
        }

        keepWorkDir = true;
        logger.warn({ error, input, workDir }, "shrink failed");
        out.log.error(`${error instanceof Error ? error.message : String(error)} (samples kept in ${workDir})`);
        process.exitCode = 1;
    } finally {
        if (!keepWorkDir) {
            rmSync(workDir, { recursive: true, force: true });
        }
    }
}

function isWritten(row: EncodeRow): boolean {
    return row.status === "kept" || row.status === "kept-beside";
}

interface FinalCheck {
    windows: ({ label: string } & QualityScore)[];
}

async function verifyFinal({
    plan,
    references,
    output,
    signal,
}: {
    plan: ShrinkPlan;
    references: Map<string, string>;
    output: string;
    signal: AbortSignal;
}): Promise<FinalCheck | null> {
    if (references.size === 0) {
        return null;
    }

    const windows: FinalCheck["windows"] = [];

    for (const window of plan.windows) {
        const reference = references.get(window.label);

        if (reference) {
            windows.push({
                label: window.label,
                ...(await measureQuality({ distorted: output, reference, distortedWindow: window, signal })),
            });
        }
    }

    return { windows };
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
