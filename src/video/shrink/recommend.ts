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
