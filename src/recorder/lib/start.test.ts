import { describe, expect, it, spyOn } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as captureRunner from "@app/control/lib/capture-runner";
import type { ScreenInfo } from "@app/control/lib/native-record";
import { segmentCaptureSpec } from "@app/control/lib/recording-native";
import type { RecordingTarget } from "@app/control/lib/recording-targets";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { closeStartGate, startGatePath } from "@genesiscz/utils/process/start-gate";
import { RpcError } from "@genesiscz/utils/screen-recorder/control";
import { listLiveRecordings } from "@genesiscz/utils/screen-recorder/live";
import { type CameraHost, startRecordingCamera, stopRecordingCamera } from "./camera-recorder";
import { framesDoneLine } from "./frames-recording";
import { alreadyInState, liveRecordingRef, markerLabelProblem } from "./library";
import {
    otherRecordingsWarning,
    parseStartFlags,
    refuseMissingWindowOrApp,
    refuseTargetOffScreen,
    startAudioOf,
} from "./start-options";
import {
    announcedCountdown,
    endRecordingCamera,
    RecordingStartCancelled,
    recordedNothing,
    recordVideo,
    segmentRecorderOptions,
    videoDoneLine,
} from "./video-recording";

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

describe("a countdown that ends when the movie records", () => {
    it("the countdown's last second starts the recorder, and zero waits for the movie's first frame", async () => {
        const scratch = await mkdtemp(join(tmpdir(), "gt-countdown-hold-"));
        const events: string[] = [];
        const excluded: number[][] = [];
        const framed: Array<string | undefined> = [];
        let liveId = "";
        const spy = spyOn(captureRunner, "runCapturePlanWithSignal").mockImplementation(
            async ({ plan, onRecording }) => {
                events.push("recorder starts");
                excluded.push(plan.capture?.excludeWindowIds ?? []);
                // ax-tool's arming: longer than what is left of the last second.
                await Bun.sleep(400);
                events.push("first frame");
                const before = listLiveRecordings().find((entry) => entry.id === liveId)?.lastFrameAt;
                onRecording?.({ sessionDir: join(scratch, "session") });
                await Bun.sleep(50);
                framed.push(before, listLiveRecordings().find((entry) => entry.id === liveId)?.lastFrameAt);
                return {
                    ...({} as Awaited<ReturnType<typeof captureRunner.runCapturePlanWithSignal>>),
                    captureFailed: false,
                    sessionDir: join(scratch, "session"),
                    warnings: [],
                    capture: null,
                };
            }
        );

        try {
            await recordVideo({
                target: { kind: "region", x: 0, y: 0, width: 320, height: 200 },
                countdownSeconds: 2,
                prepare: async () => {},
                onStarted: (started) => {
                    liveId = started.liveId;
                },
                countdown: async (seconds, hold) => {
                    events.push(`countdown ${seconds}`);
                    await Bun.sleep(20);
                    events.push("last second");
                    hold.lastSecond({ excludeWindowIds: [77] });
                    await Bun.sleep(250);
                    events.push("last tick ends");
                    await hold.until;
                    events.push("zero");
                },
            });
        } finally {
            spy.mockRestore();
        }

        expect(events).toEqual([
            "countdown 2",
            "last second",
            "recorder starts",
            "last tick ends",
            "first frame",
            "zero",
        ]);
        // The overlay's window is kept out of the movie.
        expect(excluded).toEqual([[77]]);
        // The live entry says "recording" while it arms too; lastFrameAt is what tells the picker that it records.
        expect(framed[0]).toBeUndefined();
        expect(framed[1]).toBeString();
    });

    it("a start gate the caller closed during the countdown ends the hold at once and cancels the start", async () => {
        const gate = startGatePath(await mkdtemp(join(tmpdir(), "gt-countdown-gate-")));
        expect(await closeStartGate(gate)).toEqual({ status: "cancelled" });
        const spy = spyOn(captureRunner, "runCapturePlanWithSignal").mockImplementation(async () => {
            throw new Error("a cancelled start must not reach the recorder");
        });
        let held = "not reached";
        let recorderCalls = -1;

        try {
            await expect(
                recordVideo({
                    target: { kind: "region", x: 0, y: 0, width: 320, height: 200 },
                    startGate: gate,
                    countdownSeconds: 1,
                    prepare: async () => {},
                    countdown: async (_seconds, hold) => {
                        hold.lastSecond({ excludeWindowIds: [] });
                        held = await Promise.race([
                            hold.until.then(() => "settled"),
                            Bun.sleep(2000).then(() => "still held"),
                        ]);
                    },
                })
            ).rejects.toBeInstanceOf(RecordingStartCancelled);
            recorderCalls = spy.mock.calls.length;
        } finally {
            spy.mockRestore();
        }

        expect(held).toBe("settled");
        expect(recorderCalls).toBe(0);
    });
});

/** A recorder that records nothing: it notes its start and the windows its movie leaves out. */
async function fakeRecorder(steps: string[], excluded: number[][]) {
    const scratch = await mkdtemp(join(tmpdir(), "gt-camera-preview-"));
    return spyOn(captureRunner, "runCapturePlanWithSignal").mockImplementation(async ({ plan, onRecording }) => {
        steps.push("recorder starts");
        excluded.push(plan.capture?.excludeWindowIds ?? []);
        onRecording?.({ sessionDir: join(scratch, "session") });
        return {
            ...({} as Awaited<ReturnType<typeof captureRunner.runCapturePlanWithSignal>>),
            captureFailed: false,
            sessionDir: join(scratch, "session"),
            warnings: [],
            capture: null,
        };
    });
}

// Regression test: a camera recording started by the CLI, the REPL or the service asked for the camera after its
// first segment started and never left the camera preview out, so the preview was baked into screen.mp4 and a frame,
// a zoom or a moved bubble showed two faces (hunt 2026-11-09, ScreenCaptureKit ignores the panel's sharing type).
describe("a camera recording leaves the camera preview out of its movie", () => {
    it("asks for the camera before the first segment, and the preview's window joins every segment's exclusions", async () => {
        const steps: string[] = [];
        const excluded: number[][] = [];
        const cameraHost: CameraHost = {
            call: async (method, params) => {
                steps.push(method);

                if (method === "camera.stop") {
                    // The face writes camera.json once the camera movie is finished.
                    await writeFile(join(params.folder, "camera.json"), "{}");
                    return { stopped: true };
                }

                return { started: true, windowIds: [4242] };
            },
        };
        const spy = await fakeRecorder(steps, excluded);

        try {
            await recordVideo({
                target: { kind: "region", x: 0, y: 0, width: 320, height: 200 },
                camera: true,
                recorderFace: () => "held",
                cameraHost,
                excludeWindowIds: [77],
            });
        } finally {
            spy.mockRestore();
        }

        expect(steps.slice(0, 2)).toEqual(["camera.start", "recorder starts"]);
        expect(excluded[0]).toEqual([77, 4242]);
    });

    it("a camera the face refuses ends the start before the recorder starts", async () => {
        const steps: string[] = [];
        const excluded: number[][] = [];
        const cameraHost: CameraHost = {
            call: async (method) => {
                steps.push(method);
                throw new RpcError(1014, "Camera access is off for GenesisTools");
            },
        };
        const spy = await fakeRecorder(steps, excluded);
        let result: Awaited<ReturnType<typeof recordVideo>> | undefined;

        try {
            result = await recordVideo({
                target: { kind: "region", x: 0, y: 0, width: 320, height: 200 },
                camera: true,
                recorderFace: () => "held",
                cameraHost,
            });
        } finally {
            spy.mockRestore();
        }

        expect(steps).toEqual(["camera.start"]);
        expect(result?.outcome).toBe("failed");
        expect(result?.warnings.join(" ")).toContain("Camera access is off for GenesisTools");
    });

    it("camera.start answers the preview's windows; an answer without them (an older app) leaves none out", async () => {
        const host = (answer: unknown): CameraHost => ({ call: async () => answer });
        expect(await startRecordingCamera("/tmp/rec", host({ started: true, windowIds: [4242] }))).toEqual({
            started: true,
            windowIds: [4242],
        });
        expect(await startRecordingCamera("/tmp/rec", host({ started: true }))).toEqual({
            started: true,
            windowIds: [],
        });
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
        expect(await startRecordingCamera("/tmp/rec", host())).toEqual({ started: true, windowIds: [] });
        expect(await startRecordingCamera("/tmp/rec", host("Camera access is off for GenesisTools"))).toMatchObject({
            started: false,
            reason: expect.stringContaining("Camera access is off for GenesisTools"),
        });
        await stopRecordingCamera("/tmp/rec", host("no recorder host said hello"));
        expect(calls).toEqual(["camera.start /tmp/rec", "camera.start /tmp/rec", "camera.stop /tmp/rec"]);
    });

    it("the camera.stop step is followed by the align step, with the screen's spans; a discard or no movie skips it", async () => {
        const folder = await mkdtemp(join(tmpdir(), "recorder-camera-end-"));
        const spans = [{ sourceStartMs: 0, firstFrameEpochMs: 1_000_800, lengthMs: 2500 }];
        const steps: string[] = [];
        const host = (writes: boolean): CameraHost => ({
            call: async (method, params) => {
                steps.push(method);

                // The face writes camera.json once the camera movie is finished.
                if (method === "camera.stop" && writes) {
                    await writeFile(join(params.folder, "camera.json"), "{}");
                }

                return { stopped: true };
            },
        });
        const align = async (input: { folder: string; spans: typeof spans }) => {
            steps.push(`align ${input.folder === folder} ${input.spans.length}`);
            return { result: "trimmed" as const };
        };

        expect(await endRecordingCamera({ folder, outcome: "done", spans, host: host(true), align })).toBeUndefined();
        expect(steps).toEqual(["camera.stop", "align true 1"]);

        steps.length = 0;
        expect(
            await endRecordingCamera({ folder, outcome: "discarded", spans, host: host(true), align })
        ).toBeUndefined();
        expect(steps).toEqual(["camera.stop"]);

        steps.length = 0;
        const empty = await mkdtemp(join(tmpdir(), "recorder-camera-end-"));
        const missing = await endRecordingCamera({
            folder: empty,
            outcome: "done",
            spans,
            host: host(false),
            align,
            finishWaitMs: 50,
        });
        expect(missing?.code).toBe("camera-missing");
        expect(steps).toEqual(["camera.stop"]);

        steps.length = 0;
        const unaligned = await endRecordingCamera({
            folder,
            outcome: "done",
            spans,
            host: host(true),
            align: async () => ({ result: "offset" as const, warning: "the camera movie could not be cut" }),
        });
        expect(unaligned).toEqual({ code: "camera-unaligned", message: "the camera movie could not be cut" });
        await rm(folder, { recursive: true, force: true });
        await rm(empty, { recursive: true, force: true });
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
        expect(() => refuseTargetOffScreen(region(1000, 700), screens)).not.toThrow();
        // Across the display's edge: one display records, so the part on it is the fix.
        expect(() => refuseTargetOffScreen(region(1400, 900), screens)).toThrow(
            /not inside one display.*0 "Built-in".*--region 1400,900,112,82/
        );
        expect(() => refuseTargetOffScreen({ kind: "display", screenIndex: 2 }, screens)).toThrow(
            /--display 2.*0 "Built-in"/
        );
        expect(() => refuseTargetOffScreen({ kind: "display", screenIndex: 0 }, screens)).not.toThrow();
        expect(() => refuseTargetOffScreen(window, screens)).not.toThrow();
    });

    it("a countdown is announced before it runs, so a --json reader knows why nothing records yet", async () => {
        const calls: string[] = [];
        const hold = { lastSecond: () => {}, until: Promise.resolve() };
        const countdown = announcedCountdown(
            (seconds) => calls.push(`announce ${seconds}`),
            async (seconds, given) => {
                calls.push(`show ${seconds}${given === hold ? " with the hold" : ""}`);
            }
        );
        await countdown(2, hold);
        expect(calls).toEqual(["announce 2", "show 2 with the hold"]);
    });

    it("the done lines count one frame as one frame", () => {
        const movie = { outcome: "done" as const, id: "v", folder: "/f", movie: "/f/screen.mp4", warnings: [] };
        expect(videoDoneLine({ ...movie, frames: 1, averageFps: 0.2 })).toBe("done: /f/screen.mp4 (1 frame, 0.2 fps)");
        expect(videoDoneLine({ ...movie, frames: 151, averageFps: 30 })).toBe(
            "done: /f/screen.mp4 (151 frames, 30 fps)"
        );
        expect(
            videoDoneLine({ outcome: "failed", id: "v", folder: "/f", removed: true, warnings: ["no window"] })
        ).toBe("failed, nothing was recorded: no window");
        expect(framesDoneLine({ outcome: "done", folder: "/f", frames: 1 })).toBe("done: /f (1 frame)");
        expect(framesDoneLine({ state: "stopped", folder: "/f", frames: 3, ocrFailed: 1 })).toBe(
            "stopped: /f (3 frames, 1 without its text: OCR failed)"
        );
    });

    it("a window that is not on screen and an app that does not run are refused before a folder is made", () => {
        const seen = {
            windowIds: new Set([52654, 7]),
            windows: [
                {
                    id: 52654,
                    pid: 90,
                    app: "Activity Monitor",
                    title: "CPU",
                    bounds: { x: 0, y: 0, width: 800, height: 600 },
                },
            ],
            apps: [{ name: "Activity Monitor", bundleId: "com.apple.ActivityMonitor", pid: 90 }],
        };
        expect(() => refuseMissingWindowOrApp({ kind: "window", windowIds: [999999] }, seen)).toThrow(
            /--window 999999 is not a window on screen.*52654 Activity Monitor “CPU”/
        );
        expect(() => refuseMissingWindowOrApp({ kind: "window", windowIds: [52654, 7] }, seen)).not.toThrow();
        expect(() => refuseMissingWindowOrApp({ kind: "app", app: "NoSuchApp" }, seen)).toThrow(
            /--app "NoSuchApp" matches no running app/
        );
        expect(() => refuseMissingWindowOrApp({ kind: "app", app: "91" }, seen)).toThrow(/--app "91"/);
        for (const app of ["Activity Monitor", "activity monitor", "activitymonitor", "90"]) {
            expect(() => refuseMissingWindowOrApp({ kind: "app", app }, seen)).not.toThrow();
        }

        expect(() => refuseMissingWindowOrApp({ kind: "display", screenIndex: 0 }, seen)).not.toThrow();
    });

    it("--audio with --window or --app is refused before anything starts", () => {
        expect(() => parseStartFlags({ window: "83493", audio: "mic" })).toThrow(/--audio needs a display or an area/);
        expect(() => parseStartFlags({ app: "Notes", audio: "system" })).toThrow(/--audio needs a display or an area/);
        expect(parseStartFlags({ window: "83493" }).target).toEqual(window);
    });

    it("--audio records the system sound first, then the mic, as recording.json lists the tracks", () => {
        expect(startAudioOf({ audio: "mic,system" })).toEqual(["system", "mic"]);
        expect(startAudioOf({ audio: "mic,mic" })).toEqual(["mic"]);
        expect(startAudioOf({ audio: "system" })).toEqual(["system"]);
    });
});

describe("an area lies inside one display", () => {
    const screens: ScreenInfo[] = [
        {
            index: 0,
            name: "Built-in",
            isPrimary: true,
            points: { width: 1440, height: 900 },
            scaleFactor: 2,
            framePixels: { width: 2880, height: 1800 },
            originCG: { x: 0, y: 0 },
        },
        {
            index: 1,
            name: "Studio",
            isPrimary: false,
            points: { width: 1920, height: 1080 },
            scaleFactor: 1,
            framePixels: { width: 1920, height: 1080 },
            originCG: { x: 1440, y: 0 },
        },
    ];

    it("refuses an area across two displays, naming the one with the larger share and the area cut to it", () => {
        expect(() =>
            refuseTargetOffScreen({ kind: "region", x: 1300, y: 100, width: 400, height: 300 }, screens)
        ).toThrow(/--region 1300,100,400,300 is not inside one display.*1 "Studio".*--region 1440,100,260,300/);
    });

    it("takes an area inside one display, with a point of slack for rounding", () => {
        expect(() =>
            refuseTargetOffScreen({ kind: "region", x: 100, y: 100, width: 400, height: 300 }, screens)
        ).not.toThrow();
        expect(() =>
            refuseTargetOffScreen({ kind: "region", x: 1440.5, y: 0, width: 1920, height: 1080 }, screens)
        ).not.toThrow();
    });

    it("keeps the message of an area that meets no display", () => {
        expect(() =>
            refuseTargetOffScreen({ kind: "region", x: 100, y: 2000, width: 400, height: 300 }, screens)
        ).toThrow(/meets no display/);
    });
});
