import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { editorOpenStatePath, readEditorOpenState, resolveRecording } from "./library";
import { framesForPlan, overrideRanges, planMostChange, proxyVideoFilter } from "./proxy";
import { currentGif, isMeetingFolder, meetingOf, shareableMovie, trashRecording } from "./quick-actions";

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

describe("a recording's quick actions", () => {
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

        expect(isMeetingFolder(meeting, meetings)).toBe(true);
        expect(isMeetingFolder(`${meetings}-other/x`, meetings)).toBe(false);
        expect(meetingOf(meeting, meetings)).toBe(join(meeting, "meeting.json"));
        expect(meetingOf(folderWith([["screen.mp4", 0]]), meetings)).toBeUndefined();
        // The refusal comes before anything is moved: the folder is still there.
        await expect(trashRecording(meeting, { meetingsRoot: meetings })).rejects.toThrow("holds the whole meeting");
        expect(existsSync(join(meeting, "meeting.json"))).toBe(true);
    });
});
