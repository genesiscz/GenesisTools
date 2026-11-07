import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { type FractionBox, redactionBoxAt } from "@genesiscz/utils/recording-editor/private-data";
import { applyOp, editOpSchema, wholeProject } from "@genesiscz/utils/recording-editor/project";
import { runVideoCommand } from "@genesiscz/utils/video/process";
import { textHitsOf } from "./fx-analysis";

/**
 * Round 6 item 1: hidden text must stay hidden while the screen scrolls or slides. The movie is generated from two
 * invented pictures (`__fixtures__/moving-list.png`, a contact list, and `moving-banner.png`, a banner; both made with
 * ImageMagick's `-annotate` in Arial, every name and number made up). The list is flicked up fast and slows down like a
 * phone's scroll, then a banner is flicked in from the right; `tmix` blurs whatever moves the way a recording does, so Vision reads
 * nothing in the middle of a move. Every frame where the name can be read must be covered by a hidden part.
 */

const W = 1280;
const H = 720;
const FPS = 30;
const SECONDS = 5;
const LIST_X = 360;
// The glyphs of "Orla Fictive" in moving-list.png (row 5) and in moving-banner.png (ImageMagick -trim), in pixels.
const LIST_NAME = { x: 24, y: 355, width: 164, height: 27 };
const BANNER_NAME = { x: 236, y: 34, width: 166, height: 26 };
const BANNER_Y = 600;

/** A flick: the content jumps to full speed at `from`, then slows down by `e^-t/tau`, as a phone's scroll does. */
const flick = (t: number, from: number, tau: number): number => 1 - Math.exp(-Math.max(0, t - from) / tau);
const flickExpr = (from: number, tau: number) => `(1-exp(-max(0,t-${from})/${tau}))`;
/** The list's top in the movie: 250 px down, then flicked 450 px up at 1.5 s. */
const listY = (t: number): number => 250 - 450 * flick(t, 1.5, 0.25);
/** The banner's left edge: off the right edge, then flicked in at 3.5 s. */
const bannerX = (t: number): number => W - 920 * flick(t, 3.5, 0.15);

/** Where each copy of the name is at `t`, as fractions of the picture; undefined while it is off the picture. */
function namesAt(t: number): Array<FractionBox | undefined> {
    const boxes = [
        { x: LIST_X + LIST_NAME.x, y: listY(t) + LIST_NAME.y, width: LIST_NAME.width, height: LIST_NAME.height },
        {
            x: bannerX(t) + BANNER_NAME.x,
            y: BANNER_Y + BANNER_NAME.y,
            width: BANNER_NAME.width,
            height: BANNER_NAME.height,
        },
    ];
    return boxes.map((box) =>
        box.x < W && box.x + box.width > 0 && box.y < H && box.y + box.height > 0
            ? { x: box.x / W, y: box.y / H, width: box.width / W, height: box.height / H }
            : undefined
    );
}

/** The share of `box` that the union of `rects` covers, sampled on a 20 x 8 grid. */
function covered(box: FractionBox, rects: readonly FractionBox[]): number {
    let inside = 0;
    let all = 0;

    for (let i = 0; i < 20; i++) {
        for (let j = 0; j < 8; j++) {
            const x = Math.min(1, Math.max(0, box.x + ((i + 0.5) / 20) * box.width));
            const y = Math.min(1, Math.max(0, box.y + ((j + 0.5) / 8) * box.height));
            all++;

            if (
                rects.some(
                    (rect) => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height
                )
            ) {
                inside++;
            }
        }
    }

    return inside / all;
}

const hasTools = process.platform === "darwin" && Boolean(Bun.which("ffmpeg"));

describe.skipIf(!hasTools)("moving text stays hidden (generated movie, Vision OCR)", () => {
    // blur: tmix frames, what a frame shows is the mean of this many pictures (1 is a sharp recording).
    test.each([1, 6])(
        "blur %p: every frame where the name can be read is covered, and the list's and the banner's name stay apart",
        async (blur) => {
            const folder = mkdtempSync(join(tmpdir(), "gt-moving-text-"));
            const movie = join(folder, `moving-${blur}.mp4`);
            const fixtures = join(moduleDir(import.meta), "__fixtures__");
            await runVideoCommand({
                command: [
                    "ffmpeg",
                    "-nostdin",
                    "-v",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    `color=c=0x5a6070:s=${W}x${H}:r=${FPS}:d=${SECONDS}`,
                    "-loop",
                    "1",
                    "-i",
                    join(fixtures, "moving-list.png"),
                    "-loop",
                    "1",
                    "-i",
                    join(fixtures, "moving-banner.png"),
                    "-filter_complex",
                    `[0][1]overlay=x=${LIST_X}:y='250-450*${flickExpr(1.5, 0.25)}':eval=frame:shortest=1[a];` +
                        `[a][2]overlay=x='${W}-920*${flickExpr(3.5, 0.15)}':y=${BANNER_Y}:eval=frame:shortest=1[b];` +
                        `[b]tmix=frames=${blur},format=yuv420p`,
                    "-t",
                    String(SECONDS),
                    "-c:v",
                    "libx264",
                    "-crf",
                    "16",
                    movie,
                ],
            });
            const project = wholeProject({ video: movie, durationUs: SECONDS * 1_000_000, width: W, height: H });
            const hits = await textHitsOf(project, { text: "Orla Fictive" });
            const hidden = applyOp(project, editOpSchema.parse({ op: "hideText", text: "Orla Fictive" }), {
                textHits: hits,
            });
            const parts = hidden.redactions ?? [];

            // Never two texts in one part: no keyframe is taller than a few lines.
            for (const part of parts) {
                for (const key of part.track ?? []) {
                    expect(key.height).toBeLessThan(0.2);
                }
            }

            const leaks: string[] = [];

            for (let frame = 0; frame < SECONDS * FPS; frame++) {
                const t = frame / FPS;
                const us = Math.round(t * 1_000_000);
                const rects = parts
                    .filter((part) => part.startUs <= us && us < part.endUs)
                    .map((part) => redactionBoxAt(part, us));
                // A frame shows the mean of the last `blur` pictures: a name that moved less than its height in that time
                // can be read; one that moved more is a smear.
                const now = namesAt(t);
                const before = namesAt(Math.max(0, t - (blur - 1) / FPS));

                for (const [index, box] of now.entries()) {
                    const earlier = before[index];

                    if (
                        !box ||
                        !earlier ||
                        Math.abs(earlier.y - box.y) > box.height ||
                        Math.abs(earlier.x - box.x) > box.height
                    ) {
                        continue;
                    }

                    const share = covered(box, rects);

                    if (share < 0.9) {
                        leaks.push(`${t.toFixed(3)} s copy ${index}: ${Math.round(share * 100)} % covered`);
                    }
                }
            }

            expect(leaks).toEqual([]);
        },
        240_000
    );
});
