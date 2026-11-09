import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import * as cli from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { tryWithPathArbitration } from "@genesiscz/utils/process/path-arbitration";
import recordingMovies from "@genesiscz/utils/recording-editor/__fixtures__/recording-movies.json";
import screenSearch from "@genesiscz/utils/recording-editor/__fixtures__/screen-search.json";
import { applyOp, wholeProject, writeProject } from "@genesiscz/utils/recording-editor/project";
import { RecorderControl, type RecorderMethod, type StopAnswer } from "@genesiscz/utils/screen-recorder/control";
import { recordingsLibraryDir } from "@genesiscz/utils/screen-recorder/library";
import { LiveRecordingServer } from "@genesiscz/utils/screen-recorder/live";
import { recordingStoreOf } from "@genesiscz/utils/screen-recorder/recording-stores";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import {
    computeEdit,
    exportProgressPrinter,
    exportTargetOf,
    parseExportSize,
    renderInto,
    withEditCancel,
} from "./edit";
import { EditSessions } from "./edit-session";
import { displaySwitchDepth, keepingSwitchStep, keptPlan, stepDisplaySwitch } from "./frames-movie";
import { privateData } from "./fx-analysis";
import {
    describeLiveEntries,
    editorOpenStatePath,
    findLiveEntry,
    framesCell,
    libraryRow,
    listLibrary,
    movieOf,
    readEditorOpenState,
    resolveRecording,
    shortRecordingId,
    snapshotArgv,
} from "./library";
import { searchLibrary } from "./moments";
import {
    boxInProxy,
    chosenPlan,
    framesForPlan,
    overrideRanges,
    parseDisplayPlan,
    planMostChange,
    proxyCanvas,
    proxyVideoFilter,
} from "./proxy";
import { currentGif, shareableMovie, trashRecording, trashRecordings } from "./quick-actions";
import { screenHitsWithOps } from "./screen-ops";
import { findOnScreen } from "./screen-search";

function writeState(state: Record<string, unknown>): void {
    mkdirSync(dirname(editorOpenStatePath()), { recursive: true });
    writeFileSync(
        editorOpenStatePath(),
        SafeJSON.stringify({ version: 1, updatedAt: "2026-11-04T10:00:00.000Z", ...state })
    );
}

/** The writer is this test, which is no GenesisTools process: the alive cases say so through the injected check. */
const alive = { alive: () => true };
const first = { path: "/tmp/recordings/first", title: "First" };
const second = { path: "/tmp/recordings/second", title: "Second" };

describe("the recording open in the editor", () => {
    afterEach(() => writeState({ open: [] }));

    it("names the window last in front", () => {
        writeState({ pid: process.pid, open: [first, second], front: second });

        expect(resolveRecording("open", alive)).toBe(second.path);
    });

    it("takes the only open window when none came to the front", () => {
        writeState({ pid: process.pid, open: [first] });

        expect(resolveRecording("open", alive)).toBe(first.path);
    });

    it("refuses with the library command when several windows are open and none is in front", () => {
        writeState({ pid: process.pid, open: [first, second] });

        expect(() => resolveRecording("open", alive)).toThrow("recorder library");
    });

    it("drops the windows of an editor process that is gone", () => {
        writeState({ pid: 2_147_483_000, open: [first], front: first });

        expect(readEditorOpenState()?.open).toEqual([]);
        expect(() => resolveRecording("open")).toThrow("No recording is open");
    });
});

describe("a recording named by an edit file the editor has not written yet", () => {
    // Regression test: deep test 2026-11-06 RC9 — the service refused session.open of a recording never edited, as
    // "not a path and not a library id", because its edit.json did not exist yet.
    it("names the recording folder, or the plain movie beside it", () => {
        const recording = mkdtempSync(join(tmpdir(), "rc9-recording-"));
        writeFileSync(join(recording, "recording.json"), "{}");
        writeFileSync(join(recording, "screen.mp4"), "");
        const movies = mkdtempSync(join(tmpdir(), "rc9-movies-"));
        writeFileSync(join(movies, "talk.mov"), "");

        expect(resolveRecording(join(recording, "edit.json"))).toBe(recording);
        expect(resolveRecording(join(movies, "talk.edit.json"))).toBe(join(movies, "talk.mov"));
        expect(() => resolveRecording(join(movies, "other.edit.json"))).toThrow("not a path and not a library id");
        expect(() => resolveRecording(join(movies, "edit.json"))).toThrow("not a path and not a library id");
    });
});

describe("which display a proxy of several displays shows", () => {
    const frame = (displayId: number, sec: number, changePercent = 0) => ({
        path: `/f/${displayId}-${sec}.jpg`,
        atUs: sec * 1_000_000,
        displayId,
        changePercent,
    });

    it("per window the display that changed most, a tie or an empty window keeping the one before", () => {
        const frames = [
            frame(1, 0, 5),
            frame(4, 1, 2),
            frame(4, 12, 30),
            frame(1, 14, 3),
            frame(1, 25, 10),
            frame(4, 26, 10),
            frame(1, 41, 1),
        ];

        expect(planMostChange(frames, 10_000_000)).toEqual([
            { fromUs: 0, toUs: 10_000_000, displayId: 1 },
            { fromUs: 10_000_000, toUs: 40_000_000, displayId: 4 },
            { fromUs: 40_000_000, toUs: 50_000_000, displayId: 1 },
        ]);
        expect(planMostChange([frame(2, 0), frame(2, 3), frame(3, 4)], 10_000_000)).toEqual([
            { fromUs: 0, toUs: 10_000_000, displayId: 2 },
        ]);
    });

    it("an override wins inside its range and merges with a neighbour of its display", () => {
        const ranges = [
            { fromUs: 0, toUs: 10, displayId: 1 },
            { fromUs: 10, toUs: 30, displayId: 4 },
            { fromUs: 30, toUs: 50, displayId: 1 },
        ];

        expect(overrideRanges(ranges, [{ fromUs: 5, toUs: 20, displayId: 1 }])).toEqual([
            { fromUs: 0, toUs: 20, displayId: 1 },
            { fromUs: 20, toUs: 30, displayId: 4 },
            { fromUs: 30, toUs: 50, displayId: 1 },
        ]);
    });

    it("each range opens with its display's frame still on screen, and the movie starts at 0", () => {
        const frames = [frame(1, 2), frame(4, 3), frame(1, 8), frame(4, 15), frame(1, 21)];
        const shown = framesForPlan(frames, [
            { fromUs: 0, toUs: 10_000_000, displayId: 1 },
            { fromUs: 10_000_000, toUs: 20_000_000, displayId: 4 },
            { fromUs: 20_000_000, toUs: 30_000_000, displayId: 1 },
        ]);

        expect(shown.map((one) => [one.path, one.atUs / 1_000_000])).toEqual([
            ["/f/1-2.jpg", 0],
            ["/f/1-8.jpg", 8],
            ["/f/4-3.jpg", 10],
            ["/f/4-15.jpg", 15],
            ["/f/1-8.jpg", 20],
            ["/f/1-21.jpg", 21],
        ]);
    });
});

describe("a display switch from the editor", () => {
    it("keeps the saved plan and lays the new switch over it, so every earlier switch stays", () => {
        const folder = mkdtempSync(join(tmpdir(), "gt-plan-"));
        expect(keptPlan(folder, [{ fromUs: 0, toUs: 5, displayId: 2 }])).toEqual({
            overrides: [{ fromUs: 0, toUs: 5, displayId: 2 }],
        });
        const ranges = [
            { fromUs: 0, toUs: 20_000_000, displayId: 1 },
            { fromUs: 20_000_000, toUs: 40_000_000, displayId: 4 },
        ];
        writeFileSync(
            join(folder, "proxy.json"),
            SafeJSON.stringify({ version: 1, policy: "most-change", windowSec: 5, ranges })
        );
        const kept = keptPlan(folder, [{ fromUs: 5_000_000, toUs: 25_000_000, displayId: 2 }]);
        expect(kept.windowSec).toBe(5);
        expect(overrideRanges(planMostChange([], 1), kept.overrides)).toEqual([
            { fromUs: 0, toUs: 5_000_000, displayId: 1 },
            { fromUs: 5_000_000, toUs: 25_000_000, displayId: 2 },
            { fromUs: 25_000_000, toUs: 40_000_000, displayId: 4 },
        ]);
    });

    it("a switch is one step in proxy.undo.json that the CLI and the REPL undo and redo, refused after another plan", async () => {
        const folder = mkdtempSync(join(tmpdir(), "gt-switch-undo-"));
        const plan = (displayId: number) => ({
            version: 1 as const,
            policy: "most-change" as const,
            windowSec: 10,
            ranges: [{ fromUs: 0, toUs: 20_000_000, displayId }],
        });
        const write = (value: unknown) => writeFileSync(join(folder, "proxy.json"), SafeJSON.stringify(value));
        // The proxy maker, as prepareFramesMovie saves its plan; `asked` keeps what each undo or redo asked for.
        const asked: unknown[] = [];
        const make = async (options: { plan?: unknown }) => {
            asked.push(options);
            write({ version: 1, ...(options.plan ?? plan(9)) });
            return { path: join(folder, "proxy.mp4"), frames: 1, audioPieces: 0, plan: plan(1) };
        };

        await expect(stepDisplaySwitch(folder, "undo", make)).rejects.toThrow("no display switch to undo");
        write(plan(1));
        await keepingSwitchStep(folder, async () => write(plan(2)));
        expect(displaySwitchDepth(folder)).toEqual({ undo: 1, redo: 0 });

        await stepDisplaySwitch(folder, "undo", make);
        expect(asked.at(-1)).toEqual({ plan: plan(1) });
        expect(displaySwitchDepth(folder)).toEqual({ undo: 0, redo: 1 });
        await stepDisplaySwitch(folder, "redo", make);
        expect(asked.at(-1)).toEqual({ plan: plan(2) });
        expect(displaySwitchDepth(folder)).toEqual({ undo: 1, redo: 0 });

        // Another plan since (a proxy made with --plan): the undo would throw it away, so it is refused.
        write(plan(3));
        await expect(stepDisplaySwitch(folder, "undo", make)).rejects.toThrow("changed since that switch");
        expect(displaySwitchDepth(folder)).toEqual({ undo: 1, redo: 0 });

        // A switch on a proxy from before plans undoes to the policy's own pick.
        const old = mkdtempSync(join(tmpdir(), "gt-switch-undo-old-"));
        await keepingSwitchStep(old, async () => writeFileSync(join(old, "proxy.json"), SafeJSON.stringify(plan(2))));
        const calls: unknown[] = [];
        const regenerate = async (options: { plan?: unknown }) => {
            calls.push(options);
            writeFileSync(join(old, "proxy.json"), SafeJSON.stringify(options.plan ?? plan(1)));
            return { path: join(old, "proxy.mp4"), frames: 1, audioPieces: 0, plan: plan(1) };
        };
        await stepDisplaySwitch(old, "undo", regenerate);
        expect(calls).toEqual([{}]);
        await stepDisplaySwitch(old, "redo", regenerate);
        expect(SafeJSON.parse(readFileSync(join(old, "proxy.json"), "utf8"))).toEqual(plan(2));
    });

    it("an undo makes the proxy with exactly the plan from before the switch, never the policy's pick", () => {
        const frames = [1, 4, 1, 4].map((displayId, index) => ({
            path: `/f/${index}.jpg`,
            atUs: index * 6_000_000,
            displayId,
            changePercent: displayId === 4 ? 50 : 1,
        }));
        const before = {
            policy: "most-change" as const,
            windowSec: 10,
            ranges: [
                { fromUs: 0, toUs: 12_000_000, displayId: 1 },
                { fromUs: 12_000_000, toUs: 18_000_001, displayId: 4 },
            ],
        };

        expect(chosenPlan(frames, { plan: before })).toEqual({ version: 1, ...before });
        expect(chosenPlan(frames, {}).ranges).not.toEqual(before.ranges);
        expect(() =>
            chosenPlan(frames, { plan: { ...before, ranges: [{ fromUs: 0, toUs: 1, displayId: 9 }] } })
        ).toThrow("the plan shows display 9, which has no frames");
        expect(() => chosenPlan(frames, { plan: before, display: 1 })).toThrow("without a display or switches");
        expect(parseDisplayPlan({ version: 1, ...before })).toEqual({ version: 1, ...before });
    });
});

describe("the proxy's picture size", () => {
    it("one size keeps the frames; several sizes letterbox into the largest even width and height", () => {
        expect(proxyVideoFilter([{ width: 2560, height: 1440 }])).toBe("scale=trunc(iw/2)*2:trunc(ih/2)*2");
        expect(
            proxyVideoFilter([
                { width: 2560, height: 1440 },
                { width: 2880, height: 1861 },
            ])
        ).toBe(
            "scale=2880:1862:force_original_aspect_ratio=decrease,pad=2880:1862:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1"
        );
    });
});

/** A recording folder with files, each `[name, seconds since 2026-11-04 10:00]`, so their order is known. */
function folderWith(files: Array<[string, number]>): string {
    const folder = mkdtempSync(join(tmpdir(), "gt-quick-"));

    for (const [name, offset] of files) {
        writeFileSync(join(folder, name), "x");
        const at = new Date(Date.UTC(2026, 10, 4, 10, 0, offset));
        utimesSync(join(folder, name), at, at);
    }

    return folder;
}

// The Swift menu, library and editor answer the same cases (RecorderEditTests.swift, RecordingMovie.swift).
describe("the movie of a recording folder", () => {
    for (const item of recordingMovies.cases) {
        it(`shared movie case: ${item.name}`, () => {
            const folder = folderWith(item.files.map(([name, offset]) => [String(name), Number(offset)]));
            const name = (path: string | undefined) => (path ? basename(path) : null);

            expect(name(movieOf(folder))).toBe(item.movie);
            expect(name(shareableMovie(folder))).toBe(item.shareable);
        });
    }
});

/** The shared fixture's meeting folder; `ranges` replaces its display plan. */
function screenFolder(ranges?: Array<{ fromUs: number; toUs: number; displayId: number }>): string {
    const folder = mkdtempSync(join(tmpdir(), "gt-screen-"));
    mkdirSync(join(folder, "frames"));

    // The first 33 bytes of a PNG of each display's size: enough for imageSize, which reads only the header.
    for (const frame of screenSearch.recording.manifest.frames) {
        const [width, height] = screenSearch.recording.frameSizes[String(frame.displayId) as "1" | "4"];
        const header = Buffer.alloc(33);
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
        header.writeUInt32BE(13, 8);
        header.write("IHDR", 12, "ascii");
        header.writeUInt32BE(width, 16);
        header.writeUInt32BE(height, 20);
        header.writeUInt8(8, 24);
        header.writeUInt8(6, 25);
        writeFileSync(join(folder, frame.file), header);
    }

    writeFileSync(join(folder, "recording.json"), SafeJSON.stringify(screenSearch.recording.manifest));
    writeFileSync(
        join(folder, "ocr.jsonl"),
        screenSearch.recording.ocr.map((row) => SafeJSON.stringify(row)).join("\n")
    );
    writeFileSync(
        join(folder, "proxy.json"),
        SafeJSON.stringify(ranges ? { ...screenSearch.recording.plan, ranges } : screenSearch.recording.plan)
    );
    return folder;
}

// The editor's Find tab decodes these hits (RecorderEditTests.swift), so it reads what find-screen prints.
describe("text on the screen", () => {
    for (const ending of ["run", "moved", "display", "gap"] as const) {
        it(`extends a line's hide and mark through consecutive frames: ${ending}`, () => {
            const folder = screenFolder([{ fromUs: 0, toUs: 8_000_000, displayId: 1 }]);
            const frames = [0, 1, 2, 3].map((atMs) => ({
                file: `frames/run-${atMs}.png`,
                atMs: atMs * 1000,
                displayId: 1,
            }));
            const header = readFileSync(join(folder, screenSearch.recording.manifest.frames[0].file));
            for (const frame of frames) {
                writeFileSync(join(folder, frame.file), header);
            }
            if (ending === "display") {
                frames[1].displayId = 4;
                writeFileSync(
                    join(folder, "proxy.json"),
                    SafeJSON.stringify({
                        ...screenSearch.recording.plan,
                        ranges: [
                            { fromUs: 0, toUs: 1_000_000, displayId: 1 },
                            { fromUs: 1_000_000, toUs: 2_000_000, displayId: 4 },
                            { fromUs: 2_000_000, toUs: 8_000_000, displayId: 1 },
                        ],
                    })
                );
            }
            writeFileSync(
                join(folder, "recording.json"),
                SafeJSON.stringify({ ...screenSearch.recording.manifest, frames })
            );
            writeFileSync(
                join(folder, "ocr.jsonl"),
                frames
                    .map((frame, index) =>
                        SafeJSON.stringify({
                            ...frame,
                            text: index === 3 || (ending === "gap" && index === 1) ? "absent" : "secret",
                            blocks: [
                                {
                                    text: index === 3 || (ending === "gap" && index === 1) ? "absent" : "secret",
                                    bounds: {
                                        x: ending === "moved" && index === 1 ? 0.5 : 0.1,
                                        y: 0.2,
                                        width: 0.2,
                                        height: 0.03,
                                    },
                                },
                            ],
                        })
                    )
                    .join("\n")
            );
            const [hit] = screenHitsWithOps(findOnScreen(folder, "secret", { limit: 1 }), 5);
            const end = ending === "run" ? 3 : 1;
            expect(hit.ops.hide).toHaveLength(1);
            expect(hit.ops.hide[0]).toMatchObject({ op: "redact", from: 0, to: end });
            expect(hit.ops.mark[0]).toMatchObject({ op: "shape", from: 0, to: end });
            expect(hit.ops.cut).toEqual([{ op: "cut", from: 0, to: 1 }]);
            expect(screenHitsWithOps([hit], 0.5)[0].ops.hide[0]).toMatchObject({ to: 0.5 });
        });
    }

    // Regression test: deep test 2026-11-07 R2-RE6 — Find on Screen on a movie recording answered "No frame shows
    // “Changes”" while the word was on screen: a movie keeps no frames, so there was nothing to search.
    it("refuses a movie recording, which keeps no screen text, instead of answering that no frame shows the text", () => {
        const folder = mkdtempSync(join(tmpdir(), "gt-screen-movie-"));
        writeFileSync(
            join(folder, "recording.json"),
            SafeJSON.stringify({ ...screenSearch.recording.manifest, frames: [] })
        );

        expect(() => findOnScreen(folder, "Changes")).toThrow("has no screen text");
    });

    it("finds the shared fixture's hits: accents ignored, each listed where the proxy movie shows it, boxes placed in the letterboxed picture", () => {
        const folder = screenFolder();

        expect(findOnScreen(folder, screenSearch.query)).toEqual(screenSearch.proxyHits);
        expect(findOnScreen(folder, "   ")).toEqual([]);
        expect(findOnScreen(folder, "token", { limit: 1 })).toHaveLength(1);

        // A box is a hidden part's rect as it is: the redact op hides that line while its frame shows.
        const [first] = findOnScreen(folder, "token");
        const [box] = first.boxes;
        const hidden = applyOp(
            wholeProject({ video: join(folder, "proxy.mp4"), durationUs: 15_000_000, width: 2880, height: 1800 }),
            {
                op: "redact",
                from: first.sec,
                to: first.untilSec,
                rect: { x: box.x, y: box.y, width: box.width, height: box.height },
            }
        );
        expect(hidden.redactions?.map((part) => [part.startUs, part.endUs, part.x, part.y])).toEqual([
            [0, 9_000_000, 0.1, 0.35],
        ]);
    });

    it("lists a text captured while another display showed when the proxy switches to its display", () => {
        const hits = findOnScreen(screenFolder(), "token rotation");

        expect(hits.map((hit) => [hit.sec, hit.untilSec, hit.shown])).toEqual([[10, 12.5, true]]);
        expect(hits[0].boxes).toHaveLength(1);
    });

    it("ends a hit where the proxy leaves its display and lists each time the proxy comes back", () => {
        const back = screenFolder([
            { fromUs: 0, toUs: 5_000_000, displayId: 1 },
            { fromUs: 5_000_000, toUs: 7_000_000, displayId: 4 },
            { fromUs: 7_000_000, toUs: 12_500_001, displayId: 1 },
        ]);

        expect(findOnScreen(back, "sprint board").map((hit) => [hit.file, hit.sec, hit.untilSec])).toEqual([
            ["frames/0001.jpg", 0, 5],
            ["frames/0001.jpg", 7, 9],
            ["frames/0003.jpg", 9, 13.5],
        ]);
        expect(findOnScreen(back, "token rotation").map((hit) => [hit.sec, hit.untilSec, hit.shown])).toEqual([
            [5, 7, true],
        ]);
    });

    it("lists a text of a display the plan never shows as not shown, without boxes", () => {
        const only1 = screenFolder([{ fromUs: 0, toUs: 12_500_001, displayId: 1 }]);

        expect(
            findOnScreen(only1, "token rotation").map((hit) => [hit.sec, hit.untilSec, hit.shown, hit.boxes])
        ).toEqual([[4, 12.5, false, []]]);
    });

    // The plan's B2 (2026-11-04): a box the Find tab found becomes a hidden part, a box annotation or a cut, through
    // the edit ops the answer names; the window sends them as they are.
    it("names the ops that hide, mark or cut a hit, inside the picture and inside the movie", () => {
        const [first, other, last] = screenHitsWithOps(screenSearch.hits, 15);
        const [hide] = last.ops.hide;
        const [mark] = last.ops.mark;

        expect(hide).toMatchObject({ op: "redact", from: 12.5, to: 14.5, style: "blur", label: "Tokén list" });
        expect(hide.op === "redact" && [hide.rect.x, hide.rect.y, hide.rect.width, hide.rect.height]).toEqual([
            expect.closeTo(0.196, 9),
            expect.closeTo(0.721, 9),
            expect.closeTo(0.258, 9),
            expect.closeTo(0.053, 9),
        ]);
        expect(mark).toMatchObject({ op: "shape", kind: "box", from: 12.5, to: 14.5 });
        expect(mark.op === "shape" && [mark.start?.x, mark.start?.y, mark.end?.x, mark.end?.y]).toEqual([
            expect.closeTo(0.192, 9),
            expect.closeTo(0.717, 9),
            expect.closeTo(0.458, 9),
            expect.closeTo(0.778, 9),
        ]);
        expect(last.ops.cut).toEqual([{ op: "cut", from: 12.5, to: 14.5 }]);
        expect(first.ops.hide).toHaveLength(first.boxes.length);
        expect(other.ops).toEqual({ hide: [], mark: [], cut: [] });

        // A box at the picture's edge stays inside it, and the frame's span stays inside the movie.
        const [edge] = screenHitsWithOps(
            [{ ...first, boxes: [{ text: "x", x: 0.99, y: 0, width: 0.01, height: 0.02 }] }],
            5
        );
        const [edgeHide] = edge.ops.hide;
        expect(edgeHide.op === "redact" && edgeHide.rect.x + edgeHide.rect.width).toBeLessThanOrEqual(1 + 1e-9);
        expect(edgeHide).toMatchObject({ from: 0, to: 5, rect: { y: 0 } });
        expect(edge.ops.cut).toEqual([{ op: "cut", from: 0, to: 5 }]);
        expect(screenHitsWithOps([first], 0)[0].ops).toEqual({ hide: [], mark: [], cut: [] });
    });

    it("places a frame box in the proxy picture as the scale and pad of the video filter do", () => {
        const sizes = [
            { width: 2880, height: 1800 },
            { width: 2560, height: 1440 },
        ];
        const canvas = proxyCanvas(sizes);
        expect(canvas).toEqual({ width: 2880, height: 1800, letterboxed: true });
        expect(proxyVideoFilter(sizes)).toContain("scale=2880:1800:force_original_aspect_ratio=decrease");
        const box = { x: 0.5, y: 0, width: 0.5, height: 1 };
        expect(boxInProxy(box, sizes[1], canvas)).toEqual({ x: 0.5, y: 0.05, width: 0.5, height: 0.9 });
        const single = proxyCanvas([sizes[0], sizes[0]]);
        expect(single.letterboxed).toBe(false);
        expect(boxInProxy(box, sizes[0], single)).toEqual(box);
    });
});

/**
 * A frames recording that ends 10 s after it starts, its last frame at 1 s: proxy.mp4 holds that frame until 10 s
 * (makeProxy). `frames` are its frames with their OCR text; `plan` is its proxy.json ranges, if any.
 */
function tailFolder(
    frames: Array<{ file: string; atMs: number; displayId: number; text: string }>,
    plan?: Array<{ fromUs: number; toUs: number; displayId: number }>
): string {
    const folder = mkdtempSync(join(tmpdir(), "gt-screen-tail-"));
    mkdirSync(join(folder, "frames"));
    // The first 33 bytes of a 1600x1000 PNG: enough for imageSize, which reads only the header.
    const header = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
    header.writeUInt32BE(13, 8);
    header.write("IHDR", 12, "ascii");
    header.writeUInt32BE(1600, 16);
    header.writeUInt32BE(1000, 20);
    header.writeUInt8(8, 24);
    header.writeUInt8(6, 25);

    for (const frame of frames) {
        writeFileSync(join(folder, frame.file), header);
        const blocks = frame.text ? [{ text: frame.text, bounds: { x: 0.2, y: 0.47, width: 0.4, height: 0.03 } }] : [];
        writeFileSync(join(folder, `${frame.file}.ocr.json`), SafeJSON.stringify({ text: frame.text, blocks }));
    }

    writeFileSync(
        join(folder, "recording.json"),
        SafeJSON.stringify({
            version: 1,
            id: "tail",
            title: "Tail",
            startedAt: "2026-11-09T10:00:00.000Z",
            endedAt: "2026-11-09T10:00:10.000Z",
            displays: [
                { id: 1, name: "Main" },
                { id: 2, name: "Side" },
            ],
            frames: frames.map(({ file, atMs, displayId }) => ({ file, atMs, displayId })),
        })
    );

    if (plan) {
        writeFileSync(
            join(folder, "proxy.json"),
            SafeJSON.stringify({ version: 1, policy: "most-change", windowSec: 10, ranges: plan })
        );
    }

    return folder;
}

const still = [
    { file: "frames/f0.png", atMs: 0, displayId: 1, text: "Inbox" },
    { file: "frames/f1.png", atMs: 1000, displayId: 1, text: "Mail alice@example.com now" },
];

describe("a frames recording's last frame shows until the recording ends", () => {
    it("find-screen ends the last frame's hit at the recording's end, with or without a display plan", () => {
        const plan = chosenPlan(
            still.map((frame) => ({ path: frame.file, atUs: frame.atMs * 1000, displayId: frame.displayId })),
            { display: 1 }
        ).ranges;

        for (const folder of [tailFolder(still), tailFolder(still, plan)]) {
            const hits = findOnScreen(folder, "alice");
            expect(hits.map((hit) => [hit.sec, hit.untilSec, hit.shown])).toEqual([[1, 10, true]]);
            expect(screenHitsWithOps(hits, 10)[0].ops.hide[0]).toMatchObject({ from: 1, to: 10 });
            // A frame followed by another frame of its display still ends at that frame.
            expect(findOnScreen(folder, "inbox").map((hit) => [hit.sec, hit.untilSec, hit.shown])).toEqual([
                [0, 1, true],
            ]);
        }
    });

    it("lists a frame the plan shows after the last frame as shown until the recording ends", () => {
        const folder = tailFolder(
            [
                { file: "frames/a.png", atMs: 0, displayId: 1, text: "Inbox" },
                { file: "frames/b.png", atMs: 500, displayId: 2, text: "Invoice 2026" },
                { file: "frames/c.png", atMs: 1000, displayId: 1, text: "Inbox" },
            ],
            [
                { fromUs: 0, toUs: 5_000_000, displayId: 1 },
                { fromUs: 5_000_000, toUs: 10_000_000, displayId: 2 },
            ]
        );

        expect(findOnScreen(folder, "invoice").map((hit) => [hit.sec, hit.untilSec, hit.shown])).toEqual([
            [5, 10, true],
        ]);
        expect(findOnScreen(folder, "inbox").map((hit) => [hit.file, hit.sec, hit.untilSec])).toEqual([
            ["frames/a.png", 0, 1],
            ["frames/c.png", 1, 5],
        ]);
    });

    it("hidePrivate and hideText blur the last frame's text until the recording ends", async () => {
        const folder = tailFolder(still);
        const project = wholeProject({
            video: join(folder, "proxy.mp4"),
            durationUs: 10_000_000,
            width: 1600,
            height: 1000,
        });

        expect((await privateData(project)).map((hit) => hit.to)).toEqual([10]);

        for (const op of [{ op: "hidePrivate" as const }, { op: "hideText" as const, text: "alice" }]) {
            const edit = await computeEdit({ project, ops: [op], fresh: true });
            expect(edit.project.redactions?.map((part) => part.endUs)).toEqual([10_000_000]);
        }
    });
});

describe("exportTargetOf: the one file name rule of an export", () => {
    const folder = mkdtempSync(join(tmpdir(), "export-target-"));
    const video = join(folder, "screen.mp4");
    const base = wholeProject({ video, durationUs: 20_000_000, width: 1920, height: 1080 });
    const cwd = join(folder, "cwd");

    it("--out keeps its name and takes the format's extension, with or without overwrite", () => {
        for (const overwrite of [false, true]) {
            expect(exportTargetOf({ project: base, format: "mp4", out: "clip.mov", overwrite, cwd })).toBe(
                join(cwd, "clip.mp4")
            );
        }
        expect(exportTargetOf({ project: base, format: "gif", out: "~/Movies/x.mp4", cwd })).toBe(
            join(homedir(), "Movies/x.gif")
        );
    });

    it("a chosen file with ~ is the home folder and a relative one is beside the movie", () => {
        const tilde = { ...base, export: { ...base.export, output: "~/Movies/demo.mp4" } };
        expect(exportTargetOf({ project: tilde, format: "gif", cwd })).toBe(join(homedir(), "Movies/demo.gif"));
        const relative = { ...base, export: { ...base.export, output: "out/demo.mp4" } };
        expect(exportTargetOf({ project: relative, format: "mp4", cwd })).toBe(join(folder, "out/demo.mp4"));
    });

    it("a part is named after the whole target in its folder (RecorderHuntExportTargetOneRuleTests has the same case)", () => {
        const chosen = { ...base, export: { ...base.export, output: "/exports/demo.mp4" } };
        const part = { fromUs: 5_000_000, toUs: 12_000_000 };
        expect(exportTargetOf({ project: chosen, format: "gif", part, cwd })).toBe("/exports/demo-part-5.0-12.0.gif");
    });

    it("the default name takes -2 when the first is taken, unless overwrite", () => {
        const first = exportTargetOf({ project: base, format: "webm", cwd });
        writeFileSync(first, "");
        expect(exportTargetOf({ project: base, format: "webm", cwd })).toBe(first.replace(/\.webm$/, "-2.webm"));
        expect(exportTargetOf({ project: base, format: "webm", overwrite: true, cwd })).toBe(first);
    });

    it("applyOp exportSettings stores a chosen file absolute", () => {
        expect(applyOp(base, { op: "exportSettings", output: "~/x.mp4" }).export.output).toBe(join(homedir(), "x.mp4"));
        expect(applyOp(base, { op: "exportSettings", output: "" }).export.output).toBe("");
    });

    it("Copy as GIF finds a GIF exported to a file chosen outside the folder while the edit is older", () => {
        const recording = mkdtempSync(join(tmpdir(), "gif-current-"));
        const elsewhere = mkdtempSync(join(tmpdir(), "gif-chosen-"));
        const movie = join(recording, "screen.mp4");
        writeFileSync(movie, "x");
        const project = wholeProject({ video: movie, durationUs: 4_000_000, width: 320, height: 180 });
        writeProject(join(recording, "edit.json"), {
            ...project,
            export: { ...project.export, output: join(elsewhere, "demo.mp4") },
        });
        const gif = join(elsewhere, "demo.gif");
        writeFileSync(gif, "x");
        const old = new Date(Date.UTC(2026, 10, 4, 10, 0, 0));
        utimesSync(movie, old, old);
        utimesSync(join(recording, "edit.json"), old, old);
        expect(currentGif(recording)).toBe(gif);
        const later = new Date(Date.now() + 60_000);
        utimesSync(join(recording, "edit.json"), later, later);
        expect(currentGif(recording)).toBeUndefined();
    });
});

describe("a recording's quick actions", () => {
    it("copies the newest export, else the recording's own movie", () => {
        expect(shareableMovie(folderWith([["screen.mp4", 0]]))).toEndWith("/screen.mp4");
        const exported = folderWith([
            ["screen.mp4", 0],
            ["screen-edited.mp4", 10],
            ["screen-edited.gif", 20],
            ["screen-edited.partial.mp4", 30],
        ]);
        expect(shareableMovie(exported)).toEndWith("/screen-edited.gif");
    });

    it("reuses a GIF only while the edit and the movie are older than it", () => {
        const fresh = folderWith([
            ["screen.mp4", 0],
            ["edit.json", 5],
            ["screen-edited.gif", 10],
        ]);
        expect(currentGif(fresh)).toEndWith("/screen-edited.gif");
        const stale = folderWith([
            ["screen.mp4", 0],
            ["screen-edited.gif", 10],
            ["edit.json", 20],
        ]);
        expect(currentGif(stale)).toBeUndefined();
    });

    it("knows a meeting's folder, opens its record, and never moves it to the Trash", async () => {
        const meetings = mkdtempSync(join(tmpdir(), "gt-meetings-"));
        const meeting = join(meetings, "2026-11-04_10-00-standup");
        mkdirSync(meeting);
        writeFileSync(join(meeting, "meeting.json"), "{}");

        const roots = { meetings };
        const store = recordingStoreOf(meeting, roots);

        expect(store?.id).toBe("meetings");
        expect(recordingStoreOf(`${meetings}-other/x`, roots)).toBeUndefined();
        expect(store?.recordOf?.(meeting)).toBe(join(meeting, "meeting.json"));
        expect(store?.recordOf?.(folderWith([["screen.mp4", 0]]))).toBeUndefined();
        // The refusal comes before anything is moved: the folder is still there.
        await expect(trashRecording(meeting, { roots })).rejects.toThrow("holds the whole meeting");
        expect(existsSync(join(meeting, "meeting.json"))).toBe(true);
    });
});

it("retains a released dirty session until its busy save can finish", async () => {
    const folder = mkdtempSync(join(tmpdir(), "edit-busy-"));
    const path = join(folder, "edit.json");
    writeProject(
        path,
        wholeProject({ video: join(folder, "screen.mp4"), durationUs: 1_000_000, width: 640, height: 480 })
    );
    const sessions = new EditSessions({ onChange: () => undefined, saveDelayMs: 100 });
    const session = await sessions.hold(path);
    await session.apply([{ op: "volume", volume: 0.4 }], { by: "fixture" });
    await tryWithPathArbitration(path, async () => {
        sessions.release(path);
        expect(sessions.size).toBe(1);
        expect(session.dirty).toBe(true);
    });
    await Bun.sleep(250);
    expect(sessions.size).toBe(0);
    expect(SafeJSON.parse(readFileSync(path, "utf8")).audio.volume).toBe(0.4);
});

it("a library recording.json that is not JSON gives no row and leaves the others listed", () => {
    const root = mkdtempSync(join(tmpdir(), "library-bound-"));
    const newest = join(root, "video-2026-11-05_10-00-00-new");
    const oldest = join(root, "video-2026-01-01_10-00-00-old");
    mkdirSync(newest);
    mkdirSync(oldest);
    writeFileSync(join(oldest, "recording.json"), "{broken");
    writeFileSync(
        join(newest, "recording.json"),
        SafeJSON.stringify({
            version: 1,
            id: "new",
            title: "new",
            startedAt: "2026-11-05T10:00:00Z",
            displays: [],
            frames: [],
        })
    );
    expect(listLibrary({ root, limit: 1 }).map((row) => row.id)).toEqual(["new"]);
});

describe("the library list reads every recording as the Recordings window does", () => {
    const write = (folder: string, manifest: Record<string, unknown>) => {
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, "recording.json"), SafeJSON.stringify(manifest));
    };
    const manifest = (id: string, startedAt: string, title = id) => ({
        version: 1,
        id,
        title,
        startedAt,
        displays: [],
        frames: [],
    });

    it("sorts by startedAt before the limit, so a duplicate does not push the newest out", () => {
        const root = mkdtempSync(join(tmpdir(), "library-one-reader-"));
        write(join(root, "video-2026-11-01_10-00-00-a"), manifest("a", "2026-11-01T10:00:00Z"));
        write(join(root, "video-2026-11-05_10-00-00-b"), manifest("b", "2026-11-05T10:00:00Z"));
        write(join(root, "video-2026-11-08_10-00-00-c"), manifest("c", "2026-11-08T10:00:00Z"));
        // A copy of A made on 11-09 keeps A's startedAt.
        write(join(root, "video-2026-11-09_10-00-00-copy"), manifest("copy", "2026-11-01T10:00:00Z", "a (copy)"));
        const all = listLibrary({ root }).map((row) => row.id);
        expect(all).toEqual(["c", "b", "copy", "a"]);
        expect(listLibrary({ root, limit: 2 }).map((row) => row.id)).toEqual(all.slice(0, 2));
        expect(listLibrary({ root, limit: 1 })[0]?.id).toBe("c");
    });

    it("lists and finds a meeting's screen recording beside the library's", () => {
        write(recordingsLibraryDir("video-2026-11-04_09-00-00-lib"), manifest("lib-one", "2026-11-04T09:00:00Z"));
        const meeting = toolDataDir("meetings", "2026-11-05_14-29-meeting");
        write(meeting, manifest("2026-11-05_14-29-meeting", "2026-11-05T14:29:00Z", "Weekly sync zebra"));
        writeFileSync(join(meeting, "proxy.mp4"), "");
        const ids = listLibrary().map((row) => row.id);
        expect(ids).toContain("lib-one");
        expect(ids).toContain("2026-11-05_14-29-meeting");
        expect(ids.indexOf("2026-11-05_14-29-meeting")).toBeLessThan(ids.indexOf("lib-one"));
        expect(searchLibrary("zebra").map((hit) => hit.recording)).toContain("2026-11-05_14-29-meeting");
    });

    it("keeps a recording whose recording.json the schema refuses, and skips one that is not JSON", () => {
        const root = mkdtempSync(join(tmpdir(), "library-loose-"));
        write(join(root, "video-2026-11-02_10-00-00-ok"), manifest("ok", "2026-11-02T10:00:00Z"));
        // The Swift RecorderEdit shape: no displays.
        write(join(root, "video-2026-11-03_10-00-00-swift"), {
            version: 1,
            id: "swift",
            title: "From the app",
            startedAt: "2026-11-03T10:00:00Z",
            frames: [{ file: "f.png", atMs: 0 }],
        });
        mkdirSync(join(root, "video-2026-11-04_10-00-00-bad"));
        writeFileSync(join(root, "video-2026-11-04_10-00-00-bad", "recording.json"), "{broken");
        const rows = listLibrary({ root });
        expect(rows.map((row) => [row.id, row.title, row.frames])).toEqual([
            ["swift", "From the app", 1],
            ["ok", "ok", 0],
        ]);
    });
});

it("a library row says how the recording ended, how long its movie is, and why a failed one made none", () => {
    const root = mkdtempSync(join(tmpdir(), "library-outcome-"));
    const manifest = (id: string, extra: Record<string, unknown>) => {
        mkdirSync(join(root, id));
        writeFileSync(
            join(root, id, "recording.json"),
            SafeJSON.stringify({
                version: 1,
                id,
                title: id,
                startedAt: "2026-11-06T19:50:38Z",
                displays: [],
                frames: [],
                ...extra,
            })
        );
    };
    manifest("video-2026-11-06_20-50-38-done", {
        settings: { outcome: "done", video: { file: "screen.mp4", durationMs: 10_310 } },
    });
    manifest("video-2026-11-06_20-50-37-failed", {
        settings: { outcome: "failed" },
        warnings: ["cannot record the window"],
    });
    manifest("library-2026-11-06_20-50-36-frames", {});
    const [done, failed, frames] = listLibrary({ root });
    expect(done).toMatchObject({ outcome: "done", durationMs: 10_310 });
    expect(done.reason).toBeUndefined();
    expect(failed).toMatchObject({ outcome: "failed", reason: "cannot record the window" });
    expect(frames.outcome).toBeUndefined();
    expect(frames.durationMs).toBeUndefined();
});

it("a movie's row counts the movie's frames, and the table says — for a movie whose count was never written", () => {
    const root = mkdtempSync(join(tmpdir(), "library-frames-"));
    const manifest = (id: string, extra: Record<string, unknown>) => {
        mkdirSync(join(root, id));
        writeFileSync(
            join(root, id, "recording.json"),
            SafeJSON.stringify({ version: 1, id, title: id, displays: [], frames: [], ...extra })
        );
    };
    manifest("video-2026-11-07_00-45-59-counted", {
        startedAt: "2026-11-06T23:45:59Z",
        settings: { outcome: "done", video: { file: "screen.mp4", durationMs: 3054, frames: 127, averageFps: 41.6 } },
    });
    manifest("video-2026-11-06_20-50-38-older", {
        startedAt: "2026-11-06T19:50:38Z",
        settings: { outcome: "done", video: { file: "screen.mp4", durationMs: 10_310 } },
    });
    manifest("library-2026-11-06_20-50-36-frames", { startedAt: "2026-11-06T19:50:36Z" });
    const [counted, older, stills] = listLibrary({ root });
    expect(counted.movieFrames).toBe(127);
    expect(framesCell(counted)).toBe("127");
    expect(older.movieFrames).toBeUndefined();
    expect(framesCell(older)).toBe("—");
    expect(framesCell(stills)).toBe("0");
    expect(libraryRow(counted.folder)).toEqual(counted);
    expect(libraryRow(join(root, "missing"))).toBeUndefined();
});

it("a short id is the stamp and the uuid's first block, and it opens the recording like the full id", () => {
    const id = "video-2026-11-06_20-50-38-0eb8dd5f-7cec-4561-9379-63bc9cbfa33b";
    expect(shortRecordingId(id)).toBe("video-2026-11-06_20-50-38-0eb8dd5f");
    expect(shortRecordingId("library-2026-11-05_10-00-00-new")).toBe("library-2026-11-05_10-00-00-new");
    const folder = recordingsLibraryDir(id);
    const twin = recordingsLibraryDir("video-2026-11-06_20-50-38-0eb8dd5f-0000-4561-9379-63bc9cbfa33b");
    try {
        mkdirSync(folder, { recursive: true });
        writeFileSync(
            join(folder, "recording.json"),
            SafeJSON.stringify({
                version: 1,
                id,
                title: "short",
                startedAt: "2026-11-06T19:50:38Z",
                displays: [],
                frames: [],
            })
        );
        expect(resolveRecording(shortRecordingId(id))).toBe(folder);
        mkdirSync(twin, { recursive: true });
        expect(() => resolveRecording(shortRecordingId(id))).toThrow(/2 recordings start with/);
    } finally {
        rmSync(folder, { recursive: true, force: true });
        rmSync(twin, { recursive: true, force: true });
    }
});

it("a live command finds the running recording by its live id, the end of it, or the library id that start and list print", () => {
    const library = "video-2026-11-07_00-20-20-da0341a9-5f4e-483e-9ad1-04b4681dfcf2";
    const entries = [
        { id: "meeting-2026-11-07_09-00-planning" },
        { id: "recorder-14429-faa72b4a", folder: join("/lib", library) },
    ];
    expect(findLiveEntry(entries, "recorder-14429-faa72b4a")).toBe(entries[1]);
    expect(findLiveEntry(entries, "faa72b4a")).toBe(entries[1]);
    expect(findLiveEntry(entries, library)).toBe(entries[1]);
    expect(findLiveEntry(entries, shortRecordingId(library))).toBe(entries[1]);
    expect(findLiveEntry(entries, "video-2026-11-07_00-20-20")).toBe(entries[1]);
    expect(findLiveEntry(entries, "video")).toBeUndefined();
    expect(findLiveEntry(entries, "video-2026-11-07_00-20-21")).toBeUndefined();
    expect(describeLiveEntries(entries)).toBe(
        "meeting-2026-11-07_09-00-planning, recorder-14429-faa72b4a (video-2026-11-07_00-20-20-da0341a9)"
    );
});

it("replays created text and its subsequent ID edit without changing the returned ID", async () => {
    const folder = mkdtempSync(join(tmpdir(), "edit-replay-"));
    const path = join(folder, "edit.json");
    const original = writeProject(
        path,
        wholeProject({ video: join(folder, "screen.mp4"), durationUs: 5_000_000, width: 640, height: 480 })
    );
    const sessions = new EditSessions({ onChange: () => undefined, saveDelayMs: 60_000 });
    const session = await sessions.hold(path);
    const added = await session.apply([{ op: "text", from: 0, to: 1, text: "Keep this ID" }], { by: "fixture" });
    const id = added.project.texts![0].id;
    await session.apply([{ op: "retime", id, from: 1, to: 2 }], { by: "fixture" });
    writeProject(path, { ...original, audio: { ...original.audio, volume: 0.3 } });
    session.flush();
    const disk = SafeJSON.parse(readFileSync(path, "utf8"));
    expect(disk.texts[0]).toMatchObject({ id, startUs: 1_000_000, endUs: 2_000_000 });
    expect(disk.audio.volume).toBe(0.3);
    sessions.release(path);
});

it("recording trash from the CLI forwards policy refusal without touching the requested directory", async () => {
    const folder = mkdtempSync(join(tmpdir(), "recording-trash-policy-"));
    const run = spyOn(cli, "execTool").mockResolvedValue({
        success: false,
        exitCode: 1,
        stdout: "",
        stderr: "policy refused",
    });
    try {
        await expect(trashRecording(folder, { askUser: true })).rejects.toThrow("policy refused");
        expect(run).toHaveBeenCalledWith(["rm", folder], { timeout: 30_000 });
        expect(existsSync(folder)).toBe(true);
    } finally {
        run.mockRestore();
    }
});

// NR40 (deep test 2026-11-06): movie.trash() from the REPL made a tools rm request, which posted to the user's inbox.
it("recording trash from an agent call asks no one: a policy that would ask refuses before any removal starts", async () => {
    const folder = mkdtempSync(join(tmpdir(), "recording-trash-agent-"));
    const plan = (verdict: string) =>
        SafeJSON.stringify([{ path: folder, verdict, reason: "no rule allows it", bytes: 1, willAside: true }]);
    const calls: string[][] = [];
    let verdict = "ask";
    const run = spyOn(cli, "execTool").mockImplementation(async (args: readonly string[]) => {
        calls.push([...args]);

        if (args.includes("--dry-run")) {
            return { success: true, exitCode: 0, stdout: plan(verdict), stderr: "" };
        }

        return { success: true, exitCode: 0, stdout: "", stderr: "" };
    });
    try {
        await expect(trashRecording(folder)).rejects.toThrow(
            "needs the user's confirmation to remove (no rule allows it); nothing was moved and no one was asked"
        );
        expect(calls).toEqual([["rm", "--dry-run", "--json", folder]]);

        verdict = "allow";
        expect(await trashRecording(folder)).toEqual({ trashed: folder });
        expect(calls.slice(1)).toEqual([
            ["rm", "--dry-run", "--json", folder],
            ["rm", folder],
        ]);
    } finally {
        run.mockRestore();
    }
});

/** A movie recording that still records, for the live-folder checks. */
class StillRecording extends RecorderControl {
    readonly kind = "movie";
    readonly methods: readonly RecorderMethod[] = ["status", "stop"];

    async status() {
        return { kind: this.kind, title: "Login demo", state: "recording" as const, displays: [], frames: 0 };
    }

    async pause() {
        return { state: "paused" as const };
    }

    async resume() {
        return { state: "recording" as const };
    }

    async stop(): Promise<StopAnswer> {
        return { state: "stopped" };
    }
}

it("a recording that still records is not trashed, and its library row says it records", async () => {
    const folder = mkdtempSync(join(tmpdir(), "recording-live-"));
    const other = mkdtempSync(join(tmpdir(), "recording-done-"));

    for (const dir of [folder, other]) {
        writeFileSync(
            join(dir, "recording.json"),
            SafeJSON.stringify({ id: "x", title: "Login demo", startedAt: "2026-11-09T10:00:00.000Z" })
        );
    }

    const server = new LiveRecordingServer({
        id: `live-actions-${process.pid}`,
        kind: "movie",
        title: "Login demo",
        folder,
        control: new StillRecording(),
    });
    const run = spyOn(cli, "execTool").mockImplementation(async () => ({
        success: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
    }));

    try {
        await expect(trashRecordings([other, folder], { askUser: true })).rejects.toThrow(
            `${folder} is still recording; stop it first with tools recorder stop. Nothing was moved.`
        );
        expect(run).not.toHaveBeenCalled();
        expect(libraryRow(folder)?.recording).toBe(true);
        expect(libraryRow(other)?.recording).toBeUndefined();
    } finally {
        run.mockRestore();
        server.close();
    }
});

// RC24 (deep test 2026-11-06): 20 recordings trashed by an agent made 20 requests, and each moved its folder to /tmp.
it("several recordings go through the removal policy in one call: one request, and --no-aside keeps the folders", async () => {
    const first = mkdtempSync(join(tmpdir(), "recording-trash-many-a-"));
    const second = mkdtempSync(join(tmpdir(), "recording-trash-many-b-"));
    const calls: string[][] = [];
    let verdicts: Record<string, string> = { [first]: "allow", [second]: "ask" };
    const run = spyOn(cli, "execTool").mockImplementation(async (args: readonly string[]) => {
        calls.push([...args]);

        if (args.includes("--dry-run")) {
            const plan = args
                .filter((arg) => !arg.startsWith("-") && arg !== "rm")
                .map((path) => ({
                    path,
                    verdict: verdicts[path],
                    reason: "no rule allows it",
                    bytes: 1,
                    willAside: true,
                }));
            return { success: true, exitCode: 0, stdout: SafeJSON.stringify(plan), stderr: "" };
        }

        return { success: true, exitCode: 0, stdout: "", stderr: "" };
    });
    try {
        // The CLI a person runs: one tools rm call for both, so at most one request.
        expect(await trashRecordings([first, second, first], { askUser: true, aside: false })).toEqual({
            trashed: [first, second],
        });
        expect(calls).toEqual([["rm", "--no-aside", first, second]]);

        // An agent's call: one dry run for both, and when one would ask, none is moved and no one is asked.
        calls.length = 0;
        await expect(trashRecordings([first, second])).rejects.toThrow(
            `${second} needs the user's confirmation to remove (no rule allows it); nothing was moved and no one was asked. The user can run tools recorder trash ${first} ${second}`
        );
        expect(calls).toEqual([["rm", "--dry-run", "--json", first, second]]);

        verdicts = { [first]: "allow", [second]: "allow" };
        calls.length = 0;
        expect(await trashRecordings([first, second])).toEqual({ trashed: [first, second] });
        expect(calls).toEqual([
            ["rm", "--dry-run", "--json", first, second],
            ["rm", first, second],
        ]);
    } finally {
        run.mockRestore();
    }
});

it("cancelled queued undo and redo preserve history and the project", async () => {
    const folder = mkdtempSync(join(tmpdir(), "edit-cancel-history-"));
    const path = join(folder, "edit.json");
    writeProject(
        path,
        wholeProject({ video: join(folder, "screen.mp4"), durationUs: 1_000_000, width: 640, height: 480 })
    );
    const sessions = new EditSessions({ onChange: () => undefined, saveDelayMs: 60_000 });
    const session = await sessions.hold(path);
    await session.apply([{ op: "volume", volume: 0.4 }], { by: "fixture" });
    const undoCancel = new AbortController();
    const undo = withEditCancel(undoCancel.signal, () => session.undo({ by: "fixture" }));
    undoCancel.abort(new Error("cancelled queued undo"));
    await expect(undo).rejects.toThrow("cancelled queued undo");
    expect(session.current.project.audio.volume).toBe(0.4);
    await session.undo({ by: "fixture" });
    const redoCancel = new AbortController();
    const redo = withEditCancel(redoCancel.signal, () => session.redo({ by: "fixture" }));
    redoCancel.abort(new Error("cancelled queued redo"));
    await expect(redo).rejects.toThrow("cancelled queued redo");
    await session.redo({ by: "fixture" });
    expect(session.current.project.audio.volume).toBe(0.4);
    sessions.release(path);
    expect(SafeJSON.parse(readFileSync(path, "utf8")).audio.volume).toBe(0.4);
});

describe("a snapshot's recorder face argv", () => {
    it("selects the marker the request names", () => {
        const argv = snapshotArgv({ out: "/tmp/x.png", path: "/tmp/e", selectMarker: 2 });

        expect(argv.slice(argv.indexOf("--select-marker"), argv.indexOf("--select-marker") + 2)).toEqual([
            "--select-marker",
            "2",
        ]);
    });
});

// R5 3: an export retry needed a move-aside, which left an unredacted plain export in the project.
describe("an export into a file that exists", () => {
    const fakeRender = (bytes: string) => async (out: string) => {
        writeFileSync(out, bytes);
        return { ok: true, path: out, bytes: bytes.length, seconds: 0.1 };
    };

    it("is refused before any work without overwrite, and replaced in one step with it", async () => {
        const folder = mkdtempSync(join(tmpdir(), "r5-export-"));
        const target = join(folder, "demo.mp4");
        writeFileSync(target, "old");
        let rendered = 0;
        const refused = await renderInto({
            target,
            render: async (out) => {
                rendered++;
                return fakeRender("new")(out);
            },
        });
        expect(refused.ok).toBe(false);
        expect(refused.error).toContain("overwrite: true, --overwrite");
        expect(rendered).toBe(0);
        const replaced = await renderInto({ target, overwrite: true, render: fakeRender("new") });
        expect(replaced).toMatchObject({ ok: true, path: target, replaced: true });
        expect(readFileSync(target, "utf8")).toBe("new");
        expect(existsSync(join(folder, ".demo.rendering.mp4"))).toBe(false);
        // A failed render leaves the old file as it was.
        const failed = await renderInto({
            target,
            overwrite: true,
            render: async () => ({ ok: false, error: "boom" }),
        });
        expect(failed.ok).toBe(false);
        expect(readFileSync(target, "utf8")).toBe("new");
        rmSync(folder, { recursive: true, force: true });
    });

    it("reads --size as one side or both, and prints progress once per 10 %", () => {
        expect(parseExportSize("1920x1080")).toEqual({ width: 1920, height: 1080 });
        expect(parseExportSize("x1080")).toEqual({ height: 1080 });
        expect(parseExportSize("1280x")).toEqual({ width: 1280 });
        expect(() => parseExportSize("big")).toThrow("WIDTHxHEIGHT");
        expect(() => parseExportSize("4x4")).toThrow("16 to 8192");
        const lines: string[] = [];
        const progress = exportProgressPrinter((line) => lines.push(line));
        for (const fraction of [0, 0.01, 0.05, 0.1, 0.11, 0.5, 0.99, 1]) {
            progress(fraction);
        }
        expect(lines).toEqual(["export 0%", "export 10%", "export 50%", "export 90%", "export 100%"]);
    });
});
