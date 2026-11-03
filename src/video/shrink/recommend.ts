import type { VideoPreset } from "@genesiscz/utils/video/reencode";

/** What each preset trades, in one line for the table. */
export const PRESET_TRADE: Record<VideoPreset, string> = {
    fast: "GPU HEVC: minutes, not hours; plays on Apple devices and most TVs",
    compatible: "CPU H.264, two passes: plays everywhere, Drive preview included",
    small: "CPU AV1: the best picture per byte; needs a recent player",
};

/** Bits per pixel per frame below which a smaller picture looks better than a starved larger one. */
export const MIN_BITS_PER_PIXEL = 0.015;
const STANDARD_HEIGHTS = [2160, 1440, 1080, 720, 540, 480, 360];

/** The next standard height above `height` that is still below the source, or undefined for the source itself. */
export function nextTallerHeight(height: number, sourceHeight: number): number | undefined {
    return [...STANDARD_HEIGHTS].reverse().find((standard) => standard > height && standard < sourceHeight);
}

export interface HeightChoice {
    /** The height to scale to, or undefined to keep the source's. */
    height: number | undefined;
    reason: string;
}

function bitsPerPixel({ kbps, width, height, fps }: { kbps: number; width: number; height: number; fps: number }) {
    return (kbps * 1000) / (width * height * fps);
}

/**
 * The tallest standard height at which the video bitrate still gives `MIN_BITS_PER_PIXEL`. A 108 min 1080p talk at
 * 385 kbit/s gets 0.007 bits per pixel at 1080p and 0.017 at 720p, and 720p scored higher at the same size.
 */
export function chooseHeight({
    kbps,
    width,
    height,
    fps,
}: {
    kbps: number;
    width: number;
    height: number;
    fps: number;
}): HeightChoice {
    const aspect = width / height;
    const atSource = bitsPerPixel({ kbps, width, height, fps });

    if (atSource >= MIN_BITS_PER_PIXEL) {
        return { height: undefined, reason: `${height}p keeps ${atSource.toFixed(3)} bits per pixel` };
    }

    const candidates = STANDARD_HEIGHTS.filter((standard) => standard < height);

    for (const candidate of candidates) {
        const bpp = bitsPerPixel({ kbps, width: candidate * aspect, height: candidate, fps });

        if (bpp >= MIN_BITS_PER_PIXEL) {
            return {
                height: candidate,
                reason: `${candidate}p gets ${bpp.toFixed(3)} bits per pixel, ${height}p only ${atSource.toFixed(3)}`,
            };
        }
    }

    const lowest = candidates.at(-1);
    return lowest === undefined
        ? { height: undefined, reason: `${height}p is already small; the bitrate is thin for any size` }
        : { height: lowest, reason: `even ${lowest}p is thin at this size; a larger target would look better` };
}

export interface PresetScore {
    preset: VideoPreset;
    /** Mean VMAF over the windows, or SSIM in decibels when this ffmpeg has no libvmaf. */
    score: number;
    predictedSeconds: number;
}

/** VMAF points the AV1 preset must lead by before it beats the preset that plays everywhere. */
export const SMALL_MARGIN = 1.5;
/** Presets this close to the best score count as equal, and the fastest of them wins. */
export const EQUAL_MARGIN = 1;

export interface Recommendation {
    preset: VideoPreset;
    reason: string;
}

/**
 * The best-looking preset, unless a faster one is within `EQUAL_MARGIN`, and never `small` by a lead under
 * `SMALL_MARGIN` (AV1 plays in fewer places than H.264).
 */
export function recommendPreset(scores: PresetScore[]): Recommendation | null {
    if (scores.length === 0) {
        return null;
    }

    const byScore = [...scores].sort((a, b) => b.score - a.score);
    const best = byScore[0];
    const others = byScore.filter((entry) => entry.preset !== "small");
    let pool = byScore;
    let note = "";

    if (best.preset === "small" && others.length > 0 && best.score - others[0].score < SMALL_MARGIN) {
        pool = others;
        note = `; small leads by only ${(best.score - others[0].score).toFixed(1)}, under ${SMALL_MARGIN}, and AV1 plays in fewer places`;
    }

    const top = pool[0];
    const equal = pool.filter((entry) => top.score - entry.score <= EQUAL_MARGIN);
    const pick = equal.reduce((fastest, entry) =>
        entry.predictedSeconds < fastest.predictedSeconds ? entry : fastest
    );
    const reason =
        pick.preset === top.preset
            ? `the best score (${pick.score.toFixed(1)})${note}`
            : `within ${EQUAL_MARGIN} of the best (${pick.score.toFixed(1)} against ${top.score.toFixed(1)}) and faster${note}`;
    return { preset: pick.preset, reason };
}

/** How strongly a two-pass encode follows complexity: x264's default `qcomp` 0.6 spends bits as complexity^0.6. */
const RATE_FOLLOWS_COMPLEXITY = 0.6;

/**
 * The bitrate a full two-pass encode gives one window: the average, scaled by how much harder the window is than the
 * whole file (the source's own bitrate as the measure), to the power 0.6, and kept within a quarter and four times the
 * average. Encoding a hard window at the plain average judged it on bits it would never get: on the full talk the
 * hardest window has 2.6 times the average source rate.
 */
export function windowKbps({
    kbps,
    windowSourceKbps,
    overallSourceKbps,
}: {
    kbps: number;
    windowSourceKbps: number;
    overallSourceKbps: number;
}): number {
    if (overallSourceKbps <= 0 || windowSourceKbps <= 0) {
        return kbps;
    }

    const share = (windowSourceKbps / overallSourceKbps) ** RATE_FOLLOWS_COMPLEXITY;
    return Math.round(kbps * Math.min(4, Math.max(0.25, share)));
}

/**
 * A 10 s window lands less exactly than a full two-pass encode, so the preview corrects only a real miss, like the GPU
 * encoder's QP floor (124% of the target on the full talk), not the few percent of rate noise.
 */
export const PREVIEW_BAND = { low: 0.75, high: 1.1 } as const;

/**
 * The rate for a preview window's next attempt, or null when `bytes` is inside `PREVIEW_BAND` of `plannedBytes`.
 * `plannedBytes` is the window's share of the target, fixed before the first attempt, as the full encode keeps the
 * target fixed: measured against the bytes of its own corrected rate, a window at half the budget passed after one
 * correction.
 */
export function previewCorrection({
    kbps,
    bytes,
    plannedBytes,
}: {
    /** The rate of the attempt that wrote `bytes`. */
    kbps: number;
    bytes: number;
    plannedBytes: number;
}): number | null {
    const ratio = bytes / plannedBytes;

    if (ratio >= PREVIEW_BAND.low && ratio <= PREVIEW_BAND.high) {
        return null;
    }

    return Math.max(1, Math.round((kbps * plannedBytes) / Math.max(1, bytes)));
}
