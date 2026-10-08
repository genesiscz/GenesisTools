import { expect, mock, spyOn, test } from "bun:test";
import { accountEntrySchema } from "@genesiscz/utils/ai/config/schema";
import { voiceConfiguration } from "@genesiscz/utils/ai/voice/configuration";
import { createVoiceSession } from "@genesiscz/utils/ai/voice/session";
import type { PcmSource } from "./capture/pcm-source";
import * as capture from "./capture/pcm-source";
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
