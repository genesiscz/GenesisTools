/**
 * Crop compositing on @napi-rs/canvas: cut labeled tiles out of kept frames,
 * stack them into the time-ordered strip, and produce the vision-sized
 * strip-review copy. Replaces the former ImageMagick shellouts (goldens under
 * __fixtures__/magick-golden pin the geometry; label typography differs by
 * design — Skia vs magick fonts).
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Canvas, createCanvas, type Image, loadImage } from "@napi-rs/canvas";
import { type CropOut, type CropSpec, type FrameInfo, parseRegion } from "./capture-plan";

const TILE_BG = "#181818";
const LABEL_FG = "#ffb020";
const LABEL_H = 34;
const LABEL_FONT = "20px sans-serif";
const BORDER_V = 2;
const REVIEW_MAX = 1600;

interface TileOut extends CropOut {
    canvas?: Canvas;
}

function buildTile(frame: Image, region: { x: number; y: number; w: number; h: number }, label: string): Canvas {
    // magick -crop clips to the frame; empty intersections are the caller's error
    const x = Math.max(0, Math.round(region.x));
    const y = Math.max(0, Math.round(region.y));
    const w = Math.min(Math.round(region.w) - (x - Math.round(region.x)), frame.width - x);
    const h = Math.min(Math.round(region.h) - (y - Math.round(region.y)), frame.height - y);
    if (!(w > 0) || !(h > 0)) {
        throw new Error(
            `crop region ${region.w}x${region.h}+${region.x}+${region.y} lies outside the ${frame.width}x${frame.height} frame`
        );
    }

    // tile = 34px label bar on top + 2px border + crop + 2px border
    const tile = createCanvas(w, LABEL_H + BORDER_V + h + BORDER_V);
    const ctx = tile.getContext("2d");
    ctx.fillStyle = TILE_BG;
    ctx.fillRect(0, 0, tile.width, tile.height);
    ctx.fillStyle = LABEL_FG;
    ctx.font = LABEL_FONT;
    ctx.textBaseline = "middle";
    ctx.fillText(`  ${label}`, 0, LABEL_H / 2 + 1);
    ctx.drawImage(frame, x, y, w, h, 0, LABEL_H + BORDER_V, w, h);
    return tile;
}

export async function applyCrops(
    sessionDir: string,
    frames: FrameInfo[],
    specs: CropSpec[]
): Promise<{ crops: CropOut[]; strip: string | null; stripReview: string | null }> {
    const tiles: TileOut[] = [];
    let strip: string | null = null;
    let stripReview: string | null = null;
    const sorted = specs.slice().sort((a, b) => a.fromMs - b.fromMs);

    let cropDir = join(sessionDir, "crops");
    for (let n = 2; existsSync(cropDir); n++) {
        cropDir = join(sessionDir, `crops-${n}`);
    }

    mkdirSync(cropDir, { recursive: true });

    const frameImages = new Map<string, Image>();

    for (let i = 0; i < sorted.length; i++) {
        const spec = sorted[i];
        // extractCropSpecs sets an explicit toMs on every window except the final
        // still-open sequential one, which runs to capture end. Don't fall back to
        // the next spec's fromMs — that would wrongly clip overlapping windows.
        const end = spec.toMs ?? Number.POSITIVE_INFINITY;
        const region = parseRegion(spec.region);

        for (const f of frames) {
            if (f.timestampMs < spec.fromMs || f.timestampMs >= end) {
                continue;
            }

            const label = `${spec.label ?? `crop${i}`} t=${f.timestampMs}ms`;
            const outPath = join(cropDir, `${f.file.replace(/\.png$/, "")}-${spec.label ?? `crop${i}`}.png`);
            try {
                let frame = frameImages.get(f.path);
                if (!frame) {
                    frame = await loadImage(f.path);
                    frameImages.set(f.path, frame);
                }

                const tile = buildTile(frame, region, label);
                await Bun.write(outPath, tile.toBuffer("image/png"));
                tiles.push({ frame: f.file, timestampMs: f.timestampMs, label, path: outPath, ok: true, canvas: tile });
            } catch (e) {
                tiles.push({
                    frame: f.file,
                    timestampMs: f.timestampMs,
                    label,
                    path: outPath,
                    ok: false,
                    error: (e instanceof Error ? e.message : String(e)).slice(0, 200),
                });
            }
        }
    }

    const good = tiles.filter((c) => c.ok && c.canvas).sort((a, b) => a.timestampMs - b.timestampMs);
    if (good.length > 1) {
        const stripPath = join(cropDir, "strip.png");
        const stripW = Math.max(...good.map((c) => c.canvas!.width));
        const stripH = good.reduce((sum, c) => sum + c.canvas!.height, 0);
        const stripCanvas = createCanvas(stripW, stripH);
        const ctx = stripCanvas.getContext("2d");
        // narrower tiles pad with the tile background (magick used the tiles'
        // stored bKGD for -append padding — same #181818)
        ctx.fillStyle = TILE_BG;
        ctx.fillRect(0, 0, stripW, stripH);
        let yOffset = 0;
        for (const c of good) {
            ctx.drawImage(c.canvas!, 0, yOffset);
            yOffset += c.canvas!.height;
        }

        await Bun.write(stripPath, stripCanvas.toBuffer("image/png"));
        strip = stripPath;

        // Vision-sized copy: full strips grow to 4000x8000+ px, which agents
        // should never Read raw — cap the longest side, only ever shrinking.
        const reviewPath = join(cropDir, "strip-review.png");
        const longest = Math.max(stripW, stripH);
        if (longest > REVIEW_MAX) {
            const scale = REVIEW_MAX / longest;
            const review = createCanvas(Math.round(stripW * scale), Math.round(stripH * scale));
            const rctx = review.getContext("2d");
            rctx.imageSmoothingEnabled = true;
            rctx.imageSmoothingQuality = "high";
            rctx.drawImage(stripCanvas, 0, 0, review.width, review.height);
            await Bun.write(reviewPath, review.toBuffer("image/png"));
        } else {
            await Bun.write(reviewPath, stripCanvas.toBuffer("image/png"));
        }

        stripReview = reviewPath;
    } else if (good.length === 1) {
        strip = good[0].path;
        const reviewPath = join(cropDir, "strip-review.png");
        const single = good[0].canvas!;
        const longest = Math.max(single.width, single.height);
        if (longest > REVIEW_MAX) {
            const scale = REVIEW_MAX / longest;
            const review = createCanvas(Math.round(single.width * scale), Math.round(single.height * scale));
            const rctx = review.getContext("2d");
            rctx.imageSmoothingEnabled = true;
            rctx.imageSmoothingQuality = "high";
            rctx.drawImage(single, 0, 0, review.width, review.height);
            await Bun.write(reviewPath, review.toBuffer("image/png"));
        } else {
            await Bun.write(reviewPath, single.toBuffer("image/png"));
        }

        stripReview = reviewPath;
    }

    return { crops: tiles.map(({ canvas: _canvas, ...crop }) => crop), strip, stripReview };
}
