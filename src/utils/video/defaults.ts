import { MAX_SHEET_WIDTH } from "../image/grid";
import { VIDEO_GROUPS, type VideoSettings } from "./types";

/**
 * The frame review's starting settings for a source `width` pixels wide: 2 samples a second, and the largest group
 * whose sheet tiles keep at least half the source width (a scale of 2 or less, the logical resolution of a Retina
 * capture). A whole 4K display (4112 px) gets 1 frame per image, a 2560 px capture 8, a 1920 px one 16, and
 * anything under about 1400 px the full 32. The fixed 16 of before shrank a display recording 6.4 times.
 */
export function defaultVideoSettings({ width }: { width: number }): VideoSettings {
    const framesPerImage =
        [...VIDEO_GROUPS].reverse().find((group) => {
            const columns = Math.ceil(Math.sqrt(group));
            return Math.floor(MAX_SHEET_WIDTH / columns) - 8 >= width / 2;
        }) ?? VIDEO_GROUPS[0];
    return { fps: 2, framesPerImage, minimumDifferencePct: 0 };
}
