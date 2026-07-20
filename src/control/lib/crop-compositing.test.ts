import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { renderAnnotationPlan } from "@genesiscz/utils/image";
import pixelmatch from "pixelmatch";
import { applyCrops } from "./crop-compositing";

/**
 * Migration parity vs the pre-canvas ImageMagick goldens (__fixtures__/
 * magick-golden, generated 2026-07-20). Geometry must match; text zones
 * (label bars, grid labels) rasterize differently by design — Skia vs magick
 * fonts — so they get bounded-mismatch checks, not identity. Reference
 * measurements at migration time: tile below-label diff 0-51 px (window-corner
 * alpha flattening), full-tile 0.24-0.43%, strip 0.28%, strip-review 0.64%,
 * clickmap 0.75% with 20/20 exact gridline columns.
 */

const FIX = join(import.meta.dir, "__fixtures__", "magick-golden");

interface Decoded {
    w: number;
    h: number;
    data: Uint8ClampedArray;
}

async function decode(input: string | Buffer): Promise<Decoded> {
    const img = await loadImage(input);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    return { w: img.width, h: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data };
}

function mismatch(a: Decoded, b: Decoded, threshold = 0.1): number {
    return pixelmatch(a.data, b.data, undefined, a.w, a.h, { threshold });
}

const LABEL_H = 34;

async function runFixtureCrops() {
    const session = mkdtempSync(join(tmpdir(), "crop-parity-"));
    const frames = [1, 2, 3, 4].map((i) => ({
        file: `keep-000${i}.png`,
        path: join(FIX, "frames", `keep-000${i}.png`),
        timestampMs: (i - 1) * 400,
    }));
    const specs = [
        { fromMs: 0, region: { x: 0, y: 0, w: 720, h: 300 }, label: "toolbar" },
        { fromMs: 0, toMs: 900, region: { x: 0, y: 60, w: 500, h: 200 }, label: "text" },
    ];
    return applyCrops(session, frames, specs);
}

describe("canvas crop compositing vs magick goldens", () => {
    test("tiles: same dims, image region pixel-parity, bounded label-zone drift", async () => {
        const { crops } = await runFixtureCrops();
        const good = crops.filter((c) => c.ok);
        expect(good).toHaveLength(7);

        for (const c of good) {
            const mine = await decode(c.path);
            const gold = await decode(join(FIX, "crops", basename(c.path)));
            expect([mine.w, mine.h]).toEqual([gold.w, gold.h]);

            // below the 34px label bar the crop must be (near-)identical — the
            // only tolerated drift is alpha flattening on window corners
            const rowBytes = mine.w * 4;
            const belowLabel = pixelmatch(
                mine.data.slice(LABEL_H * rowBytes),
                gold.data.slice(LABEL_H * rowBytes),
                undefined,
                mine.w,
                mine.h - LABEL_H,
                { threshold: 0.1 }
            );
            expect(belowLabel).toBeLessThan(200);

            // full tile including the differently-rasterized label text
            expect(mismatch(mine, gold) / (mine.w * mine.h)).toBeLessThan(0.01);
        }
    });

    test("strip: dims + mixed-width padding + stacking match", async () => {
        const { strip } = await runFixtureCrops();
        expect(strip).toBeTruthy();
        const mine = await decode(strip!);
        const gold = await decode(join(FIX, "crops", "strip.png"));
        expect([mine.w, mine.h]).toEqual([gold.w, gold.h]);
        expect(mismatch(mine, gold) / (mine.w * mine.h)).toBeLessThan(0.01);
    });

    test("strip-review: downscale dims + bounded filter drift", async () => {
        const { stripReview } = await runFixtureCrops();
        expect(stripReview).toBeTruthy();
        const mine = await decode(stripReview!);
        const gold = await decode(join(FIX, "crops", "strip-review.png"));
        expect([mine.w, mine.h]).toEqual([gold.w, gold.h]);
        expect(mismatch(mine, gold) / (mine.w * mine.h)).toBeLessThan(0.02);
    });
});

describe("canvas clickmap grid vs magick golden", () => {
    test("gridline geometry exact, overall drift bounded", async () => {
        const window = { x: 498, y: 334, w: 920, h: 436 };
        const raw = await loadImage(join(FIX, "clickmap-raw.png"));
        const scaled = createCanvas(window.w, window.h);
        const sctx = scaled.getContext("2d");
        sctx.imageSmoothingEnabled = true;
        sctx.imageSmoothingQuality = "high";
        sctx.drawImage(raw, 0, 0, window.w, window.h);
        const rendered = await renderAnnotationPlan({
            input: scaled.toBuffer("image/png"),
            annotations: [{ kind: "grid", step: 100, originOffset: { x: window.x, y: window.y } }],
        });

        const mine = await decode(rendered.png);
        const gold = await decode(join(FIX, "clickmap.png"));
        expect([mine.w, mine.h]).toEqual([gold.w, gold.h]);

        // every expected gridline column must be magenta in BOTH outputs
        for (let gx = Math.ceil(window.x / 100) * 100; gx < window.x + window.w; gx += 100) {
            const px = gx - window.x;
            for (const img of [mine, gold]) {
                const i = (300 * img.w + px) * 4;
                const [r, g, b] = [img.data[i], img.data[i + 1], img.data[i + 2]];
                expect(r).toBeGreaterThan(100);
                expect(b).toBeGreaterThan(100);
                expect(g).toBeLessThan(r);
            }
        }

        expect(mismatch(mine, gold) / (mine.w * mine.h)).toBeLessThan(0.02);
    });
});
