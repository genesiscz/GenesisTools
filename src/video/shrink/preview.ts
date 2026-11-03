import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { type MediaFacts, primaryVideo } from "@genesiscz/utils/video/media-facts";
import {
    cutReference,
    hasVmaf,
    measureQuality,
    pickSampleWindows,
    readVideoPackets,
    type SampleWindow,
} from "@genesiscz/utils/video/quality";
import {
    type AudioPlan,
    type AudioRequest,
    audioBytes,
    encodeArgs,
    encoderUnavailableReason,
    findEncoder,
    MAX_SIZE_CORRECTIONS,
    MIN_TARGET_VIDEO_KBPS,
    planAudio,
    TARGET_BAND,
    VIDEO_PRESETS,
    type VideoEncoder,
    type VideoPreset,
    type VideoRate,
    videoKbpsForTarget,
} from "@genesiscz/utils/video/reencode";
import {
    chooseHeight,
    type HeightChoice,
    nextTallerHeight,
    type PresetScore,
    previewCorrection,
    type Recommendation,
    recommendPreset,
    windowKbps,
} from "./recommend";

/** What `--height` asked for: a number, `auto` (only acts with a size target), or `source`. */
export type HeightRequest = number | "auto" | "source";

export interface ShrinkPlan {
    facts: MediaFacts;
    audio: AudioPlan;
    /** The size target, when one was given. */
    targetBytes?: number;
    /** The video bitrate a size target leaves, or null without one. */
    kbps: number | null;
    height: HeightChoice;
    /** `--height auto` with a size target: `settleHeight` may still measure one step taller. */
    heightAuto: boolean;
    windows: SampleWindow[];
    /** The source's video bytes over the whole file. */
    sourceVideoBytes: number;
}

export interface WindowResult {
    label: SampleWindow["label"];
    path: string;
    bytes: number;
    /** The bytes the window's share of a size target allows; null without a target. */
    plannedBytes: number | null;
    encodeSec: number;
    vmaf: number | null;
    ssim: number;
}

export interface PresetPreview {
    preset: VideoPreset;
    encoder: VideoEncoder;
    windows: WindowResult[];
    vmaf: number | null;
    minVmaf: number | null;
    ssim: number;
    predictedBytes: number;
    predictedSeconds: number;
}

export interface PresetSkip {
    preset: VideoPreset;
    reason: string;
}

export type ShrinkStep =
    | { type: "step"; message: string }
    | { type: "window"; preset: VideoPreset; label: SampleWindow["label"]; vmaf: number | null; ssim: number };

/** Sizes the plan: the audio, the bitrate the target leaves, the height that bitrate fits, and the windows to try. */
export async function planShrink({
    facts,
    targetBytes,
    heightRequest,
    audioRequest,
    windowSec,
    signal,
}: {
    facts: MediaFacts;
    targetBytes?: number;
    heightRequest: HeightRequest;
    audioRequest: AudioRequest;
    windowSec: number;
    signal?: AbortSignal;
}): Promise<ShrinkPlan> {
    const video = primaryVideo(facts);

    if (!video || !facts.durationSec) {
        throw new Error(`${facts.path} has no video stream with a duration`);
    }

    const audio = planAudio({ facts, request: audioRequest, targetBytes });
    const kbps = targetBytes === undefined ? null : videoKbpsForTarget({ facts, targetBytes, audio });

    if (kbps !== null && kbps < MIN_TARGET_VIDEO_KBPS) {
        throw new Error(
            `the size target leaves ${Math.max(0, kbps)} kbit/s for the video, below ${MIN_TARGET_VIDEO_KBPS}; pick a larger --to`
        );
    }

    const height = resolveHeight({ request: heightRequest, video, kbps });
    const packets = await readVideoPackets({ input: facts.path, signal });
    const windows = pickSampleWindows({ packets, durationSec: facts.durationSec, windowSec });
    const sourceVideoBytes = packets.reduce((sum, packet) => sum + packet.bytes, 0);
    logger.debug({ input: facts.path, audio, kbps, height, windows }, "Shrink plan");
    const heightAuto = heightRequest === "auto" && kbps !== null && height.height !== undefined;
    return { facts, audio, targetBytes, kbps, height, heightAuto, windows, sourceVideoBytes };
}

function resolveHeight({
    request,
    video,
    kbps,
}: {
    request: HeightRequest;
    video: NonNullable<ReturnType<typeof primaryVideo>>;
    kbps: number | null;
}): HeightChoice {
    if (request === "source") {
        return { height: undefined, reason: "--height source" };
    }

    if (typeof request === "number") {
        return video.height !== undefined && video.height <= request
            ? { height: undefined, reason: `the source is already ${video.height}p` }
            : { height: request, reason: `--height ${request}` };
    }

    if (kbps === null || !video.width || !video.height || !video.frameRate) {
        return { height: undefined, reason: "no size target, so the source size stays" };
    }

    return chooseHeight({ kbps, width: video.width, height: video.height, fps: video.frameRate });
}

/** The presets this machine can run, and why the others cannot. */
export async function availablePresets(
    presets: readonly VideoPreset[]
): Promise<{ usable: VideoPreset[]; skipped: PresetSkip[] }> {
    const usable: VideoPreset[] = [];
    const skipped: PresetSkip[] = [];

    for (const preset of presets) {
        const encoder = findEncoder(VIDEO_PRESETS[preset]);
        const reason = encoder ? await encoderUnavailableReason(encoder) : `no encoder ${VIDEO_PRESETS[preset]}`;

        if (reason) {
            skipped.push({ preset, reason });
        } else {
            usable.push(preset);
        }
    }

    return { usable, skipped };
}

/** Encodes one reference window with one encoder, two passes when the encoder has them; returns the seconds it took. */
async function encodeWindow({
    encoder,
    reference,
    output,
    rate,
    height,
    statsPrefix,
    signal,
}: {
    encoder: VideoEncoder;
    reference: string;
    output: string;
    rate: VideoRate;
    height: number | undefined;
    statsPrefix: string;
    signal?: AbortSignal;
}): Promise<number> {
    const passes =
        rate.kind === "bitrate" && encoder.twoPass
            ? ([1, 2] as const).map((index) => ({ index, logFile: statsPrefix }))
            : [undefined];
    const started = performance.now();

    for (const pass of passes) {
        const result = await boundedCommand({
            command: encodeArgs({ encoder, input: reference, output, rate, height, pass }),
            timeoutMs: 30 * 60_000,
            signal,
        });

        if (result.error || result.status !== 0) {
            throw new Error(
                `${encoder.ffmpegName} failed on a preview window: ${result.error?.message ?? result.stderr.trim()}`
            );
        }
    }

    return (performance.now() - started) / 1000;
}

function mean(values: number[]): number {
    return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

/** A window's rate: the encoder's default quality, or its two-pass share of the size target (`windowKbps`). */
function windowRate({ plan, window, quality }: { plan: ShrinkPlan; window: SampleWindow; quality: number }): VideoRate {
    if (plan.kbps === null) {
        return { kind: "quality", quality };
    }

    const durationSec = plan.facts.durationSec ?? 0;
    const overallSourceKbps = durationSec > 0 ? (plan.sourceVideoBytes * 8) / durationSec / 1000 : 0;
    return {
        kind: "bitrate",
        kbps: windowKbps({ kbps: plan.kbps, windowSourceKbps: window.sourceKbps, overallSourceKbps }),
    };
}

/** Lossless cuts of each window, by window label. */
export type References = Map<SampleWindow["label"], string>;

/** Cuts each window once as a lossless reference; every encode and every score uses these. */
export async function cutReferences({
    plan,
    workDir,
    onStep,
    signal,
}: {
    plan: ShrinkPlan;
    workDir: string;
    onStep?: (step: ShrinkStep) => void;
    signal?: AbortSignal;
}): Promise<References> {
    mkdirSync(workDir, { recursive: true });
    const references: References = new Map();

    for (const window of plan.windows) {
        const path = join(workDir, `reference-${window.label}.mkv`);
        onStep?.({ type: "step", message: `cutting the ${window.label} window at ${formatClock(window.startSec)}` });
        await cutReference({ input: plan.facts.path, window, output: path, signal });
        references.set(window.label, path);
    }

    return references;
}

/** The score a ranking uses: VMAF, or SSIM in decibels when this ffmpeg has no libvmaf. */
function rankScore(score: { vmaf: number | null; ssim: number }): number {
    return score.vmaf ?? -10 * Math.log10(Math.max(1e-6, 1 - score.ssim));
}

/**
 * `--height auto` measures instead of trusting the bits-per-pixel rule alone: the rule's height and one step taller
 * encode the hardest and the median window with x264 at the plan's bitrate, and the better mean score keeps its
 * height. At the edge of the rule (720p at 30 fps and 410 kbit/s is 0.0148) either side can win.
 */
export async function settleHeight({
    plan,
    references,
    workDir,
    onStep,
    signal,
}: {
    plan: ShrinkPlan;
    references: References;
    workDir: string;
    onStep?: (step: ShrinkStep) => void;
    signal?: AbortSignal;
}): Promise<ShrinkPlan> {
    const sourceHeight = primaryVideo(plan.facts)?.height;
    const ruled = plan.height.height;
    const encoder = findEncoder(VIDEO_PRESETS.compatible);

    if (!plan.heightAuto || plan.kbps === null || ruled === undefined || !sourceHeight || !encoder) {
        return plan;
    }

    if (await encoderUnavailableReason(encoder)) {
        return plan;
    }

    const taller = nextTallerHeight(ruled, sourceHeight);
    const windows = plan.windows.filter((window) => window.label !== "easiest");
    const scores: { height: number | undefined; score: number }[] = [];

    for (const height of [ruled, taller]) {
        const values: number[] = [];

        for (const window of windows) {
            const reference = references.get(window.label);

            if (!reference) {
                continue;
            }

            const name = `${height ?? sourceHeight}p`;
            onStep?.({ type: "step", message: `trying ${name} on the ${window.label} window` });
            const output = join(workDir, `height-${name}-${window.label}.mp4`);
            await encodeWindow({
                encoder,
                reference,
                output,
                rate: windowRate({ plan, window, quality: encoder.defaultQuality }),
                height,
                statsPrefix: join(workDir, `height-${name}-${window.label}-2pass`),
                signal,
            });
            values.push(rankScore(await measureQuality({ distorted: output, reference, signal })));
        }

        scores.push({ height, score: mean(values) });
    }

    const best = scores.reduce((top, entry) => (entry.score > top.score ? entry : top));
    const unit = (await hasVmaf()) ? "VMAF" : "SSIM dB";
    const reason = `measured with x264 on the hardest and median windows: ${scores.map((entry) => `${entry.height ?? sourceHeight}p ${unit} ${entry.score.toFixed(1)}`).join(", ")}`;
    logger.debug({ scores, best }, "Settled the height");
    return { ...plan, heightAuto: false, height: { height: best.height, reason } };
}

/**
 * Encodes each reference window with every preset at the plan's bitrate (or each encoder's default quality), scores
 * each encode against its reference, and extrapolates size and time to the whole file. The windows are short, so a
 * size target here is the average rate, not a per-window size.
 */
export async function previewPresets({
    plan,
    references,
    presets,
    workDir,
    onStep,
    signal,
}: {
    plan: ShrinkPlan;
    references: References;
    presets: VideoPreset[];
    workDir: string;
    onStep?: (step: ShrinkStep) => void;
    signal?: AbortSignal;
}): Promise<PresetPreview[]> {
    const durationSec = plan.facts.durationSec ?? 0;
    const previews: PresetPreview[] = [];

    for (const preset of presets) {
        const encoder = findEncoder(VIDEO_PRESETS[preset]);

        if (!encoder) {
            continue;
        }

        const windows: WindowResult[] = [];

        for (const window of plan.windows) {
            const reference = references.get(window.label);

            if (!reference) {
                continue;
            }

            onStep?.({ type: "step", message: `${preset}: encoding the ${window.label} window` });
            const planned = windowRate({ plan, window, quality: encoder.defaultQuality });
            // The window's share of the target, fixed before the first attempt: every correction is measured against
            // it, never against the bytes of its own corrected rate.
            const plannedBytes = planned.kind === "bitrate" ? (planned.kbps * 1000 * window.durationSec) / 8 : null;
            let rate = planned;
            let encodeSec: number | null = null;
            let output = "";
            let bytes = 0;

            // The same correction the full encode makes (encodeVideos), so a preset that misses its rate is previewed
            // at the settings, and the size, it will end with.
            for (let attempt = 0; ; attempt++) {
                output = join(workDir, `${preset}-${window.label}-${attempt}.mp4`);
                const sec = await encodeWindow({
                    encoder,
                    reference,
                    output,
                    rate,
                    height: plan.height.height,
                    statsPrefix: join(workDir, `${preset}-${window.label}-2pass`),
                    signal,
                });
                // Only the first attempt times the encoder; corrections here are a short window's rate noise.
                encodeSec ??= sec;
                bytes = statSync(output).size;

                if (rate.kind !== "bitrate" || plannedBytes === null || attempt >= MAX_SIZE_CORRECTIONS) {
                    break;
                }

                const next = previewCorrection({ kbps: rate.kbps, bytes, plannedBytes });

                if (next === null) {
                    break;
                }

                rate = { kind: "bitrate", kbps: next, attempt: attempt + 1 };
                onStep?.({
                    type: "step",
                    message: `${preset}: the ${window.label} window missed its size, correcting`,
                });
            }

            onStep?.({ type: "step", message: `${preset}: scoring the ${window.label} window` });
            const score = await measureQuality({ distorted: output, reference, signal });
            windows.push({
                label: window.label,
                path: output,
                bytes,
                plannedBytes,
                encodeSec: encodeSec ?? 0,
                ...score,
            });
            onStep?.({ type: "window", preset, label: window.label, ...score });
        }

        const vmafs = windows.flatMap((window) => (window.vmaf === null ? [] : [window.vmaf]));
        const ratio = mean(
            windows.map((window) => {
                const source = plan.windows.find((entry) => entry.label === window.label);
                return source && source.sourceBytes > 0 ? window.bytes / source.sourceBytes : 1;
            })
        );
        const windowSec = plan.windows.reduce((sum, window) => sum + window.durationSec, 0);
        const encodeSec = windows.reduce((sum, window) => sum + window.encodeSec, 0);
        // Under a size target each window is measured against the bytes it was meant to take, so a preset that cannot
        // reach the rate shows the size it will really have.
        const overshoot = mean(windows.map((window) => (window.plannedBytes ? window.bytes / window.plannedBytes : 1)));
        const predictedVideo =
            plan.kbps === null ? plan.sourceVideoBytes * ratio : ((plan.kbps * 1000 * durationSec) / 8) * overshoot;
        previews.push({
            preset,
            encoder,
            windows,
            vmaf: vmafs.length === windows.length && vmafs.length > 0 ? mean(vmafs) : null,
            minVmaf: vmafs.length === windows.length && vmafs.length > 0 ? Math.min(...vmafs) : null,
            ssim: mean(windows.map((window) => window.ssim)),
            predictedBytes: Math.round((predictedVideo + audioBytes(plan.facts, plan.audio)) * 1.01),
            predictedSeconds: windowSec > 0 ? (encodeSec / windowSec) * durationSec : 0,
        });
    }

    return previews;
}

/**
 * The recommendation over finished previews: VMAF when every preset has it, otherwise SSIM in decibels
 * (-10 log10(1 - SSIM)), where 0.993 against 0.995 is about 1.5 dB, a gap the VMAF margins also fit.
 */
export function recommendFromPreviews(plan: ShrinkPlan, previews: PresetPreview[]): Recommendation | null {
    const fits = previews.filter((preview) => !missesTarget(plan, preview));
    const pool = fits.length > 0 ? fits : previews;
    const useVmaf = pool.every((preview) => preview.vmaf !== null);
    const scores: PresetScore[] = pool.map((preview) => ({
        preset: preview.preset,
        score: useVmaf ? rankScore(preview) : rankScore({ vmaf: null, ssim: preview.ssim }),
        predictedSeconds: preview.predictedSeconds,
    }));
    const recommendation = recommendPreset(scores);
    const dropped = previews.filter((preview) => !pool.includes(preview)).map((preview) => preview.preset);

    if (recommendation && dropped.length > 0) {
        return { ...recommendation, reason: `${recommendation.reason}; ${dropped.join(", ")} cannot reach the size` };
    }

    return recommendation;
}

/** A preview whose predicted size is over the target's band: it would write a bigger file than asked for. */
export function missesTarget(plan: ShrinkPlan, preview: PresetPreview): boolean {
    return plan.targetBytes !== undefined && preview.predictedBytes > plan.targetBytes * TARGET_BAND.high * 1.07;
}

export function formatClock(seconds: number): string {
    const whole = Math.max(0, Math.floor(seconds));
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const s = whole % 60;
    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}
