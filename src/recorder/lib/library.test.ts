import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import recordingMovies from "@genesiscz/utils/recording-editor/__fixtures__/recording-movies.json";
import screenSearch from "@genesiscz/utils/recording-editor/__fixtures__/screen-search.json";
import { applyOp, wholeProject } from "@genesiscz/utils/recording-editor/project";
import { recordingStoreOf } from "@genesiscz/utils/screen-recorder/recording-stores";
import { displaySwitchDepth, keepingSwitchStep, keptPlan, stepDisplaySwitch } from "./frames-movie";
import { editorOpenStatePath, movieOf, readEditorOpenState, resolveRecording } from "./library";
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
import { currentGif, shareableMovie, trashRecording } from "./quick-actions";
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
        await stepDisplaySwitch(old, "undo", async (options) => {
            calls.push(options);
            return { path: join(old, "proxy.mp4"), frames: 1, audioPieces: 0, plan: plan(1) };
        });
        expect(calls).toEqual([{}]);
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

// The editor's Find tab decodes these hits (RecorderEditTests.swift), so it reads what find-screen prints.
describe("text on the screen", () => {
    it("finds the shared fixture's hits: accents ignored, the shown display's line boxes placed in the letterboxed picture", () => {
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
        writeFileSync(join(folder, "proxy.json"), SafeJSON.stringify(screenSearch.recording.plan));

        expect(findOnScreen(folder, screenSearch.query)).toEqual(screenSearch.hits);
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
