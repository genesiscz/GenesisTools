import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

export interface FrameGridOpts {
    /** Crop region in the SCREENSHOT's own pixel space: "x,y,w,h". Omit for the full viewport. */
    region?: string;
    /** Pixel spacing between grid lines/labels. Default 60 — smaller values crowd labels into illegibility. */
    gridStep?: number;
    /** Where to write the labeled PNG. */
    outPath: string;
}

/**
 * Screenshots the page via chrome-devtools-mcp's `take_screenshot`, then
 * overlays a coordinate grid with pixel-value labels baked in as text —
 * the same manual ImageMagick recipe used ad hoc this session to locate
 * click targets inside a web page (peekaboo's AX-tree tools see none of a
 * page's DOM content, so pixel coordinates are the only way in). Read the
 * output PNG to find the exact pixel for a click, without hand-writing
 * `magick -draw` grid/text commands from scratch each time.
 */
export async function captureFrameGrid(client: Client, opts: FrameGridOpts): Promise<string> {
    const step = opts.gridStep ?? 60;
    const rawPath = `${opts.outPath}.raw.png`;

    await client.callTool({ name: "take_screenshot", arguments: { filePath: rawPath, format: "png" } });

    let source = rawPath;
    if (opts.region) {
        const [x, y, w, h] = opts.region.split(",").map(Number);
        if ([x, y, w, h].some((n) => Number.isNaN(n))) {
            throw new Error(`region must be "x,y,w,h", got: ${opts.region}`);
        }
        const cropped = `${opts.outPath}.crop.png`;
        const crop = Bun.spawnSync(["magick", rawPath, "-crop", `${w}x${h}+${x}+${y}`, "+repage", cropped]);
        if (crop.exitCode !== 0) {
            throw new Error(`magick crop failed: ${crop.stderr.toString()}`);
        }
        source = cropped;
    }

    const identify = Bun.spawnSync(["magick", "identify", "-format", "%w %h", source]);
    if (identify.exitCode !== 0) {
        throw new Error(`magick identify failed: ${identify.stderr.toString()}`);
    }
    const [width, height] = identify.stdout
        .toString()
        .trim()
        .split(" ")
        .map(Number);

    const xOffset = opts.region ? Number(opts.region.split(",")[0]) : 0;
    const yOffset = opts.region ? Number(opts.region.split(",")[1]) : 0;
    const vLines = Array.from({ length: Math.floor(width / step) + 1 }, (_, i) => i * step);
    const hLines = Array.from({ length: Math.floor(height / step) + 1 }, (_, i) => i * step);
    const labelW = 34;
    const labelH = 15;

    // Order matters: gridlines first (so they sit under labels), then a solid
    // backing chip behind each label, then the label text on top — a bare
    // pointsize-10 label with no backing was illegible against busy page
    // content (confirmed: unreadable overlapping a video-thumbnail region).
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

    const overlay = Bun.spawnSync(["magick", source, ...drawArgs, opts.outPath]);
    if (overlay.exitCode !== 0) {
        throw new Error(`magick grid overlay failed: ${overlay.stderr.toString()}`);
    }

    return opts.outPath;
}
