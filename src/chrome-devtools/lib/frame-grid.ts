/**
 * frame-grid.ts — screenshot with a pixel-coordinate grid burned in.
 *
 * AX-tree tools (peekaboo) see nothing inside a web page, so pixel coordinates are
 * the only way to aim a click. Read the output PNG, find the pixel, click it.
 *
 * Ported from GenesisTools src/youtube/lib/devtools/frame-grid.ts; takes the shot via
 * raw CDP instead of an MCP client, so it has no MCP dependency.
 * Requires ImageMagick (`magick`).
 */
import { attach } from "./cdp.ts";

export interface FrameGridOpts {
    /** Crop region in the SCREENSHOT's own pixel space: "x,y,w,h". Omit for full viewport. */
    region?: string;
    /** Grid spacing px. Default 60 — smaller crowds the labels into illegibility. */
    gridStep?: number;
    outPath: string;
    port?: number;
    fullPage?: boolean;
}

export async function captureFrameGrid(opts: FrameGridOpts): Promise<string> {
    const step = opts.gridStep ?? 60;

    if (!Number.isFinite(step) || step <= 0) {
        throw new Error(`--step must be a positive number of pixels, got '${opts.gridStep}'`);
    }

    const rawPath = `${opts.outPath}.raw.png`;
    const page = await attach({ port: opts.port ?? 9222 });
    try {
        await page.screenshot(rawPath, opts.fullPage ?? false);
    } finally {
        page.close();
    }

    return gridify(rawPath, opts.outPath, step, opts.region);
}

/** Overlay a labeled grid on an existing PNG. */
export function gridify(source: string, outPath: string, step = 60, region?: string): string {
    if (!Number.isFinite(step) || step <= 0) {
        throw new Error(`grid step must be a positive number of pixels, got '${step}'`);
    }

    let src = source;

    if (region) {
        const [x, y, w, h] = region.split(",").map(Number);

        if ([x, y, w, h].some((n) => Number.isNaN(n))) {
            throw new Error(`region must be "x,y,w,h", got: ${region}`);
        }

        const cropped = `${outPath}.crop.png`;
        const crop = Bun.spawnSync(["magick", src, "-crop", `${w}x${h}+${x}+${y}`, "+repage", cropped]);

        if (crop.exitCode !== 0) {
            throw new Error(`magick crop failed: ${crop.stderr.toString()}`);
        }

        src = cropped;
    }

    const identify = Bun.spawnSync(["magick", "identify", "-format", "%w %h", src]);

    if (identify.exitCode !== 0) {
        throw new Error(`magick identify failed: ${identify.stderr.toString()}`);
    }

    const [width, height] = identify.stdout.toString().trim().split(" ").map(Number);
    const xOffset = region ? Number(region.split(",")[0]) : 0;
    const yOffset = region ? Number(region.split(",")[1]) : 0;
    const vLines = Array.from({ length: Math.floor(width / step) + 1 }, (_, i) => i * step);
    const hLines = Array.from({ length: Math.floor(height / step) + 1 }, (_, i) => i * step);
    const labelW = 34;
    const labelH = 15;

    // Order matters: gridlines first (under labels), then a solid chip behind each
    // label, then the text — bare pointsize-10 labels were unreadable over busy content.
    const drawArgs = [
        "-fill",
        "none",
        "-stroke",
        "red",
        "-strokewidth",
        "1",
        ...vLines.flatMap((x) => ["-draw", `line ${x},0 ${x},${height}`]),
        ...hLines.flatMap((y) => ["-draw", `line 0,${y} ${width},${y}`]),
        "-fill",
        "black",
        "-stroke",
        "none",
        ...vLines.flatMap((x) => ["-draw", `rectangle ${x},0 ${x + labelW},${labelH}`]),
        ...hLines.flatMap((y) => ["-draw", `rectangle 0,${y} ${labelW},${y + labelH}`]),
        "-fill",
        "yellow",
        "-pointsize",
        "13",
        ...vLines.flatMap((x) => ["-draw", `text ${x + 2},${labelH - 3} '${x + xOffset}'`]),
        ...hLines.flatMap((y) => ["-draw", `text 2,${y + labelH - 3} '${y + yOffset}'`]),
    ];

    const overlay = Bun.spawnSync(["magick", src, ...drawArgs, outPath]);

    if (overlay.exitCode !== 0) {
        throw new Error(`magick grid overlay failed: ${overlay.stderr.toString()}`);
    }

    return outPath;
}
