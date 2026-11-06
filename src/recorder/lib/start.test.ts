import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { segmentCaptureSpec } from "@app/control/lib/recording-native";
import type { RecordingTarget } from "@app/control/lib/recording-targets";
import { liveRecordingRef } from "./library";
import { parseStartFlags } from "./start-options";
import { segmentRecorderOptions } from "./video-recording";

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

    it("--audio with --window or --app is refused before anything starts", () => {
        expect(() => parseStartFlags({ window: "83493", audio: "mic" })).toThrow(/--audio needs a display or an area/);
        expect(() => parseStartFlags({ app: "Notes", audio: "system" })).toThrow(/--audio needs a display or an area/);
        expect(parseStartFlags({ window: "83493" }).target).toEqual(window);
    });
});
