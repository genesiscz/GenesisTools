import { describe, expect, test } from "bun:test";
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

    test("isAvailable reflects X_AI_API_KEY", async () => {
        const p = new AIXAITranscriptionProvider();
        expect(await p.isAvailable()).toBe(!!process.env.X_AI_API_KEY);
    });
});
