import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScreenInfo } from "@app/control/lib/native-record";
import { segmentCaptureSpec } from "@app/control/lib/recording-native";
import type { RecordingTarget } from "@app/control/lib/recording-targets";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { RpcError } from "@genesiscz/utils/screen-recorder/control";
import { type CameraHost, startRecordingCamera, stopRecordingCamera } from "./camera-recorder";
import { alreadyInState, liveRecordingRef, markerLabelProblem } from "./library";
import { otherRecordingsWarning, parseStartFlags, refuseTargetOffScreen } from "./start-options";
import { recordedNothing, segmentRecorderOptions } from "./video-recording";

const folder = "/tmp/recording";
const repo = join(moduleDir(import.meta), "..", "..", "..");

/** Every `.command("name")` of `tools recorder`, and the names its stop/pause/resume/status loop registers. */
async function recorderCommands(): Promise<Set<string>> {
    const sources = [join(repo, "src/recorder/index.ts")];

    for (const name of await readdir(join(repo, "src/recorder/commands"))) {
        sources.push(join(repo, "src/recorder/commands", name));
    }

    const names = new Set<string>();

    for (const source of sources) {
        const text = await readFile(source, "utf8");

        for (const match of text.matchAll(/\.command\("([a-z][a-z-]*)/g)) {
            names.add(match[1]);
        }

        for (const loop of text.matchAll(/for \(const method of \[([^\]]+)\]/g)) {
            for (const word of loop[1].matchAll(/"([a-z-]+)"/g)) {
                names.add(word[1]);
            }
        }
    }

    return names;
}

/** `["recorder", "<command>"` in the app's Swift sources: the commands GenesisTools.app runs. */
async function appRecorderCalls(): Promise<{ file: string; command: string }[]> {
    const root = join(repo, "src/macos/GenesisTools/Sources");
    const calls: { file: string; command: string }[] = [];

    for (const entry of await readdir(root, { recursive: true })) {
        if (!entry.endsWith(".swift")) {
            continue;
        }

        const text = await readFile(join(root, entry), "utf8");

        for (const match of text.matchAll(/\["recorder", "([a-z][a-z-]*)"/g)) {
            calls.push({ file: entry, command: match[1] });
        }
    }

    return calls;
}

describe("live control words for an agent", () => {
    it("pause on a paused recording and resume on a running one are answered, not refused", () => {
        expect(alreadyInState("pause", "paused")).toBe("already paused");
        expect(alreadyInState("resume", "recording")).toBe("already recording");
        expect(alreadyInState("pause", "recording")).toBeUndefined();
        expect(alreadyInState("resume", "paused")).toBeUndefined();
        expect(alreadyInState("stop", "paused")).toBeUndefined();
    });

    it("a marker label is 1 to 80 characters, said as a sentence", () => {
        expect(markerLabelProblem("")).toBe("A marker label is 1 to 80 characters.");
        expect(markerLabelProblem("   ")).toBe("A marker label is 1 to 80 characters.");
        expect(markerLabelProblem("x".repeat(81))).toBe("A marker label is 1 to 80 characters.");
        expect(markerLabelProblem("the login fails")).toBeUndefined();
    });
});

describe("a start beside a running recording", () => {
    it("says which recording runs already, and says nothing when none does", () => {
        const entry = (id: string, state: "recording" | "paused" | "stopping" | "stopped", title = "Demo") => ({
            id,
            kind: "control-session",
            title,
            state,
        });
        expect(otherRecordingsWarning([])).toBeUndefined();
        expect(
            otherRecordingsWarning([entry("recorder-1-a", "stopping"), entry("recorder-2-b", "stopped")])
        ).toBeUndefined();
        expect(otherRecordingsWarning([entry("recorder-3-c", "paused", "Standup")])).toBe(
            "another recording runs already: “Standup” (live id recorder-3-c, paused); this one records as well, and stop without an id stops the newest"
        );
        expect(
            otherRecordingsWarning([entry("recorder-4-d", "recording"), entry("recorder-5-e", "recording")])
        ).toMatch(
            /^2 other recordings run already: “Demo” \(live id recorder-4-d, recording\), “Demo” \(live id recorder-5-e, recording\)/
        );
    });
});

describe("the commands GenesisTools.app runs", () => {
    it("every tools recorder command the app runs exists in the CLI", async () => {
        // The defect: the library and the menu opened a frames-only recording with `tools recorder open`, which never
        // existed (it is `edit`), so it failed into a note full of help text (review 2026-11-06).
        const commands = await recorderCommands();
        const calls = await appRecorderCalls();
        expect(commands.has("edit")).toBe(true);
        expect(calls.length).toBeGreaterThan(10);
        expect(calls.filter((call) => !commands.has(call.command))).toEqual([]);
    });
});
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

    it("the camera starts through the recorder host, and a refusal comes back as the start's reason", async () => {
        const calls: string[] = [];
        const host = (fail?: string): CameraHost => ({
            call: async (method, params) => {
                calls.push(`${method} ${params.folder}`);

                if (fail) {
                    throw new RpcError(1014, fail);
                }

                return { started: true };
            },
        });
        expect(await startRecordingCamera("/tmp/rec", host())).toBeUndefined();
        expect(await startRecordingCamera("/tmp/rec", host("Camera access is off for GenesisTools"))).toContain(
            "Camera access is off for GenesisTools"
        );
        await stopRecordingCamera("/tmp/rec", host("no recorder host said hello"));
        expect(calls).toEqual(["camera.start /tmp/rec", "camera.start /tmp/rec", "camera.stop /tmp/rec"]);
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
