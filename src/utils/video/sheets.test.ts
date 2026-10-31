import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { composeImageGrid, MAX_SHEET_WIDTH } from "../image/grid";
import { defaultVideoSettings } from "./defaults";

async function frame(directory: string, name: string, width: number, height: number): Promise<string> {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    context.fillStyle = "#204060";
    context.fillRect(0, 0, width, height);
    const path = join(directory, name);
    await Bun.write(path, canvas.toBuffer("image/png"));
    return path;
}

describe("contact sheets of a screen recording", () => {
    test("a tile follows the source: a 4K display in two columns keeps half its width", async () => {
        const directory = await mkdtemp(join(tmpdir(), "sheets-"));
        const images = await Promise.all(
            [0, 1, 2, 3].map(async (index) => ({
                path: await frame(directory, `f${index}.png`, 4112, 2510),
                label: `${index}`,
            }))
        );
        const grid = await composeImageGrid({ images, output: join(directory, "sheet.png") });
        expect(grid.columns).toBe(2);
        expect(grid.rows).toBe(2);
        // 4096 / 2 columns, minus the 8 px inset: 2040 px, a scale just over 2.
        expect(grid.tileWidth).toBe(2040);
        expect(grid.scale).toBeCloseTo(2.02, 2);
        expect(grid.tileHeight).toBe(Math.round((2040 * 2510) / 4112));
    });

    test("a small frame is never scaled up", async () => {
        const directory = await mkdtemp(join(tmpdir(), "sheets-"));
        const images = [{ path: await frame(directory, "small.png", 300, 200), label: "small" }];
        const grid = await composeImageGrid({ images, output: join(directory, "sheet.png") });
        expect(grid.tileWidth).toBe(300);
        expect(grid.scale).toBe(1);
    });

    test("the frames-per-image default keeps a tile at half the source or better", () => {
        expect(defaultVideoSettings({ width: 4112 }).framesPerImage).toBe(1);
        expect(defaultVideoSettings({ width: 3200 }).framesPerImage).toBe(4);
        expect(defaultVideoSettings({ width: 2714 }).framesPerImage).toBe(8);
        expect(defaultVideoSettings({ width: 2715 }).framesPerImage).toBe(4);
        expect(defaultVideoSettings({ width: 2560 }).framesPerImage).toBe(8);
        expect(defaultVideoSettings({ width: 1920 }).framesPerImage).toBe(16);
        expect(defaultVideoSettings({ width: 1280 }).framesPerImage).toBe(32);
        expect(defaultVideoSettings({ width: 20_000 }).framesPerImage).toBe(1);
        for (const width of [4112, 3200, 2714, 2715, 2560, 1920, 1280]) {
            const { framesPerImage } = defaultVideoSettings({ width });
            const columns = Math.ceil(Math.sqrt(framesPerImage));
            expect(width / (Math.floor(MAX_SHEET_WIDTH / columns) - 8)).toBeLessThanOrEqual(2);
        }
    });
});
