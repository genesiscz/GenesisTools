import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { meetingsConfigSchema } from "@genesiscz/utils/meetings/config";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import { callRecorder } from "@genesiscz/utils/screen-recorder/live";
import { NativeFrameRecorder } from "@genesiscz/utils/screen-recorder/native";
import {
    type AudioTrack,
    CaptureError,
    type CaptureRequest,
    type CaptureResult,
    type DisplayInfo,
    FrameRecorder,
} from "@genesiscz/utils/screen-recorder/types";
import { Storage } from "@genesiscz/utils/storage/storage";
import { runRecorder } from "./recorder";
import { meetingLiveId } from "./recorder-shared";
import { type AudioRow, meetingSound, readAudioRows, type SoundInputs } from "./sound";
import { alignPiece, alignReferenceFromSec } from "./sound-align";

const display: DisplayInfo = {
    id: 1,
    index: 0,
    name: "Built-in",
    main: true,
    widthPt: 1512,
    heightPt: 982,
    scale: 2,
};
const firstFrameMs = Date.parse("2026-11-03T12:00:10.000Z");

/**
 * The first capture is refused for the microphone grant while it asks for the microphone; the next records each
 * source it is asked for, with ax-tool's track start 240 ms before the first frame, and then the test stops it.
 */
class GrantRecorder extends FrameRecorder {
    readonly id = "native" as const;
    readonly requests: CaptureRequest[] = [];
    readonly supports = {
        followFocus: false,
        displayId: true,
        motionBoxes: false,
        heartbeat: false,
        liveControl: false,
        parallelCaptures: true,
        audio: true,
    };

    constructor(private readonly stop: () => void) {
        super();
    }

    async available() {
        return { ok: true as const };
    }

    async displays(): Promise<DisplayInfo[]> {
        return [display];
    }

    async capture(request: CaptureRequest, signal?: AbortSignal): Promise<CaptureResult> {
        this.requests.push(request);

        if (request.audio?.sources.includes("mic")) {
            throw new CaptureError(
                "no-permission",
                "ax-tool capture exited 1: microphone access is not granted to the app that started ax-tool"
            );
        }

        const frame = join(request.outDir, "keep-0001.png");
        await Bun.write(frame, "png");
        const tracks: AudioTrack[] = [];

        for (const source of request.audio?.sources ?? []) {
            const path = join(request.outDir, `audio-${source}.m4a`);
            await Bun.write(path, "m4a");
            tracks.push({
                source,
                path,
                durationMs: 30_000,
                startOffsetMs: -240,
                mutedSpans: [],
                lostSpans: [[100, 1750]],
            });
        }

        this.stop();
        await new Promise<void>((resolve) => {
            if (signal?.aborted) {
                resolve();
            }

            signal?.addEventListener("abort", () => resolve(), { once: true });
        });

        return {
            startedAtMs: firstFrameMs,
            frames: [{ path: frame, atMs: 0, displayId: 1, changePercent: 10, reason: "first" }],
            tracks,
            endedEarly: "stopped",
        };
    }
}

/** One recording: a sound file left in `.piece/` by an earlier run, no microphone grant, then one recorded piece. */
async function recordWithoutMicrophone() {
    const store = new MeetingStore(new Storage("meetings-sound-recorder"));
    const created = await store.create(
        { title: "Sound check", start: "2026-11-03T12:00:00.000Z", createdBy: "record" },
        { command: "record start", change: "created" }
    );
    const folder = store.folder(created.id);
    const leftBehind = join(folder, ".piece", "earlier-capture");
    mkdirSync(leftBehind, { recursive: true });
    writeFileSync(join(leftBehind, "audio-mic.m4a"), "sound of a capture that was killed");
    const liveDir = mkdtempSync(join(tmpdir(), "live-sound-"));
    const recorder = new GrantRecorder(() => {
        void callRecorder({ id: meetingLiveId(created.id), method: "stop", dir: liveDir }).catch(() => undefined);
    });
    const state = await runRecorder({
        store,
        meetingId: created.id,
        capture: meetingsConfigSchema.parse({}).global.capture,
        audio: ["mic", "system"],
        deps: {
            recorder,
            toJpeg: async (_png, jpg) => {
                await Bun.write(jpg, "jpeg");
            },
            startOcr: () => undefined,
            notify: async () => undefined,
            liveDir,
            pieceSec: 1,
            failurePauseMs: 0,
        },
    });
    return { state, folder, requests: recorder.requests, rows: readAudioRows(folder) };
}

let recorded: ReturnType<typeof recordWithoutMicrophone> | undefined;
const recording = () => {
    recorded ??= recordWithoutMicrophone();
    return recorded;
};

describe("the recorder keeps the meeting's sound", () => {
    test.each(["--fixture-audio-three", "--fixture-no-mic-grant", "--fixture-audio-loss"])(
        "native session %s keeps rows, counts files, and salvages an interrupted segment",
        async (mode) => {
            const store = new MeetingStore(new Storage("meetings-session-recorder"));
            const created = await store.create(
                { title: "Continuous sound", start: "2026-11-03T12:00:00.000Z", createdBy: "record" },
                { command: "record start", change: "created" }
            );
            const folder = store.folder(created.id);
            const previous = join(folder, ".piece", "audio-session-earlier");
            mkdirSync(previous, { recursive: true });
            writeFileSync(join(previous, "audio-000002-system.m4a"), "unfinished segment");
            const liveDir = mkdtempSync(join(tmpdir(), "meeting-session-live-"));
            class SessionRecorder extends NativeFrameRecorder {
                readonly requests: CaptureRequest[] = [];
                override capture(request: CaptureRequest, signal?: AbortSignal): Promise<CaptureResult> {
                    this.requests.push(request);
                    return super.capture(
                        {
                            ...request,
                            hooks: {
                                ...request.hooks,
                                onFrame: (frame) => {
                                    request.hooks?.onFrame?.(frame);
                                    void callRecorder({
                                        id: meetingLiveId(created.id),
                                        method: "stop",
                                        dir: liveDir,
                                    }).catch(() => undefined);
                                },
                            },
                        },
                        signal
                    );
                }
            }
            const recorder = new SessionRecorder({
                axTool: async () => [
                    process.execPath,
                    join(moduleDir(import.meta), "../../utils/screen-recorder/__fixtures__/fake-ax-tool.ts"),
                    mode,
                ],
                launch: (argv) => argv,
            });
            const state = await runRecorder({
                store,
                meetingId: created.id,
                // The continuous session is a setting; the default records the sound inside the pieces.
                capture: meetingsConfigSchema.parse({
                    global: { capture: { recorders: { native: { audio: { mode: "session" } } } } },
                }).global.capture,
                audio: ["mic", "system"],
                deps: {
                    recorder,
                    liveDir,
                    startOcr: () => undefined,
                    notify: async () => undefined,
                    toJpeg: async (_png, jpg) => {
                        await Bun.write(jpg, "jpeg");
                    },
                    pieceSec: 1,
                    failurePauseMs: 0,
                },
            });
            const kept = readAudioRows(folder);
            const expectedFiles = mode === "--fixture-audio-three" ? 6 : mode === "--fixture-audio-loss" ? 2 : 1;
            expect(kept.filter((row) => row.kept === "normal")).toHaveLength(expectedFiles);
            expect(kept.filter((row) => row.kept === "salvaged")).toEqual([
                expect.objectContaining({ source: "system" }),
            ]);
            expect(kept.every((row) => existsSync(join(folder, row.file)))).toBe(true);
            if (mode === "--fixture-audio-loss") {
                expect(kept.filter((row) => row.kept === "normal").map((row) => row.lostSpans)).toEqual([
                    [[100, 1750]],
                    [[100, 1750]],
                ]);
            }
            expect(recorder.requests.every((request) => request.audio === undefined)).toBe(true);
            expect(existsSync(join(folder, ".piece"))).toBe(false);
            expect(store.read(created.id)?.recording?.audio).toMatchObject({ files: expectedFiles });
            if (mode === "--fixture-no-mic-grant") {
                expect(kept.filter((row) => row.kept === "normal").map((row) => row.source)).toEqual(["system"]);
                expect(state.warning?.match(/the microphone is not granted/g)).toHaveLength(1);
            }
        }
    );

    test("a request without the microphone grant holds system only, and the recording says so", async () => {
        const { state, requests } = await recording();

        expect(requests[0]?.audio?.sources).toEqual(["mic", "system"]);
        expect(requests.slice(1).map((request) => request.audio?.sources)).toEqual([["system"]]);
        expect(state.warning).toContain("the microphone is not granted");
    });

    test("a track with startMs -240 gets a zeroAt 0.24 s before the first frame", async () => {
        const { rows } = await recording();
        const system = rows.find((row) => row.source === "system");

        expect(system).toMatchObject({ at: "2026-11-03T12:00:10.000Z", zeroAt: "2026-11-03T12:00:09.760Z" });
        expect(system?.kept).toBeUndefined();
        expect(system?.lostSpans).toEqual([[100, 1750]]);
    });

    test("a file left in the piece folder is in the folder audio with a salvaged row after begin()", async () => {
        const { folder, rows } = await recording();
        const salvaged = rows.filter((row) => row.kept === "salvaged");

        expect(salvaged).toEqual([expect.objectContaining({ source: "mic", mutedSpans: [] })]);
        expect(salvaged[0]?.file).toMatch(/^audio\/.+-mic-salvaged\.m4a$/);
        expect(existsSync(join(folder, salvaged[0]?.file ?? "missing"))).toBe(true);
        expect(readdirSync(join(folder, "audio"))).toHaveLength(2);
        expect(existsSync(join(folder, ".piece"))).toBe(false);
    });
});

describe("audio.jsonl rows", () => {
    test("a row from before zeroAt and kept still reads, and a malformed one is skipped", () => {
        const folder = mkdtempSync(join(tmpdir(), "audio-rows-"));
        writeFileSync(
            join(folder, "audio.jsonl"),
            [
                '{"file":"audio/a-mic.m4a","source":"mic","at":"2026-11-03T12:00:00.000Z","durationMs":900,"mutedSpans":[]}',
                "not json",
                '{"file":"audio/b-system.m4a","source":"system","at":"2026-11-03T12:00:30.000Z","durationMs":30000,"mutedSpans":[[0,10]],"zeroAt":"2026-11-03T12:00:29.900Z"}',
            ].join("\n")
        );

        expect(readAudioRows(folder)).toEqual([
            { file: "audio/a-mic.m4a", source: "mic", at: "2026-11-03T12:00:00.000Z", durationMs: 900, mutedSpans: [] },
            {
                file: "audio/b-system.m4a",
                source: "system",
                at: "2026-11-03T12:00:30.000Z",
                durationMs: 30_000,
                mutedSpans: [[0, 10]],
                zeroAt: "2026-11-03T12:00:29.900Z",
            },
        ]);
    });
});

describe("MeetingSound.slice", () => {
    const rows: AudioRow[] = (["mic", "system"] as const).map((source) => ({
        file: `audio/piece-${source}.m4a`,
        source,
        at: "2026-11-03T12:00:30.000Z",
        zeroAt: "2026-11-03T12:00:29.760Z",
        durationMs: 30_000,
        mutedSpans: [],
    }));
    const inputs: SoundInputs = {
        folder: "/meetings/sound-check",
        timelineZeroMs: Date.parse("2026-11-03T12:00:00.000Z"),
        rows,
        source: { path: "/sources/call.ogg", source: "wisprflow", layout: "left-mic", durationSec: 3600 },
        tracks: "best",
    };
    const measured: SoundInputs["clock"] = {
        version: 1,
        sources: {
            mic: { correctionSec: 0.1, pieces: 2, clear: 2 },
            system: { correctionSec: 0.1, pieces: 2, clear: 1 },
        },
    };

    test("listening takes the recorder's microphone first, on its stamp", () => {
        const slice = meetingSound(inputs).slice({ seat: "mic", fromSec: 40, toSec: 42, purpose: "listen" });

        expect(slice).toMatchObject({ track: "mic-raw", path: "/meetings/sound-check/audio/piece-mic.m4a" });
        expect(slice?.clock).toBe("stamp");
        expect(slice?.fileFromSec).toBeCloseTo(10.24, 6);
    });

    test("a voice sample takes a recorder track only when its clock is measured", () => {
        const stamped = meetingSound(inputs).slice({ seat: "mic", fromSec: 40, toSec: 42, purpose: "voice" });
        expect(stamped).toMatchObject({ track: "source-mic", path: "/sources/call.ogg", channel: 0, clock: "source" });
        expect(stamped?.fileFromSec).toBe(40);

        const sound = meetingSound({ ...inputs, clock: measured });
        expect(sound.tracks.find((track) => track.kind === "mic-raw")?.clock).toBe("measured");
        const voice = sound.slice({ seat: "mic", fromSec: 40, toSec: 42, purpose: "voice" });
        expect(voice).toMatchObject({ track: "mic-raw", clock: "measured" });
        expect(voice?.fileFromSec).toBeCloseTo(10.14, 6);
    });

    test("without source sound a voice sample on a stamped recorder track is undefined", () => {
        const { source: _source, ...withoutSource } = inputs;
        const sound = meetingSound(withoutSource);

        expect(sound.slice({ seat: "mic", fromSec: 40, toSec: 42, purpose: "voice" })).toBeUndefined();
        expect(sound.slice({ seat: "mic", fromSec: 40, toSec: 42, purpose: "listen" })).toMatchObject({
            track: "mic-raw",
        });
    });

    test("the call seat takes the source's call channel; tracks: source and an uncovered span skip the recorder", () => {
        const call = meetingSound(inputs).slice({ seat: "call", fromSec: 40, toSec: 42, purpose: "listen" });
        expect(call).toMatchObject({ track: "source-call", channel: 1 });

        const sourceOnly = meetingSound({ ...inputs, tracks: "source" });
        expect(sourceOnly.slice({ seat: "mic", fromSec: 40, toSec: 42, purpose: "listen" })).toMatchObject({
            track: "source-mic",
        });
        expect(
            sourceOnly.slice({ seat: "mic", fromSec: 40, toSec: 42, purpose: "listen", track: "mic-raw" })
        ).toMatchObject({ track: "mic-raw" });
        expect(meetingSound(inputs).slice({ seat: "mic", fromSec: 100, toSec: 102, purpose: "listen" })).toMatchObject({
            track: "source-mic",
        });
    });
});

describe("alignPiece", () => {
    const rate = 1000;

    /** Bursts of noise between pauses, as speech is: a seeded pattern, so the run is the same every time. */
    function bursts(seconds: number): Float32Array {
        const out = new Float32Array(seconds * rate);
        let seed = 7;
        const random = () => {
            seed = (seed * 16_807) % 2_147_483_647;
            return seed / 2_147_483_647;
        };
        let index = 0;

        while (index < out.length) {
            const length = Math.round((0.08 + random() * 0.4) * rate);
            const level = random() < 0.5 ? 0.001 : 0.2 + random() * 0.5;

            for (let step = 0; step < length && index < out.length; step++, index++) {
                out[index] = (random() * 2 - 1) * level;
            }
        }

        return out;
    }

    test("it finds a piece 0.37 s after its stamp, and keeps the stamp for a flat piece", () => {
        const call = bursts(30);
        const stampSec = 10;
        const fromSec = alignReferenceFromSec(stampSec);
        const reference = call.slice(fromSec * rate, 19 * rate);
        const piece = call.slice(10.37 * rate, 15.37 * rate);
        const aligned = alignPiece({ piece, reference, rate, stampSec });

        expect(aligned.clear).toBe(true);
        expect(aligned.zeroSec).toBeCloseTo(10.37, 2);

        const flat = new Float32Array(5 * rate).fill(0.1);
        expect(alignPiece({ piece: flat, reference, rate, stampSec })).toEqual({ zeroSec: stampSec, clear: false });
    });
});
