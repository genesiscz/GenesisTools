import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@app/utils/json";
import { AIXAITextToSpeechProvider } from "./AIXAITextToSpeechProvider";

describe("AIXAITextToSpeechProvider", () => {
    test("has correct type", () => {
        const provider = new AIXAITextToSpeechProvider();
        expect(provider.type).toBe("xai");
    });

    test("supports tts only", () => {
        const provider = new AIXAITextToSpeechProvider();
        expect(provider.supports("tts")).toBe(true);
        expect(provider.supports("transcribe")).toBe(false);
        expect(provider.supports("translate")).toBe(false);
        expect(provider.supports("summarize")).toBe(false);
        expect(provider.supports("embed")).toBe(false);
    });

    test("isAvailable reflects X_AI_API_KEY", async () => {
        const provider = new AIXAITextToSpeechProvider();
        const available = await provider.isAvailable();
        expect(available).toBe(!!process.env.X_AI_API_KEY);
    });

    test("synthesize() rejects text over 15k chars", async () => {
        const provider = new AIXAITextToSpeechProvider();
        const longText = "a".repeat(15_001);

        await expect(provider.synthesize(longText)).rejects.toThrow(/15000-character/);
    });

    // Live integration: hits the real xAI voices endpoint when X_AI_API_KEY is set.
    // Uses forceFreshVoices: true to bypass the 7-day Storage cache.
    test.skipIf(!process.env.X_AI_API_KEY)(
        "listVoices() returns voices from real /v1/tts/voices endpoint (requires X_AI_API_KEY)",
        async () => {
            const provider = new AIXAITextToSpeechProvider({ forceFreshVoices: true });
            const voices = await provider.listVoices();

            expect(voices.length).toBeGreaterThan(0);
            // xAI documents these voice ids; at least one should be present.
            const ids = voices.map((v) => v.id.toLowerCase());
            const knownVoices = ["eve", "ara", "rex", "sal", "leo"];
            const overlap = knownVoices.filter((id) => ids.includes(id));
            expect(overlap.length).toBeGreaterThan(0);

            for (const voice of voices) {
                expect(typeof voice.id).toBe("string");
                expect(voice.id.length).toBeGreaterThan(0);
                expect(typeof voice.name).toBe("string");
            }
        }
    );

    test.skipIf(!process.env.X_AI_API_KEY)("listVoices() second call hits cache (requires X_AI_API_KEY)", async () => {
        // First call (cached, possibly fresh) — just to seed the cache.
        const seed = new AIXAITextToSpeechProvider();
        await seed.listVoices();

        // Stub fetch — if the cache is honored, fetch should NOT be called.
        const originalFetch = globalThis.fetch;
        let fetchCalled = false;
        // @ts-expect-error -- fetch stub for test
        globalThis.fetch = async (...args) => {
            fetchCalled = true;
            return originalFetch(...args);
        };

        try {
            const cached = new AIXAITextToSpeechProvider();
            const voices = await cached.listVoices();
            expect(voices.length).toBeGreaterThan(0);
            expect(fetchCalled).toBe(false);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

type Listener = (ev: unknown) => void;

class FakeWebSocket {
    private listeners: Record<string, Listener[]> = {};
    sent: string[] = [];

    addEventListener(name: string, fn: Listener): void {
        if (!this.listeners[name]) {
            this.listeners[name] = [];
        }

        this.listeners[name].push(fn);
    }

    send(payload: string): void {
        this.sent.push(payload);
    }

    close(): void {
        /* noop */
    }

    emit(name: string, ev: unknown): void {
        for (const fn of this.listeners[name] ?? []) {
            fn(ev);
        }
    }
}

function withFakeWs(provider: AIXAITextToSpeechProvider): FakeWebSocket {
    const fake = new FakeWebSocket();
    const client = (provider as unknown as { client: { openWebSocket: () => FakeWebSocket } }).client;
    client.openWebSocket = () => fake;
    return fake;
}

describe("AIXAITextToSpeechProvider.synthesizeStream", () => {
    test("sends text.delta + text.done and yields decoded audio.delta until audio.done", async () => {
        const provider = new AIXAITextToSpeechProvider();
        const fake = withFakeWs(provider);

        const { audio, contentType } = provider.synthesizeStream("hello world", { voice: "eve", language: "en" });
        expect(contentType).toBe("audio/mpeg");

        const collected: Uint8Array[] = [];
        const consumer = (async () => {
            for await (const chunk of audio) {
                collected.push(chunk);
            }
        })();

        fake.emit("open", {});
        fake.emit("message", {
            data: SafeJSON.stringify({ type: "audio.delta", delta: Buffer.from("AAAA").toString("base64") }),
        });
        fake.emit("message", {
            data: SafeJSON.stringify({ type: "audio.delta", delta: Buffer.from("BBBB").toString("base64") }),
        });
        fake.emit("message", { data: SafeJSON.stringify({ type: "audio.done" }) });

        await consumer;

        expect(fake.sent).toEqual([
            SafeJSON.stringify({ type: "text.delta", delta: "hello world" }),
            SafeJSON.stringify({ type: "text.done" }),
        ]);
        expect(Buffer.concat(collected).toString("utf8")).toBe("AAAABBBB");
    });

    test("splits text > 5000 chars into multiple text.delta frames", async () => {
        const provider = new AIXAITextToSpeechProvider();
        const fake = withFakeWs(provider);

        const long = "x".repeat(12_500);
        const { audio } = provider.synthesizeStream(long);

        const consumer = (async () => {
            for await (const _ of audio) {
                /* drain */
            }
        })();

        fake.emit("open", {});
        fake.emit("message", { data: SafeJSON.stringify({ type: "audio.done" }) });
        await consumer;

        const deltas = fake.sent.filter((s) => s.includes('"text.delta"'));
        const done = fake.sent.filter((s) => s.includes('"text.done"'));
        expect(deltas).toHaveLength(3); // 5000 + 5000 + 2500
        expect(done).toHaveLength(1);
    });

    test("uses audio/wav content type when format=wav", () => {
        const provider = new AIXAITextToSpeechProvider();
        withFakeWs(provider);
        const { contentType } = provider.synthesizeStream("hi", { format: "wav" });
        expect(contentType).toBe("audio/wav");
    });

    test("surfaces error frames as iterator throw", async () => {
        const provider = new AIXAITextToSpeechProvider();
        const fake = withFakeWs(provider);

        const { audio } = provider.synthesizeStream("test");

        const consumer = (async () => {
            for await (const _ of audio) {
                /* drain */
            }
        })();

        fake.emit("open", {});
        fake.emit("message", { data: SafeJSON.stringify({ type: "error", message: "voice not found" }) });

        await expect(consumer).rejects.toThrow(/xAI TTS error: voice not found/);
    });

    test("flags unexpected close (code 1006) before audio.done", async () => {
        const provider = new AIXAITextToSpeechProvider();
        const fake = withFakeWs(provider);

        const { audio } = provider.synthesizeStream("test");

        const consumer = (async () => {
            for await (const _ of audio) {
                /* drain */
            }
        })();

        fake.emit("open", {});
        fake.emit("close", { code: 1006 });

        await expect(consumer).rejects.toThrow(/closed before audio\.done \(code 1006\)/);
    });
});
