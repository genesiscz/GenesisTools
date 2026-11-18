import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as converter from "@genesiscz/utils/audio/converter";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";
import { MeetingStore } from "./record";
import * as voice from "./voice";

const spies: Array<{ mockRestore(): void }> = [];
let fixtureIndex = 0;
afterEach(() => {
    for (const spy of spies.splice(0)) {
        spy.mockRestore();
    }
});

async function fixture() {
    const store = new MeetingStore();
    const record = await store.create(
        { title: `Voice cache fixture ${fixtureIndex++}`, start: "2026-01-01T10:00:00Z", createdBy: "new" },
        { command: "test", change: "cache fixture" }
    );
    const folder = store.folder(record.id);
    mkdirSync(join(folder, "source-audio"), { recursive: true });
    const audioPath = join(folder, "source-audio", "fixture.pcm");
    writeFileSync(audioPath, "invented audio");
    const samples = new Float32Array(60 * 16000).fill(0.03);
    samples.fill(0, 2 * 16000, 4 * 16000);
    samples.fill(0.04, 5 * 16000, 7 * 16000);
    const compute = mock(() => new Float32Array([1, 0]));
    const decode = spyOn(converter, "toFloat32AudioWindow").mockResolvedValue(samples);
    let model = "fixture-model";
    let speech = true;
    const backend = spyOn(voice, "localVoiceBackend").mockImplementation(() => ({
        model,
        extractor: {
            createStream: () => ({
                acceptWaveform: ({ samples: input }) => {
                    speech = input[0] !== samples[5 * 16000];
                },
                inputFinished: () => undefined,
            }),
            isReady: () => speech,
            compute,
        },
    }));
    spies.push(decode, backend);
    const options = {
        audioPath,
        spans: [{ index: 0, fromSec: 0, toSec: 2 }],
        channels: [{ channel: 0 as const, track: "raw-mic" as const }],
    };
    return {
        store,
        record,
        backend,
        options,
        compute,
        decode,
        cachePath: join(folder, "evidence", "voice-lines.json"),
        changeModel: () => {
            model = "fixture-model-2";
        },
    };
}

test("a reopened line cache reuses every ready, quiet, short and speechless span without decoding or extraction", async () => {
    const f = await fixture();
    const options = {
        ...f.options,
        spans: [
            { index: 0, fromSec: 0, toSec: 1 },
            { index: 1, fromSec: 0, toSec: 2 },
            { index: 2, fromSec: 2, toSec: 4 },
            { index: 3, fromSec: 5, toSec: 7 },
        ],
    };
    const first = await voice.embedVoiceLines(options);
    expect(first.map((line) => line.channels[0]?.quality)).toEqual(["unknown", "ready", "unknown", "unknown"]);
    expect(f.compute).toHaveBeenCalledTimes(1);
    expect(f.decode).toHaveBeenCalledTimes(1);
    expect(f.decode.mock.calls[0]?.[1].decoderThreads).toBe(1);
    expect(f.decode.mock.calls[0]?.[1].timeoutMs).toBe(120_000);
    const disk = z
        .object({ version: z.literal(1), entries: z.record(z.string(), z.unknown()) })
        .parse(SafeJSON.parse(readFileSync(f.cachePath, "utf8")));
    expect(disk.version).toBe(1);
    expect(Object.keys(disk.entries)).toHaveLength(4);
    f.compute.mockClear();
    f.decode.mockClear();
    expect(await voice.embedVoiceLines(options)).toEqual(first);
    expect(f.compute).not.toHaveBeenCalled();
    expect(f.decode).not.toHaveBeenCalled();
    const reindexed = await voice.embedVoiceLines({ ...options, spans: [{ index: 42, fromSec: 0, toSec: 2 }] });
    expect(reindexed).toEqual([{ ...first[1]!, index: 42 }]);
    expect(f.compute).not.toHaveBeenCalled();
});

test("the background worker owns model work and returns validated line results", async () => {
    const f = await fixture();
    const result: voice.LineEmbedding[] = [
        {
            index: 0,
            channels: [
                {
                    source: { audioPath: f.options.audioPath, size: 14, mtimeMs: 1 },
                    channel: 0,
                    track: "raw-mic",
                    fromSec: 0,
                    toSec: 2,
                    quality: "ready",
                    model: "fixture-model",
                    embedding: [1, 0],
                },
            ],
        },
    ];
    const output = SafeJSON.stringify(SafeJSON.stringify(result, { strict: true }), { strict: true });
    const child = Bun.spawn([process.execPath, "-e", `await Bun.stdin.text(); process.stdout.write(${output});`], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5_000,
        env: process.env,
    });
    const spawn = spyOn(Bun, "spawn").mockReturnValue(child);
    spies.push(spawn);
    const prefix = ["fixture-priority", "fixture-worker"];
    const workerHome = join(f.store.root, "worker-home");
    await env.testing.withOverrides({ GENESIS_TOOLS_HOME: workerHome, TMPDIR: workerHome }, async () => {
        expect(await voice.embedVoiceLines({ ...f.options, workerPrefix: prefix })).toEqual(result);
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[1]?.env?.GENESIS_TOOLS_HOME).toBe(workerHome);
    expect(spawn.mock.calls[0]?.[1]?.env?.TMPDIR).toBe(workerHome);
    const command = spawn.mock.calls[0]?.[0];
    if (!Array.isArray(command)) {
        throw new Error("Expected worker argv");
    }
    expect(command.slice(0, 2)).toEqual(prefix);
    expect(command[2]).toBe(process.execPath);
    expect(f.backend).toHaveBeenCalledTimes(1);
    expect(f.compute).not.toHaveBeenCalled();
    expect(f.decode).not.toHaveBeenCalled();
});

test("a complete cache hit starts neither a background worker nor extraction", async () => {
    const f = await fixture();
    const expected = await voice.embedVoiceLines(f.options);
    f.compute.mockClear();
    f.decode.mockClear();
    const spawn = spyOn(Bun, "spawn");
    spies.push(spawn);
    expect(await voice.embedVoiceLines({ ...f.options, workerPrefix: ["fixture-priority"] })).toEqual(expected);
    expect(spawn).not.toHaveBeenCalled();
    expect(f.compute).not.toHaveBeenCalled();
    expect(f.decode).not.toHaveBeenCalled();
});

test("a temporary decoder failure is retried instead of becoming a permanent unknown voice", async () => {
    const f = await fixture();
    f.decode.mockRejectedValueOnce(new Error("temporary decoder failure"));
    expect((await voice.embedVoiceLines(f.options))[0]?.channels[0]?.quality).toBe("unknown");
    expect((await voice.embedVoiceLines(f.options))[0]?.channels[0]?.quality).toBe("ready");
    expect(f.decode).toHaveBeenCalledTimes(2);
    expect(f.compute).toHaveBeenCalledTimes(1);
});

test("a cached line still anchors the decode window used by a later uncached line", async () => {
    const f = await fixture();
    await voice.embedVoiceLines(f.options);
    f.decode.mockClear();
    f.compute.mockClear();
    await voice.embedVoiceLines({ ...f.options, spans: [...f.options.spans, { index: 1, fromSec: 10, toSec: 12 }] });
    expect(f.decode).toHaveBeenCalledTimes(1);
    expect(f.decode.mock.calls[0]?.[1].fromSec).toBe(0);
    expect(f.compute).toHaveBeenCalledTimes(1);
});

test("audio windows keep default ffmpeg threads and accept an explicit decoder limit without changing samples", async () => {
    const commands: string[][] = [];
    for (const decoderThreads of [undefined, 1]) {
        const child = Bun.spawn(
            [process.execPath, "-e", 'process.stdout.write(Buffer.from("0000803e000000bf", "hex"));'],
            { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5_000, env: process.env }
        );
        const spawn = spyOn(Bun, "spawn").mockReturnValue(child);
        spies.push(spawn);
        try {
            const samples = await converter.toFloat32AudioWindow("fixture.wav", {
                fromSec: 0,
                toSec: 1,
                decoderThreads,
                ...(decoderThreads === undefined ? {} : { timeoutMs: 120_000 }),
            });
            expect(spawn.mock.calls[0]?.[1]?.timeout).toBe(decoderThreads === undefined ? 30_000 : 120_000);
            expect(Array.from(samples)).toEqual([0.25, -0.5]);
            const command = spawn.mock.calls[0]?.[0];
            if (!Array.isArray(command)) {
                throw new Error("Expected decoder argv");
            }
            commands.push(command);
        } finally {
            spawn.mockRestore();
        }
    }
    expect(commands[0]).not.toContain("-threads");
    expect(commands[0]).not.toContain("-filter_complex_threads");
    const limited = commands[1]!;
    expect(limited.slice(limited.indexOf("-threads"), limited.indexOf("-threads") + 2)).toEqual(["-threads", "1"]);
    expect(limited.indexOf("-threads")).toBeLessThan(limited.indexOf("-i"));
    expect(
        limited.slice(limited.indexOf("-filter_complex_threads"), limited.indexOf("-filter_complex_threads") + 2)
    ).toEqual(["-filter_complex_threads", "1"]);
});

test("a background sample preserves an unavailable-voice reason without running the model in its caller", async () => {
    const f = await fixture();
    const unavailable = "Voice sample is quiet; identity remains unknown";
    const output = SafeJSON.stringify(SafeJSON.stringify({ unavailable }, { strict: true }), { strict: true });
    const child = Bun.spawn([process.execPath, "-e", `await Bun.stdin.text(); process.stdout.write(${output});`], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5_000,
        env: process.env,
    });
    const spawn = spyOn(Bun, "spawn").mockReturnValue(child);
    spies.push(spawn);
    const result = voice.embedVoice({
        audioPath: f.options.audioPath,
        channel: 0,
        fromSec: 0,
        toSec: 2,
        workerPrefix: ["fixture-priority"],
    });
    await expect(result).rejects.toBeInstanceOf(voice.VoiceUnavailableError);
    await expect(result).rejects.toThrow(unavailable);
    expect(f.backend).not.toHaveBeenCalled();
    expect(f.decode).not.toHaveBeenCalled();
});

test("invalid decoder limits fail before spawning a child", async () => {
    const spawn = spyOn(Bun, "spawn");
    spies.push(spawn);
    for (const decoderThreads of [0, -1, 1.5]) {
        await expect(
            converter.toFloat32AudioWindow("fixture.wav", { fromSec: 0, toSec: 1, decoderThreads })
        ).rejects.toThrow("Decoder threads must be a positive integer");
    }
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(
            converter.toFloat32AudioWindow("fixture.wav", { fromSec: 0, toSec: 1, timeoutMs })
        ).rejects.toThrow("Decoder timeout must be positive and finite");
    }
    expect(spawn).not.toHaveBeenCalled();
});

test("a copied meeting keeps embeddings in its own folder when its retained source is elsewhere", async () => {
    const f = await fixture();
    const external = join(f.store.root, "..", `external-voice-fixture-${fixtureIndex}.pcm`);
    writeFileSync(external, "invented audio");
    await f.store.update(f.record.id, { command: "test", change: "external source fixture" }, (record) => {
        record.audio = {
            sources: {
                fixture: {
                    sourceMeetingId: "fixture-source",
                    path: external,
                    sha256: "a".repeat(64),
                    bytes: 14,
                    savedAt: "2026-01-01T10:00:00Z",
                },
            },
        };
    });
    const options = { ...f.options, audioPath: external };
    const first = await voice.embedVoiceLines(options);
    expect(readFileSync(f.cachePath, "utf8")).toContain("fixture-model");
    f.compute.mockClear();
    f.decode.mockClear();
    expect(await voice.embedVoiceLines(options)).toEqual(first);
    expect(f.compute).not.toHaveBeenCalled();
    expect(f.decode).not.toHaveBeenCalled();
});

test("each channel decodes a shared 60 second window once for several lines", async () => {
    const f = await fixture();
    await voice.embedVoiceLines({
        ...f.options,
        spans: [
            { index: 0, fromSec: 0, toSec: 2 },
            { index: 1, fromSec: 10, toSec: 12 },
            { index: 2, fromSec: 59, toSec: 61 },
            { index: 3, fromSec: 62, toSec: 64 },
        ],
        channels: [
            { channel: 0, track: "raw-mic" },
            { channel: 1, track: "isolated-call" },
        ],
    });
    expect(f.compute).toHaveBeenCalledTimes(8);
    expect(f.decode).toHaveBeenCalledTimes(4);
});

test("a changed source mtime misses even when the bytes and span stay the same", async () => {
    const f = await fixture();
    await voice.embedVoiceLines(f.options);
    const stat = statSync(f.options.audioPath);
    utimesSync(f.options.audioPath, stat.atime, new Date(stat.mtimeMs + 1000));
    await voice.embedVoiceLines(f.options);
    expect(f.compute).toHaveBeenCalledTimes(2);
    expect(f.decode).toHaveBeenCalledTimes(2);
});

test("model, source size and path, channel, track and millisecond span are distinct cache inputs", async () => {
    const f = await fixture();
    await voice.embedVoiceLines(f.options);
    await voice.embedVoiceLines({ ...f.options, channels: [{ channel: 1, track: "raw-mic" }] });
    await voice.embedVoiceLines({ ...f.options, channels: [{ channel: 0, track: "clean-mic" }] });
    await voice.embedVoiceLines({ ...f.options, spans: [{ index: 0, fromSec: 0, toSec: 1.999 }] });
    f.changeModel();
    await voice.embedVoiceLines(f.options);
    const stat = statSync(f.options.audioPath);
    writeFileSync(f.options.audioPath, "invented audio with more bytes");
    utimesSync(f.options.audioPath, stat.atime, stat.mtime);
    await voice.embedVoiceLines(f.options);
    const otherPath = join(f.options.audioPath, "..", "other.pcm");
    writeFileSync(otherPath, "invented audio with more bytes");
    utimesSync(otherPath, stat.atime, stat.mtime);
    await voice.embedVoiceLines({ ...f.options, audioPath: otherPath });
    expect(f.compute).toHaveBeenCalledTimes(7);
});

test.each(["{broken", '{"version":1,"entries":{"bad":{"quality":"ready","embedding":[]}}}'])(
    "a corrupt cache is a logged miss and is replaced by readable results: %s",
    async (broken) => {
        const f = await fixture();
        const debug = spyOn(logger, "debug");
        spies.push(debug);
        mkdirSync(join(f.cachePath, ".."), { recursive: true });
        writeFileSync(f.cachePath, broken);
        const result = await voice.embedVoiceLines(f.options);
        expect(result[0]?.channels[0]?.quality).toBe("ready");
        expect(f.compute).toHaveBeenCalledTimes(1);
        expect(debug).toHaveBeenCalled();
        f.compute.mockClear();
        expect(await voice.embedVoiceLines(f.options)).toEqual(result);
        expect(f.compute).not.toHaveBeenCalled();
    }
);
