import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skip } from "@genesiscz/utils/test/skip";
import { movieEvents } from "./events";
import { changeMoment, refineSceneTimes } from "./scene-times";
import { type ChangeStep, maskCells, measureChangeSteps } from "./waits";

/** A step whose changed cells are rows `from` to `to` (inclusive) of a `columns` × `rows` grid. */
function rowsChanged(columns: number, rows: number, from: number, to: number): ChangeStep {
    const cells = new Set<number>();

    for (let row = from; row <= to; row++) {
        for (let column = 0; column < columns; column++) {
            cells.add(row * columns + column);
        }
    }

    const digits = new Uint8Array(Math.ceil((columns * rows) / 4));

    for (const cell of cells) {
        digits[cell >> 2] |= 1 << (cell & 3);
    }

    return {
        changed: cells.size,
        cells: columns * rows,
        box: { x0: 0, y0: from, x1: columns - 1, y1: to },
        mask: [...digits].map((digit) => digit.toString(16)).join(""),
    };
}

// R7 8: a tab tap swaps the content above a fixed tab bar; under half the picture changed, so events() had no scene
// there, and the nearest scenes were 1 to 2 s away.
describe("scene changes: a partial swap, a slide over several steps, and the frame it starts on", () => {
    const columns = 4;
    const rows = 10;
    const still: ChangeStep = { changed: 0, cells: columns * rows };

    test("a content swap over a fixed tab bar is a scene, though under half the picture changed", () => {
        // Rows 1 to 4 change (40 %): the list's text, while the header and the tab bar stay.
        const swap = rowsChanged(columns, rows, 1, 4);
        expect(maskCells(swap.mask).size).toBe(16);
        const events = movieEvents({ steps: [still, still, swap, still, still], fps: 4, pictureHeight: 100 });
        expect(events.filter((event) => event.kind === "scene").map((event) => event.fromUs)).toEqual([750_000]);
        // A small change (a spinner, a typed line) is still no scene.
        const small = rowsChanged(columns, rows, 2, 2);
        expect(movieEvents({ steps: [still, small, still], fps: 4, pictureHeight: 100 })).not.toContainEqual(
            expect.objectContaining({ kind: "scene" })
        );
    });

    test("a slide-in spread over steps is one scene, at the step it starts in", () => {
        const first = rowsChanged(columns, rows, 0, 2);
        const second = rowsChanged(columns, rows, 3, 5);
        const third = rowsChanged(columns, rows, 6, 8);
        const events = movieEvents({ steps: [still, first, second, third, still], fps: 4, pictureHeight: 100 });
        expect(events.filter((event) => event.kind === "scene").map((event) => event.fromUs)).toEqual([500_000]);
    });

    test("the change's frame is the first that moved a fifth of the way to the new picture", () => {
        const width = 4;
        const height = 4;
        const grey = (value: number) => new Uint8Array(width * height).fill(value);
        const frames = [0, 0, 0, 60, 200, 200].map((value, index) => ({
            us: 1_000_000 + index * 33_333,
            pixels: grey(value),
        }));
        expect(changeMoment(frames)).toBe(1_000_000 + 3 * 33_333);
        expect(changeMoment(frames.slice(0, 3))).toBeUndefined();
    });

    // A movie of a white screen with a dark block that jumps from the top third to the middle at 1.4 s: 40 % of the
    // picture changes, the fixed bottom bar does not.
    test.skipIf(skip.integration)("on a movie, the scene lands on the frame of the swap", async () => {
        const folder = mkdtempSync(join(tmpdir(), "scene-times-"));
        const video = join(folder, "screen.mp4");
        const box = (y: number) => `drawbox=x=0:y=${y}:w=160:h=64:color=black@1:t=fill`;
        const bar = "drawbox=x=0:y=290:w=160:h=30:color=gray@1:t=fill";
        const made = Bun.spawnSync([
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=white:s=160x320:r=30:d=3",
            "-vf",
            `${box(32)}:enable='lt(t,1.4)',${box(160)}:enable='gte(t,1.4)',${bar}`,
            "-pix_fmt",
            "yuv420p",
            video,
        ]);
        expect(made.exitCode).toBe(0);
        const measured = await measureChangeSteps({ video, width: 160, height: 320 });
        const coarse = movieEvents({ steps: measured.steps, fps: measured.fps, pictureHeight: measured.height });
        const scenes = coarse.filter((event) => event.kind === "scene");
        expect(scenes).toHaveLength(1);
        const [refined] = await refineSceneTimes({
            video,
            width: 160,
            height: 320,
            scenesUs: scenes.map((scene) => scene.fromUs),
            stepUs: 1_000_000 / measured.fps,
        });
        // Frame 42 of a 30 fps movie starts at 1.4 s; one frame is 33 ms.
        expect(Math.abs((refined ?? 0) - 1_400_000)).toBeLessThan(34_000);
    });
});
