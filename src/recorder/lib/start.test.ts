import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScreenInfo } from "@app/control/lib/native-record";
import { segmentCaptureSpec } from "@app/control/lib/recording-native";
import type { RecordingTarget } from "@app/control/lib/recording-targets";
import { liveRecordingRef } from "./library";
import { parseStartFlags, refuseTargetOffScreen } from "./start-options";
import { recordedNothing, segmentRecorderOptions } from "./video-recording";

const folder = "/tmp/recording";
const window: RecordingTarget = { kind: "window", windowIds: [83493] };
const app: RecordingTarget = { kind: "app", app: "Notes" };
const display: RecordingTarget = { kind: "display", screenIndex: 0, follow: true };

describe("a window or app movie", () => {
    it("asks for no cursor track, so its capture spec is valid", () => {
        for (const target of [window, app]) {
            const options = segmentRecorderOptions({ target }, folder);
            expect(options.cursorTrack).toBe(false);
            expect(options.cursorShapes).toBeUndefined();
            expect(options.shortcuts).toBe(false);
            expect(() =>
                segmentCaptureSpec({ target, output: `${folder}/s.mp4`, maxSeconds: 4, options })
            ).not.toThrow();
        }
    });

    it("a display keeps the cursor track, the drawn cursor and the shortcut rows", () => {
        const options = segmentRecorderOptions({ target: display }, folder);
        expect(options.cursorTrack).toBe(true);
        expect(options.cursorShapes).toBe(`${folder}/cursor-shapes`);
        expect(options.shortcuts).toBe(true);
        expect(segmentRecorderOptions({ target: display, systemCursor: true, shortcuts: false }, folder)).toMatchObject(
            {
                cursorTrack: true,
                cursorShapes: undefined,
                shortcuts: false,
            }
        );
    });

    it("a live recording names its library id and folder, and after a stop its movie", async () => {
        const root = await mkdtemp(join(tmpdir(), "recorder-ref-"));
        const folder = join(root, "video-2026-11-06_20-50-38-0eb8dd5f");
        await mkdir(folder);
        const entry = { id: "recorder-30173-94fabb71", folder };
        expect(liveRecordingRef(entry)).toEqual({
            liveId: "recorder-30173-94fabb71",
            id: "video-2026-11-06_20-50-38-0eb8dd5f",
            folder,
        });
        expect(liveRecordingRef(entry, { stopped: true }).movie).toBeUndefined();
        await writeFile(join(folder, "screen.mp4"), "movie");
        expect(liveRecordingRef(entry, { stopped: true }).movie).toBe(join(folder, "screen.mp4"));
        expect(liveRecordingRef({ id: "recorder-1-x" })).toEqual({ liveId: "recorder-1-x" });
        await rm(root, { recursive: true, force: true });
    });

    it("a failed start that made only its manifest recorded nothing; any movie, camera file or segment is something", async () => {
        const root = await mkdtemp(join(tmpdir(), "recorder-nothing-"));
        const folder = join(root, "video-2026-11-06_20-55-16-57cdab2d");
        await mkdir(join(folder, "segments-1a2b3c4d"), { recursive: true });
        await writeFile(join(folder, "recording.json"), "{}");
        expect(await recordedNothing(folder)).toBe(true);
        await writeFile(join(folder, "segments-1a2b3c4d", "segment-001.mp4"), "part");
        expect(await recordedNothing(folder)).toBe(false);
        await rm(join(folder, "segments-1a2b3c4d"), { recursive: true });
        await writeFile(join(folder, "camera.json"), "{}");
        expect(await recordedNothing(folder)).toBe(false);
        await rm(root, { recursive: true, force: true });
    });

    it("two target flags are refused, naming both, instead of one silently winning", () => {
        expect(() => parseStartFlags({ display: "0", window: "1" })).toThrow(/one target.*--display.*--window/);
        expect(() => parseStartFlags({ app: "Notes", region: "0,0,10,10" })).toThrow(/--region.*--app|--app.*--region/);
    });

    it("a region that meets no display and a display that is not connected are refused, naming the displays", () => {
        const screens: ScreenInfo[] = [
            {
                index: 0,
                name: "Built-in",
                isPrimary: true,
                points: { width: 1512, height: 982 },
                scaleFactor: 2,
                framePixels: { width: 3024, height: 1964 },
                originCG: { x: 0, y: 0 },
            },
        ];
        const region = (x: number, y: number): RecordingTarget => ({ kind: "region", x, y, width: 300, height: 200 });
        expect(() => refuseTargetOffScreen(region(1, 1300), screens)).toThrow(
            /meets no display.*0 "Built-in" 1512x982 at 0,0/
        );
        expect(() => refuseTargetOffScreen(region(1400, 900), screens)).not.toThrow();
        expect(() => refuseTargetOffScreen({ kind: "display", screenIndex: 2 }, screens)).toThrow(
            /--display 2.*0 "Built-in"/
        );
        expect(() => refuseTargetOffScreen({ kind: "display", screenIndex: 0 }, screens)).not.toThrow();
        expect(() => refuseTargetOffScreen(window, screens)).not.toThrow();
    });

    it("--audio with --window or --app is refused before anything starts", () => {
        expect(() => parseStartFlags({ window: "83493", audio: "mic" })).toThrow(/--audio needs a display or an area/);
        expect(() => parseStartFlags({ app: "Notes", audio: "system" })).toThrow(/--audio needs a display or an area/);
        expect(parseStartFlags({ window: "83493" }).target).toEqual(window);
    });
});
