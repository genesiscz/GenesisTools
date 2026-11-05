import { describe, expect, spyOn, test } from "bun:test";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { AIXAITranscriptionProvider } from "./AIXAITranscriptionProvider";

describe("AIXAITranscriptionProvider", () => {
    test("has correct type", () => {
        const p = new AIXAITranscriptionProvider();
        expect(p.type).toBe("xai");
    });

    test("supports transcribe only", () => {
        const p = new AIXAITranscriptionProvider();
        expect(p.supports("transcribe")).toBe(true);
        expect(p.supports("tts")).toBe(false);
        expect(p.supports("translate")).toBe(false);
    });

    test("posts the file to /v1/stt with the model, which the endpoint needs (404 Not Found without it)", async () => {
        const seen: Array<{ url: string; model: unknown; auth: string | null }> = [];
        const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
            input: RequestInfo | URL,
            init?: RequestInit
        ) => {
            const form = init?.body as FormData;
            seen.push({
                url: String(input),
                model: form.get("model"),
                auth: new Headers(init?.headers).get("authorization"),
            });
            return new Response(SafeJSON.stringify({ text: "hello", duration: 1, words: [] }), { status: 200 });
        }) as typeof fetch);

        try {
            const result = await new AIXAITranscriptionProvider({ apiKey: "test-key" }).transcribe(
                Buffer.from("ID3fake")
            );
            expect(result.text).toBe("hello");
            expect(seen).toEqual([
                { url: "https://api.x.ai/v1/stt", model: "grok-voice-transcribe-2.0", auth: "Bearer test-key" },
            ]);
        } finally {
            fetchSpy.mockRestore();
        }
    });

    test("isAvailable reflects X_AI_API_KEY", async () => {
        const p = new AIXAITranscriptionProvider();
        expect(await p.isAvailable()).toBe(env.x.hasApiKey());
    });
});
