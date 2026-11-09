import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { movieContentKey } from "@genesiscz/utils/recording-editor/analysis-cache";
import { framePresentationUs, gridRead } from "@genesiscz/utils/recording-editor/frame-grid";
import { type FractionBox, redactionBoxAt } from "@genesiscz/utils/recording-editor/private-data";
import { applyOp, editOpSchema, wholeProject, writeProject } from "@genesiscz/utils/recording-editor/project";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { runVideoCommand } from "@genesiscz/utils/video/process";
import { computeEdit } from "./edit";
import {
    cachedScreenText,
    exportFrameCache,
    exportRangeOf,
    findText,
    ocrVideo,
    scanOf,
    textHitsOf,
    verifyHidden,
    verifyMatcherOf,
} from "./fx-analysis";

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

/** The contact list still over a grey movie of `seconds` at 10 fps; another length is another content key. */
async function stillListMovie(folder: string, seconds: number): Promise<string> {
    const movie = join(folder, `still-list-${seconds}.mp4`);
    await runVideoCommand({
        command: [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            `color=c=0x5a6070:s=${W}x${H}:r=10:d=${seconds}`,
            "-loop",
            "1",
            "-i",
            join(moduleDir(import.meta), "__fixtures__", "moving-list.png"),
            "-filter_complex",
            `[0][1]overlay=x=${LIST_X}:y=0:shortest=1,format=yuv420p`,
            "-t",
            String(seconds),
            movie,
        ],
    });
    return movie;
}

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
            const { hits } = await textHitsOf(project, { text: "Orla Fictive" });
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

    test("a hide with from and to reads the screen of that range only (round 8)", async () => {
        const folder = mkdtempSync(join(tmpdir(), "gt-scan-range-"));
        const movie = join(folder, "still-list.mp4");
        await runVideoCommand({
            command: [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                `color=c=0x5a6070:s=${W}x${H}:r=10:d=8`,
                "-loop",
                "1",
                "-i",
                join(moduleDir(import.meta), "__fixtures__", "moving-list.png"),
                "-filter_complex",
                `[0][1]overlay=x=${LIST_X}:y=0:shortest=1,format=yuv420p`,
                "-t",
                "8",
                movie,
            ],
        });
        const project = wholeProject({ video: movie, durationUs: 8_000_000, width: W, height: H });
        const read: number[] = [];
        const texts = ["Orla Fictive", "Nobody Example"];
        const { hits, warnings } = await textHitsOf(project, {
            texts,
            scan: scanOf(4, 5),
            onRead: (frames) => read.push(...frames.map((frame) => frame.atUs)),
        });
        expect(hits.length).toBeGreaterThan(0);
        expect(read.length).toBeGreaterThan(0);
        // One second each side of 4 to 5 s, nothing else.
        expect(Math.min(...read)).toBeGreaterThanOrEqual(3_000_000);
        expect(Math.max(...read)).toBeLessThan(6_000_000);

        // Review CLI-F4: a text the screen never shows is in the answer, not only on stderr, which a REPL over MCP or
        // the service never shows: findText's warnings, and hideText's edit warnings.
        const miss = [expect.stringContaining('"Nobody Example"')];
        expect(warnings).toEqual(miss);
        const found = await findText(project, { texts, from: 4, to: 5 });
        expect(found.hits.length).toBeGreaterThan(0);
        expect(found.warnings).toEqual(miss);
        const edit = await computeEdit({
            project,
            ops: [editOpSchema.parse({ op: "hideText", texts, from: 4, to: 5 })],
            fresh: true,
        });
        expect(edit.warnings).toEqual(expect.arrayContaining(miss));
    }, 120_000);

    test("ocrVideo keeps one read's frame pictures on disk at a time, not the whole range's (review CLI-F9)", async () => {
        const folder = mkdtempSync(join(tmpdir(), "gt-ocr-stream-"));
        const movie = join(folder, "stream.mp4");
        await runVideoCommand({
            command: [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc=s=160x120:r=10:d=8",
                "-pix_fmt",
                "yuv420p",
                movie,
            ],
        });
        // 5 a second of a 10 fps movie is every other frame: 40 runs of one frame, so two reads (32 and 8 frames).
        const lines = [{ text: "Orla Fictive", x: 0.1, y: 0.1, width: 0.3, height: 0.05 }];
        const cache = { get: () => lines, set: () => undefined };
        const before = new Set(readdirSync(tmpdir()));
        const onDisk: number[] = [];
        const frames = await ocrVideo({
            video: movie,
            toUs: 8_000_000,
            fps: 5,
            cache,
            onFrame: () => {
                const folders = readdirSync(tmpdir()).filter(
                    (name) => name.startsWith("gt-screen-text-") && !before.has(name)
                );
                onDisk.push(folders.reduce((all, name) => all + readdirSync(join(tmpdir(), name)).length, 0));
            },
        });
        expect(frames).toHaveLength(40);
        expect(onDisk).toHaveLength(40);
        expect(Math.max(...onDisk)).toBeLessThanOrEqual(32);
    }, 60_000);

    test("verifyHidden with from and to reads the source of that range only (review CLI-F7)", async () => {
        const folder = mkdtempSync(join(tmpdir(), "gt-verify-range-"));
        const movie = await stillListMovie(folder, 7);
        const project = wholeProject({ video: movie, durationUs: 7_000_000, width: W, height: H });
        const path = join(folder, "still-list.edit.json");
        writeProject(path, project);
        const answer = await verifyHidden(path, { movie, text: "Orla Fictive", from: 2, to: 3 });
        expect(answer.leaks.length).toBeGreaterThan(0);
        expect(answer.leaks.every((leak) => leak.source && leak.source.at >= 1 && leak.source.until <= 4)).toBe(true);
        // A whole-movie read is kept in the cache; a read of the range alone is not, so nothing is kept.
        expect(cachedScreenText(project)).toBeUndefined();
    }, 120_000);

    test("a leak inside an intro card gets a note, as no fix op reaches it (review CLI-F4)", async () => {
        const folder = mkdtempSync(join(tmpdir(), "gt-card-leak-"));
        const movie = await stillListMovie(folder, 6);
        const project = applyOp(
            wholeProject({ video: movie, durationUs: 6_000_000, width: W, height: H }),
            editOpSchema.parse({ op: "introCard", title: "Demo", seconds: 1 })
        );
        const path = join(folder, "still-list.edit.json");
        writeProject(path, project);
        // The movie stands in for the export: its first second is where the card plays.
        const answer = await verifyHidden(path, { movie, text: "Orla Fictive" });
        const inCard = answer.leaks.filter((leak) => leak.source === null);
        expect(inCard.length).toBeGreaterThan(0);
        expect(answer.notes).toEqual(expect.arrayContaining([expect.stringContaining("inside an intro or end card")]));
    }, 120_000);

    test("verifyHidden keeps each export frame it read by the file's content, and its range is in source time (round 8)", async () => {
        const folder = mkdtempSync(join(tmpdir(), "gt-verify-cache-"));
        const movie = join(folder, "export.mp4");
        await runVideoCommand({
            command: [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc=s=320x180:r=10:d=2",
                "-pix_fmt",
                "yuv420p",
                movie,
            ],
        });
        // The first run reads the frames and keeps them (here: lines given in place of Vision's).
        const lines = [{ text: "Orla Fictive", x: 0.1, y: 0.1, width: 0.3, height: 0.05 }];
        const first = exportFrameCache(movie);
        for (const atUs of [0, 500_000, 1_000_000, 1_500_000]) {
            first.set(atUs, lines);
        }
        first.flush();
        // A second run over the same file (a copy under another name too) finds them all, so Vision reads nothing.
        const copy = join(folder, "copy.mp4");
        await Bun.write(copy, Bun.file(movie));
        const frames = await ocrVideo({ video: copy, toUs: 2_000_000, fps: 2, cache: exportFrameCache(copy) });
        expect(frames.map((frame) => frame.atUs)).toEqual([0, 500_000, 1_000_000, 1_500_000]);
        expect(frames.every((frame) => frame.lines[0]?.text === "Orla Fictive")).toBe(true);

        // from/to in source seconds, a cut moment taken as the next or last kept one; the intro card leads.
        const project = applyOp(
            wholeProject({ video: movie, durationUs: 10_000_000, width: 320, height: 180 }),
            editOpSchema.parse({ op: "cut", from: 2, to: 4 })
        );
        expect(exportRangeOf(project, { from: 1, to: 6 })).toEqual({ fromUs: 1_000_000, toUs: 4_000_000 });
        expect(exportRangeOf(project, { from: 3, to: 9 })).toEqual({ fromUs: 2_000_000, toUs: 7_000_000 });
        expect(exportRangeOf(project, { from: 1, to: 2, timeBase: "output" })).toEqual({
            fromUs: 1_000_000,
            toUs: 2_000_000,
        });
        expect(exportRangeOf(project, {})).toBeUndefined();
    }, 60_000);

    test("a stretch is read by the frames' own times, never after an input seek, a gap keeping the frame before it (round 8)", async () => {
        const folder = mkdtempSync(join(tmpdir(), "gt-grid-read-"));
        const movie = join(folder, "vfr.mp4");
        // 120 frames a second for 2 s, then nothing for 0.7 s, then on (a simulator recording's gap).
        await runVideoCommand({
            command: [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=s=160x120:r=120:d=4",
                "-vf",
                "setpts='if(gte(N,240),PTS+0.7/TB,PTS)',format=yuv420p",
                "-fps_mode",
                "vfr",
                "-bf",
                "3",
                movie,
            ],
        });
        const plan = gridRead({ video: movie, fromUs: 2_500_000, toUs: 3_000_000, fps: 10, extra: "format=gray" });
        expect(plan.reads.flatMap((read) => read.args)).not.toContain("-ss");
        expect(plan.slots.map((slot) => slot.atUs)).toEqual([2_500_000, 2_600_000, 2_700_000, 2_800_000, 2_900_000]);
        // 2.5 and 2.6 s are inside the gap: the last frame before it (index 239) shows then.
        const times = framePresentationUs(movie);
        const selected = (slot: number) => plan.slots[slot].frame;
        expect(selected(0)).toBe(selected(1));
        expect(times[239]).toBeLessThan(2_000_000);
        const child = Bun.spawn(["ffmpeg", "-nostdin", "-v", "error", ...plan.reads[0].args, "-f", "rawvideo", "-"], {
            stdout: "pipe",
            stderr: "pipe",
            env: process.env,
        });
        const bytes = new Uint8Array(await new Response(child.stdout).arrayBuffer());
        const size = 160 * 120;
        expect(bytes.length).toBe(4 * size);
        // The same frames a decode from the start gives at those times.
        const whole = Bun.spawn(
            [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-i",
                movie,
                "-vf",
                "select='eq(n\\,239)+eq(n\\,240)',format=gray",
                "-fps_mode",
                "passthrough",
                "-f",
                "rawvideo",
                "-",
            ],
            { stdout: "pipe", stderr: "pipe", env: process.env }
        );
        const pair = new Uint8Array(await new Response(whole.stdout).arrayBuffer());
        expect(bytes.subarray(0, size)).toEqual(pair.subarray(0, size));
        expect(bytes.subarray(size, 2 * size)).toEqual(pair.subarray(size, 2 * size));
    }, 60_000);
});

describe("verifyHidden refuses a read rate it cannot use (review CLI-F1)", () => {
    // `--every 0` made the frame step 0 and the grid loop never ended; "0,5" (a decimal comma) read one frame only and
    // said "Nothing readable". Both are refused before anything is exported or read.
    test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.05, 6])("everySeconds %p is refused", async (every) => {
        await expect(verifyHidden("/nonexistent/verify.edit.json", { everySeconds: every })).rejects.toThrow(
            /everySeconds takes 0\.1 to 5/
        );
    });

    test.each([0, -2, Number.NaN, Number.POSITIVE_INFINITY])("ocrVideo fps %p is refused", async (fps) => {
        await expect(ocrVideo({ video: "/nonexistent/movie.mp4", toUs: 1_000_000, fps })).rejects.toThrow(
            /a positive number of frames a second/
        );
    });
});

describe("verifyHidden checks the names it is given", () => {
    test("names beside a text turn the private check on", () => {
        const matcher = verifyMatcherOf({ text: "Bob", names: ["Alice Example"] });
        expect(matcher("Alice Example").map((match) => match.kind)).toEqual(["name"]);
        expect(matcher("Bob").map((match) => match.kind)).toEqual(["text"]);
    });

    test("names with private: false are refused before anything is exported", async () => {
        expect(() => verifyMatcherOf({ names: ["Alice Example"], private: false })).toThrow(/names are private data/);
        await expect(
            verifyHidden("/nonexistent/verify.edit.json", { names: ["Alice Example"], private: false })
        ).rejects.toThrow(/names are private data/);
    });
});

describe("the export frame cache (review CLI-F5)", () => {
    // A run killed during a flush, two editors at once or a full disk left half a file, and every later verifyHidden
    // on that export threw a JSON parse error.
    test("a torn cache file starts empty instead of throwing, and the next flush writes a whole one", () => {
        const folder = mkdtempSync(join(tmpdir(), "gt-torn-cache-"));
        const movie = join(folder, "export.mp4");
        writeFileSync(movie, "an export's bytes for the content key");
        const path = toolDataDir("recorder", "verify-ocr", `${movieContentKey(movie)}.json`);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, '{"0":[{"text":"Orla Fic');

        const cache = exportFrameCache(movie);
        expect(cache.get(0)).toBeUndefined();

        cache.set(0, [{ text: "Orla Fictive", x: 0.1, y: 0.1, width: 0.3, height: 0.05 }]);
        cache.flush();
        expect(exportFrameCache(movie).get(0)?.[0]?.text).toBe("Orla Fictive");
    });
});
