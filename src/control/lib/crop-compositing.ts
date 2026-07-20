/**
 * Crop compositing: cut labeled tiles out of kept frames, stack them into the
 * time-ordered strip, and produce the vision-sized strip-review copy.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type CropOut, type CropSpec, type FrameInfo, parseRegion } from "./capture-plan";

export function applyCrops(
    sessionDir: string,
    frames: FrameInfo[],
    specs: CropSpec[]
): { crops: CropOut[]; strip: string | null; stripReview: string | null } {
    const crops: CropOut[] = [];
    let strip: string | null = null;
    let stripReview: string | null = null;
    const sorted = specs.slice().sort((a, b) => a.fromMs - b.fromMs);

    let cropDir = join(sessionDir, "crops");
    for (let n = 2; existsSync(cropDir); n++) {
        cropDir = join(sessionDir, `crops-${n}`);
    }

    mkdirSync(cropDir, { recursive: true });

    for (let i = 0; i < sorted.length; i++) {
        const spec = sorted[i];
        // extractCropSpecs sets an explicit toMs on every window except the final
        // still-open sequential one, which runs to capture end. Don't fall back to
        // the next spec's fromMs — that would wrongly clip overlapping windows.
        const end = spec.toMs ?? Number.POSITIVE_INFINITY;
        const { x, y, w, h } = parseRegion(spec.region);

        for (const f of frames) {
            if (f.timestampMs < spec.fromMs || f.timestampMs >= end) {
                continue;
            }

            const label = `${spec.label ?? `crop${i}`} t=${f.timestampMs}ms`;
            const outPath = join(cropDir, `${f.file.replace(/\.png$/, "")}-${spec.label ?? `crop${i}`}.png`);
            const r = Bun.spawnSync([
                "magick",
                f.path,
                "-crop",
                `${w}x${h}+${x}+${y}`,
                "+repage",
                "-bordercolor",
                "#181818",
                "-border",
                "0x2",
                "(",
                "-size",
                `${w}x34`,
                "-background",
                "#181818",
                "-fill",
                "#ffb020",
                "-pointsize",
                "20",
                "-gravity",
                "west",
                `label:  ${label}`,
                ")",
                "+swap",
                "-append",
                outPath,
            ]);
            crops.push({
                frame: f.file,
                timestampMs: f.timestampMs,
                label,
                path: outPath,
                ok: r.exitCode === 0 && existsSync(outPath),
                error: r.exitCode === 0 ? undefined : r.stderr.toString().slice(0, 200),
            });
        }
    }

    const good = crops.filter((c) => c.ok).sort((a, b) => a.timestampMs - b.timestampMs);
    if (good.length > 1) {
        const stripPath = join(cropDir, "strip.png");
        const r = Bun.spawnSync(["magick", ...good.map((c) => c.path), "-append", stripPath]);
        if (r.exitCode === 0 && existsSync(stripPath)) {
            strip = stripPath;
        }
    } else if (good.length === 1) {
        strip = good[0].path;
    }

    // Vision-sized copy: full strips grow to 4000x8000+ px, which agents should
    // never Read raw — cap the longest side, only ever shrinking.
    if (strip) {
        const reviewPath = join(cropDir, "strip-review.png");
        const r = Bun.spawnSync(["magick", strip, "-resize", "1600x1600>", reviewPath]);
        if (r.exitCode === 0 && existsSync(reviewPath)) {
            stripReview = reviewPath;
        }
    }

    return { crops, strip, stripReview };
}
