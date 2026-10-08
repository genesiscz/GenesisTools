import { expect, mock, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountEntrySchema } from "@genesiscz/utils/ai/config/schema";
import { voiceConfiguration } from "@genesiscz/utils/ai/voice/configuration";
import { recordingControl, recordingFailure, recordPcmClip } from "@genesiscz/utils/ai/voice/record";
import { createVoiceSession } from "@genesiscz/utils/ai/voice/session";
import * as capture from "./capture/pcm-source";
import { openPcmSource, type PcmSource } from "./capture/pcm-source";
import { createFixtureStt } from "./fixture";
import * as stt from "./resolve";
import { openLiveStt, parseSttProvider, selectSttAccount } from "./resolve";
import { type LiveSttSession, type LiveTranscriptEvent, STT_PROVIDER_IDS } from "./types";
import { LocalVad, pcmRms } from "./vad";
import { canDispatchWake, WakeRateLimiter } from "./wake/jev";
import { isStopUtterance, matchWake, parseWakePhrases } from "./wake/word";

const sample: LiveTranscriptEvent[] = [
    { kind: "partial", text: "click", isFinal: false, startedAtMs: 1 },
    { kind: "final", text: "click export", isFinal: true, startedAtMs: 1, endedAtMs: 400 },
];

test("fixture provider emits partial then final, accepts audio, and close is idempotent", async () => {
    const session = createFixtureStt({ events: sample });
    session.write(new Uint8Array(320));
    session.end();
    const seen: string[] = [];
    for await (const event of session.events()) {
        seen.push(`${event.kind}:${event.text}`);
    }
    expect(seen).toEqual(["partial:click", "final:click export"]);
    await session.close();
    await session.close();
});

test("openLiveStt fixture replays supplied events", async () => {
    const session = await openLiveStt({ provider: "fixture", events: sample });
    expect(session.provider).toBe("fixture");
    const texts: string[] = [];
    for await (const event of session.events()) {
        texts.push(event.text);
    }
    expect(texts).toEqual(["click", "click export"]);
});

test("parseSttProvider accepts the closed set, normalises aliases, rejects unknown ids", () => {
    expect(STT_PROVIDER_IDS).toEqual(["deepgram", "openai", "xai", "elevenlabs", "fixture"]);
    expect(parseSttProvider("xai")).toBe("xai");
    expect(parseSttProvider("grok-live")).toBe("xai");
    expect(parseSttProvider("gpt-realtime")).toBe("openai");
    expect(parseSttProvider("mock")).toBe("fixture");
    expect(parseSttProvider("scribe")).toBe("elevenlabs");
    expect(() => parseSttProvider("bonsai")).toThrow(/Unknown STT provider/);
});

test("an explicit account that does not exist is refused before any socket work", async () => {
    await expect(openLiveStt({ provider: "deepgram", account: "no-such-account-xyz" })).rejects.toThrow(
        /No AI account 'no-such-account-xyz'/
    );
});

test("pcm rms and the local VAD detect speech start and end", () => {
    const silent = new Uint8Array(3200);
    expect(pcmRms(silent)).toBe(0);
    const loud = new Uint8Array(3200);
    const view = new DataView(loud.buffer);
    for (let offset = 0; offset < loud.byteLength; offset += 2) {
        view.setInt16(offset, offset % 4 === 0 ? 12000 : -12000, true);
    }
    expect(pcmRms(loud)).toBeGreaterThan(0.3);

    let now = 0;
    const vad = new LocalVad({ silenceMs: 400 }, () => now);
    expect(vad.push(silent)).toBeNull();
    expect(vad.push(loud)).toBe("speech_start");
    now = 100;
    expect(vad.push(silent)).toBeNull();
    now = 600;
    expect(vad.push(silent)).toBe("speech_end");
});

test("wake matcher prefers the longest phrase and returns the remainder", () => {
    const phrases = parseWakePhrases("hey jev, jev");
    expect(matchWake("Hey Jev, press seven", phrases)).toEqual({ matched: "hey jev", remainder: "press seven" });
    expect(matchWake("please jev go back", phrases)).toEqual({ matched: "jev", remainder: "go back" });
    expect(matchWake("nothing here", phrases)).toBeNull();
    expect(isStopUtterance("Never mind")).toBe(true);
    expect(isStopUtterance("never mind that button")).toBe(false);
});

test("wake dispatch needs woke and complete, and a confirmation when destructive", () => {
    const base = { woke: true, remainder: "send it", destructive: true, complete: true, probabilities: {} };
    expect(canDispatchWake(base)).toBe(false);
    expect(canDispatchWake(base, true)).toBe(true);
    expect(canDispatchWake({ ...base, destructive: false })).toBe(true);
    expect(canDispatchWake({ ...base, destructive: false, complete: false })).toBe(false);
});

test("wake rate limiter coalesces partials to one evaluation per interval and lets finals through", () => {
    let now = 0;
    const limiter = new WakeRateLimiter(400, () => now);
    expect(limiter.admit("hey", false)).toBe("hey");
    now = 100;
    expect(limiter.admit("hey jev", false)).toBeNull();
    now = 200;
    expect(limiter.admit("hey jev press", false)).toBeNull();
    expect(limiter.takePending()).toBe("hey jev press");
    now = 300;
    expect(limiter.admit("hey jev press seven", true)).toBe("hey jev press seven");
    now = 350;
    expect(limiter.admit("x", false)).toBeNull();
    now = 800;
    expect(limiter.admit("y", false)).toBe("y");
});

test("general voice session preserves fixture finals without opening a microphone or Eve", async () => {
    const seen: string[] = [];
    const voice = await createVoiceSession({
        provider: "fixture",
        input: "none",
        events: sample,
        onEvent: (event) => seen.push(event.kind),
    });
    expect(await voice.done).toBe("click export");
    expect(seen).toContain("partial");
    expect(seen).toContain("final");
    expect(seen.at(-1)).toBe("state");
    voice.stop();
});

test("session summary replaces stitched finals without dropping intentionally repeated speech", async () => {
    const voice = await createVoiceSession({
        provider: "fixture",
        input: "none",
        events: [
            { kind: "partial", text: "Go", isFinal: false, startedAtMs: 1 },
            { kind: "final", text: "Go now.", isFinal: true, startedAtMs: 2 },
            { kind: "final", text: "Go now.", isFinal: true, startedAtMs: 3 },
            { kind: "session_final", text: "Go now. Go now. Thanks.", isFinal: true, startedAtMs: 4 },
        ],
        onEvent() {},
    });
    expect(await voice.done).toBe("Go now. Go now. Thanks.");
});

test("general voice session refuses cancellation before opening a provider", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
        createVoiceSession({ provider: "fixture", input: "none", signal: controller.signal, onEvent: () => {} })
    ).rejects.toThrow();
});

test("dictation inventory projects account metadata without reading any credential", async () => {
    const account = accountEntrySchema.parse({
        id: "acc_work",
        name: "work",
        label: "Speech",
        provider: "xai",
        enabled: true,
        billing: { mode: "metered" },
        credentials: {},
    });
    Object.defineProperty(account, "credentials", {
        get() {
            throw new Error("Inventory must never inspect credentials");
        },
    });
    const result = await voiceConfiguration({
        readStore: async () => ({
            accounts: (filter) => {
                expect(filter).toEqual({ enabled: true });
                return [
                    account,
                    {
                        ...accountEntrySchema.parse({
                            id: "acc_personal",
                            name: "personal",
                            provider: "openai-subscription",
                            enabled: true,
                            billing: { mode: "subscription" },
                            credentials: {},
                        }),
                    },
                ];
            },
        }),
    });
    expect(result.providers.find((provider) => provider.id === "xai")?.accounts).toEqual([
        { id: "acc_work", name: "Speech" },
    ]);
    expect(result.providers.flatMap((provider) => provider.accounts)).toHaveLength(1);
    expect(result.providers.every((provider) => provider.models.includes(provider.defaultModel))).toBe(true);
});

test("explicit dictation account refuses disabled credentials and still accepts an enabled account", () => {
    const account = accountEntrySchema.parse({
        id: "acc_work",
        name: "work",
        provider: "xai",
        enabled: true,
        billing: { mode: "metered" },
        credentials: {},
    });
    const options = { provider: "xai" as const, account: account.id };
    expect(() =>
        selectSttAccount({
            ...options,
            store: {
                account: () => ({ ...account, enabled: false }),
                accounts: () => [],
            },
        })
    ).toThrow("disabled");
    expect(
        selectSttAccount({
            ...options,
            store: {
                account: () => account,
                accounts: () => [account],
            },
        })
    ).toBe(account);
});

test("voice setup cancellation reaches a pending provider before it can open a capture", async () => {
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const close = mock(async () => {});
    const fixture: LiveSttSession = { provider: "fixture", write() {}, end() {}, async *events() {}, close };
    const provider = spyOn(stt, "openLiveStt").mockImplementation((options) => {
        signal = options.signal;
        return new Promise((resolve) => {
            release = () => resolve(fixture);
        });
    });
    const opening = createVoiceSession({ provider: "fixture", input: "none", signal: controller.signal, onEvent() {} });
    const settled = opening.then((voice) => voice.done).catch(() => undefined);
    try {
        controller.abort(new Error("cancelled setup"));
        expect(signal?.aborted).toBe(true);
        release?.();
        await expect(opening).rejects.toThrow("cancelled setup");
        expect(close).toHaveBeenCalledTimes(1);
    } finally {
        release?.();
        await settled;
        provider.mockRestore();
    }
});

test("voice setup cancellation reaches pending PCM capture and closes both resources", async () => {
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const closeProvider = mock(async () => {});
    const closeCapture = mock(async () => {});
    const fixture: LiveSttSession = {
        provider: "fixture",
        write() {},
        end() {},
        async *events() {},
        close: closeProvider,
    };
    const source: PcmSource = {
        kind: "file",
        label: "fixture",
        sampleRateHz: 16000,
        async *frames() {},
        close: closeCapture,
    };
    const provider = spyOn(stt, "openLiveStt").mockResolvedValue(fixture);
    const pcm = spyOn(capture, "openPcmSource").mockImplementation((options) => {
        signal = options.signal;
        return new Promise((resolve) => {
            release = () => resolve(source);
        });
    });
    const opening = createVoiceSession({
        provider: "fixture",
        input: "/fixture/raw.pcm",
        signal: controller.signal,
        onEvent() {},
    });
    const settled = opening.then((voice) => voice.done).catch(() => undefined);
    try {
        await Promise.resolve();
        controller.abort(new Error("cancelled capture"));
        expect(signal?.aborted).toBe(true);
        release?.();
        await expect(opening).rejects.toThrow("cancelled capture");
        expect(closeProvider).toHaveBeenCalledTimes(1);
        expect(closeCapture).toHaveBeenCalledTimes(1);
    } finally {
        release?.();
        await settled;
        pcm.mockRestore();
        provider.mockRestore();
    }
});

test("input none is refused for a cloud provider before any provider connection opens", async () => {
    const provider = spyOn(stt, "openLiveStt").mockRejectedValue(new Error("provider must not open"));
    try {
        await expect(createVoiceSession({ provider: "xai", input: "none", onEvent() {} })).rejects.toThrow(
            "Input none is reserved for fixture replay"
        );
        expect(provider).not.toHaveBeenCalled();
    } finally {
        provider.mockRestore();
    }
});

test("voice cleanup preserves the provider failure and always emits stopped", async () => {
    const seen: string[] = [];
    const fixture: LiveSttSession = {
        provider: "fixture",
        write() {},
        end() {},
        async *events() {
            yield { kind: "error", text: "", isFinal: false, startedAtMs: 0, error: "provider failure" };
        },
        async close() {
            throw new Error("cleanup failure");
        },
    };
    const provider = spyOn(stt, "openLiveStt").mockResolvedValue(fixture);
    try {
        const voice = await createVoiceSession({
            provider: "fixture",
            input: "none",
            onEvent(event) {
                if (event.kind === "state") {
                    seen.push(event.state);
                }
            },
        });
        await expect(voice.done).rejects.toThrow("provider failure");
        expect(seen.at(-1)).toBe("stopped");
    } finally {
        provider.mockRestore();
    }
});

test("local recording bounds synthetic PCM, preserves its source and creates a private clip", async () => {
    const directory = mkdtempSync(join(tmpdir(), "voice-record-"));
    const input = join(directory, "input.pcm");
    const output = join(directory, "clip.pcm");
    const pcm = Buffer.alloc(6400);
    for (let index = 0; index < pcm.length; index += 2) {
        pcm.writeInt16LE(4000, index);
    }
    writeFileSync(input, pcm);
    const kinds: string[] = [];
    const clip = await recordPcmClip({ input, output, maxDurationMs: 100, onEvent: (event) => kinds.push(event.kind) });
    expect(clip).toMatchObject({ bytes: 3200, durationMs: 100, channels: 1, encoding: "s16le", endedBy: "limit" });
    expect(clip.peakRms).toBeGreaterThan(0);
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(readFileSync(output)).toEqual(pcm.subarray(0, 3200));
    expect(readFileSync(input)).toEqual(pcm);
    expect(kinds).toEqual(["recording", "level"]);
    await expect(recordPcmClip({ input, output })).rejects.toThrow();
    expect(readFileSync(output)).toEqual(pcm.subarray(0, 3200));
});

test("recording cancellation and source errors close capture and remove only unfinished output", async () => {
    const directory = mkdtempSync(join(tmpdir(), "voice-record-cancel-"));
    const input = join(directory, "input.pcm");
    const output = join(directory, "clip.pcm");
    writeFileSync(input, Buffer.alloc(6400));
    const controller = new AbortController();
    let closed = 0;
    await expect(
        recordPcmClip({
            input,
            output,
            signal: controller.signal,
            openSource: async () => ({
                kind: "file",
                label: input,
                sampleRateHz: 16000,
                async *frames() {
                    yield new Uint8Array(3200);
                    controller.abort();
                    yield new Uint8Array(3200);
                },
                close: async () => {
                    closed++;
                },
            }),
        })
    ).rejects.toThrow();
    expect(closed).toBe(1);
    expect(existsSync(output)).toBe(false);
    await expect(
        recordPcmClip({
            input,
            output,
            openSource: async () => ({
                kind: "file",
                label: input,
                sampleRateHz: 16000,
                async *frames() {
                    yield await Promise.reject(new Error("fixture capture failed"));
                },
                close: async () => {
                    closed++;
                },
            }),
        })
    ).rejects.toThrow("fixture capture failed");
    expect(existsSync(output)).toBe(false);
    expect((await recordPcmClip({ input, output })).bytes).toBe(6400);
});

test("graceful owner stop retains captured audio while empty recordings stay retryable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "voice-record-stop-"));
    const input = join(directory, "input.pcm");
    const output = join(directory, "clip.pcm");
    writeFileSync(input, Buffer.alloc(6400));
    const stop = new AbortController();
    const clip = await recordPcmClip({
        input,
        output,
        stopSignal: stop.signal,
        openSource: async () => ({
            kind: "file",
            label: input,
            sampleRateHz: 16000,
            async *frames() {
                yield new Uint8Array(3200);
                stop.abort();
                yield new Uint8Array(3200);
            },
            close: async () => {},
        }),
    });
    expect(clip).toMatchObject({ bytes: 3200, endedBy: "stop" });
    const empty = join(directory, "empty.pcm");
    writeFileSync(empty, "");
    const emptyOutput = join(directory, "empty-output.pcm");
    await expect(recordPcmClip({ input: empty, output: emptyOutput })).rejects.toThrow("no audio");
    expect(existsSync(emptyOutput)).toBe(false);
});

test("microphone recording requires an explicit available host and never falls back", async () => {
    const directory = mkdtempSync(join(tmpdir(), "voice-record-launcher-"));
    const output = join(directory, "clip.pcm");
    await expect(recordPcmClip({ output })).rejects.toThrow("explicit --mic-launcher");
    await expect(openPcmSource({ input: "mic", micLauncher: join(directory, "missing-preview") })).rejects.toThrow(
        "no production fallback"
    );
    await expect(openPcmSource({ input: "mic", micLauncher: "relative-launcher" })).rejects.toThrow(
        "absolute executable"
    );
    expect(existsSync(output)).toBe(false);
});

test("recording gate waits for complete explicit start and observes owner EOF", async () => {
    let pipe!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({
        start(controller) {
            pipe = controller;
        },
    });
    const owner = recordingControl({ input, signal: new AbortController().signal, waitForStart: true });
    let started = false;
    const ready = owner.ready.then(() => {
        started = true;
    });
    pipe.enqueue(new TextEncoder().encode("sta"));
    await Promise.resolve();
    expect(started).toBe(false);
    pipe.enqueue(new TextEncoder().encode("rt\n"));
    await ready;
    expect(started).toBe(true);
    pipe.close();
    await owner.close();
    expect(owner.stopSignal.aborted).toBe(true);
    const earlyEOF = recordingControl({
        input: new ReadableStream({
            start(controller) {
                controller.close();
            },
        }),
        signal: new AbortController().signal,
        waitForStart: true,
    });
    await expect(earlyEOF.ready).rejects.toThrow("closed before start");
    await earlyEOF.close();
});

test("capture child permission, interruption, failure and empty success remain distinct", async () => {
    const directory = mkdtempSync(join(tmpdir(), "voice-capture-errors-"));
    for (const [status, code] of [
        [77, "microphone_permission"],
        [143, "capture_interrupted"],
        [70, "capture_failed"],
        [0, "no_audio"],
    ] as const) {
        const launcher = join(directory, `launcher-${status}`);
        const output = join(directory, `clip-${status}.pcm`);
        writeFileSync(launcher, `#!/bin/sh\necho 'fixture diagnostic only' >&2\nexit ${status}\n`);
        chmodSync(launcher, 0o700);
        try {
            await recordPcmClip({ output, micLauncher: launcher });
            throw new Error("capture unexpectedly succeeded");
        } catch (error) {
            expect(recordingFailure(error)).toEqual({ kind: "error", code });
            expect(error instanceof Error ? error.message : "").not.toContain("fixture diagnostic");
        }
        expect(existsSync(output)).toBe(false);
    }
    const launcher = join(directory, "launcher-success");
    writeFileSync(launcher, "#!/bin/sh\nhead -c 3200 /dev/zero\n");
    chmodSync(launcher, 0o700);
    expect((await recordPcmClip({ output: join(directory, "success.pcm"), micLauncher: launcher })).bytes).toBe(3200);
});
