import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { CAPSULE_LEVEL_HZ, capsuleLevelFromPcm, openVoiceCapsule, serializeCapsuleEvent } from "./voice-capsule";

const LAUNCHER = "/tmp/fake-genesis/GenesisTools.app/Contents/MacOS/GenesisTools";

interface FakeSink {
    written: string[];
    write(chunk: string): number;
    flush(): number;
    end(): void;
}

function fakeSink(options: { throwOnWrite?: boolean } = {}): FakeSink {
    const written: string[] = [];
    return {
        written,
        write(chunk: string): number {
            if (options.throwOnWrite) {
                throw new Error("EPIPE: the capsule face is gone");
            }

            written.push(chunk);
            return chunk.length;
        },
        flush: () => 0,
        end: () => undefined,
    };
}

function fakeChild(sink: FakeSink, exitCode: number | null = null) {
    return {
        pid: 4242,
        stdin: sink,
        stdout: null,
        stderr: null,
        exited: Promise.resolve(0),
        exitCode,
        kill: () => undefined,
    };
}

let spy: ReturnType<typeof spyOn> | undefined;

function stubSpawn(sink: FakeSink, exitCode: number | null = 0): { argv: string[][] } {
    const argv: string[][] = [];
    // The fake child implements only what the client touches (stdin, exitCode, exited, kill), so the
    // implementation is cast as a whole rather than each field being stubbed to satisfy Subprocess.
    const implementation = (command: string[]) => {
        argv.push(command);
        return fakeChild(sink, exitCode);
    };
    spy = spyOn(Bun, "spawn").mockImplementation(implementation as unknown as typeof Bun.spawn);
    return { argv };
}

afterEach(() => {
    spy?.mockRestore();
    spy = undefined;
});

describe("serializeCapsuleEvent", () => {
    test("frames one JSON object per line with a trailing newline", () => {
        const line = serializeCapsuleEvent({ kind: "partial", text: "press seven" });
        expect(line.endsWith("\n")).toBe(true);
        expect(line.indexOf("\n")).toBe(line.length - 1);
        expect(SafeJSON.parse(line, { strict: true })).toEqual({ kind: "partial", text: "press seven" });
    });

    test("clamps the level into 0..1 and survives a non-finite reading", () => {
        expect(SafeJSON.parse(serializeCapsuleEvent({ kind: "level", rms: 4.5 }), { strict: true })).toEqual({
            kind: "level",
            rms: 1,
        });
        expect(SafeJSON.parse(serializeCapsuleEvent({ kind: "level", rms: -2 }), { strict: true })).toEqual({
            kind: "level",
            rms: 0,
        });
        expect(SafeJSON.parse(serializeCapsuleEvent({ kind: "level", rms: Number.NaN }), { strict: true })).toEqual({
            kind: "level",
            rms: 0,
        });
    });

    test("omits an absent decision label and probability", () => {
        const line = serializeCapsuleEvent({ kind: "decision", status: "hold" });
        expect(SafeJSON.parse(line, { strict: true })).toEqual({ kind: "decision", status: "hold" });
    });

    test("keeps a decision label and probability when given", () => {
        const line = serializeCapsuleEvent({
            kind: "decision",
            status: "act",
            label: "File > New Tab",
            probability: 0.82,
        });
        expect(SafeJSON.parse(line, { strict: true })).toEqual({
            kind: "decision",
            status: "act",
            label: "File > New Tab",
            probability: 0.82,
        });
    });
});

/** `frames` samples of a square wave at `amplitude` of full scale, as s16le mono. */
function pcmAt(amplitude: number, frames = 1600): Uint8Array {
    const samples = new Int16Array(frames);
    const value = Math.round(amplitude * 32767);
    for (let index = 0; index < frames; index++) {
        samples[index] = index % 2 === 0 ? value : -value;
    }

    return new Uint8Array(samples.buffer);
}

describe("capsuleLevelFromPcm", () => {
    test("silence reads as zero", () => {
        expect(capsuleLevelFromPcm(pcmAt(0))).toBe(0);
    });

    test("full scale reads as one", () => {
        expect(capsuleLevelFromPcm(pcmAt(1))).toBe(1);
    });

    test("ordinary speech reaches the top of the bars, where raw RMS would not", () => {
        // 0.219 was the loudest frame of the real Deepgram fixture; raw RMS there draws a 2.6 pt
        // bar, below the 4 pt floor, so every bar would sit flat.
        const level = capsuleLevelFromPcm(pcmAt(0.219));
        expect(level).toBeGreaterThan(0.9);
        expect(level).toBeLessThanOrEqual(1);
    });

    test("the mapping rises with loudness and bottoms out below the floor", () => {
        const quiet = capsuleLevelFromPcm(pcmAt(0.01));
        const loud = capsuleLevelFromPcm(pcmAt(0.1));
        expect(quiet).toBeGreaterThan(0);
        expect(quiet).toBeLessThan(loud);
        // -58 dBFS is the floor of the mapping.
        expect(capsuleLevelFromPcm(pcmAt(0.0005))).toBe(0);
    });
});

describe("openVoiceCapsule", () => {
    test("spawns the launcher twice, then --capsule and its flags", () => {
        const sink = fakeSink();
        const { argv } = stubSpawn(sink);
        const handle = openVoiceCapsule({ launcher: LAUNCHER, theme: "light", position: "top", screen: "1" });
        expect(handle).not.toBeNull();
        expect(argv).toHaveLength(1);
        expect(argv[0]).toEqual([
            LAUNCHER,
            LAUNCHER,
            "--capsule",
            "--theme",
            "light",
            "--position",
            "top",
            "--screen",
            "1",
        ]);
    });

    test("defaults to the dark theme and omits the flags it was not given", () => {
        const sink = fakeSink();
        const { argv } = stubSpawn(sink);
        openVoiceCapsule({ launcher: LAUNCHER });
        expect(argv[0]).toEqual([LAUNCHER, LAUNCHER, "--capsule", "--theme", "dark"]);
    });

    test("writes every non-level event straight through", () => {
        const sink = fakeSink();
        stubSpawn(sink);
        const handle = openVoiceCapsule({ launcher: LAUNCHER });
        handle?.send({ kind: "state", state: "listening" });
        handle?.send({ kind: "partial", text: "hey jev" });
        handle?.send({ kind: "final", text: "hey jev press seven" });
        handle?.send({ kind: "decision", status: "act", label: "7", probability: 0.99 });
        expect(sink.written).toHaveLength(4);
        expect(sink.written.map((line) => SafeJSON.parse(line, { strict: true }))).toEqual([
            { kind: "state", state: "listening" },
            { kind: "partial", text: "hey jev" },
            { kind: "final", text: "hey jev press seven" },
            { kind: "decision", status: "act", label: "7", probability: 0.99 },
        ]);
    });

    test("throttles level events to at most CAPSULE_LEVEL_HZ per second", () => {
        const sink = fakeSink();
        stubSpawn(sink);
        const handle = openVoiceCapsule({ launcher: LAUNCHER });
        const now = spyOn(Date, "now");
        try {
            // Three readings inside one 1/30 s window: only the first is sent.
            now.mockReturnValue(10_000);
            handle?.send({ kind: "level", rms: 0.1 });
            now.mockReturnValue(10_005);
            handle?.send({ kind: "level", rms: 0.2 });
            now.mockReturnValue(10_020);
            handle?.send({ kind: "level", rms: 0.3 });
            expect(sink.written).toHaveLength(1);

            // Past the gap, the next reading gets through.
            now.mockReturnValue(10_000 + Math.ceil(1000 / CAPSULE_LEVEL_HZ));
            handle?.send({ kind: "level", rms: 0.4 });
            expect(sink.written).toHaveLength(2);
            expect(SafeJSON.parse(sink.written[1] ?? "", { strict: true })).toEqual({ kind: "level", rms: 0.4 });
        } finally {
            now.mockRestore();
        }
    });

    test("a throttled level never blocks the next transcript event", () => {
        const sink = fakeSink();
        stubSpawn(sink);
        const handle = openVoiceCapsule({ launcher: LAUNCHER });
        const now = spyOn(Date, "now");
        try {
            now.mockReturnValue(20_000);
            handle?.send({ kind: "level", rms: 0.5 });
            handle?.send({ kind: "level", rms: 0.6 });
            handle?.send({ kind: "partial", text: "press" });
        } finally {
            now.mockRestore();
        }

        expect(sink.written.map((line) => SafeJSON.parse(line, { strict: true }))).toEqual([
            { kind: "level", rms: 0.5 },
            { kind: "partial", text: "press" },
        ]);
    });

    test("a dead child never throws into the caller and stops writing", () => {
        const sink = fakeSink({ throwOnWrite: true });
        stubSpawn(sink);
        const handle = openVoiceCapsule({ launcher: LAUNCHER });
        expect(() => handle?.send({ kind: "partial", text: "press seven" })).not.toThrow();
        expect(() => handle?.send({ kind: "final", text: "press seven" })).not.toThrow();
        expect(sink.written).toHaveLength(0);
    });

    test("returns null when there is no launcher to spawn", () => {
        const { argv } = stubSpawn(fakeSink());
        expect(openVoiceCapsule({ launcher: null })).toBeNull();
        expect(argv).toHaveLength(0);
    });

    test("close is idempotent and does not throw on an already-exited face", async () => {
        const sink = fakeSink();
        stubSpawn(sink, 0);
        const handle = openVoiceCapsule({ launcher: LAUNCHER });
        await handle?.close();
        await handle?.close();
        handle?.send({ kind: "partial", text: "after close" });
        expect(sink.written).toHaveLength(0);
    });
});
