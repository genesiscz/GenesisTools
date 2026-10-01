import { describe, expect, it } from "bun:test";
import { quotesFor, quoteTranscription } from "./speech";

/** The poteto video, 38m 2s. */
const POTETO_SECONDS = 38 * 60 + 2;

describe("speech pricing", () => {
    it("prices an hour of xAI batch at $0.10 and streaming at $0.20", () => {
        const quote = quoteTranscription("xai", 3600);

        expect(quote.model).toBe("grok-voice-transcribe-2.0");
        expect(quote.mode).toBe("batch");
        expect(quote.usd).toBeCloseTo(0.1, 10);
        expect(quote.usdPerHour).toBeCloseTo(0.1, 10);
        const stream = quotesFor(3600).find(
            (row) => row.provider === "xai" && row.model === "grok-voice-transcribe-2.0" && row.mode === "stream"
        );
        expect(stream?.usd).toBeCloseTo(0.2, 10);
    });

    it("prices whisper once per audio second, not twice", () => {
        const quote = quoteTranscription("openai", 60);

        expect(quote.usd).toBeCloseTo(0.006, 10);
        expect(quote.usd).not.toBeCloseTo(0.012, 10);
    });

    it("prices the poteto video cheaper on xAI batch than on Deepgram nova-3 or Whisper", () => {
        const xai = quoteTranscription("xai", POTETO_SECONDS);
        const deepgram = quoteTranscription("deepgram", POTETO_SECONDS);
        const openai = quoteTranscription("openai", POTETO_SECONDS);
        const groq = quoteTranscription("groq", POTETO_SECONDS);
        const turbo = quotesFor(POTETO_SECONDS).find((row) => row.model === "whisper-large-v3-turbo");
        const medical = quotesFor(POTETO_SECONDS).find((row) => row.model === "nova-3-medical");

        expect(xai.usd).toBeCloseTo((POTETO_SECONDS / 3600) * 0.1, 10);
        expect(deepgram.usd).toBeGreaterThan(xai.usd ?? 0);
        expect(openai.usd).toBeGreaterThan(deepgram.usd ?? 0);
        expect(groq.model).toBe("whisper-large-v3");
        expect(turbo?.usd ?? 0).toBeLessThan(xai.usd ?? 0);
        expect(medical?.usd ?? 0).toBeGreaterThan(deepgram.usd ?? 0);
    });

    it("treats local transcription as free and an unknown provider as unpriced", () => {
        expect(quoteTranscription("local-hf", POTETO_SECONDS).usd).toBe(0);
        expect(quoteTranscription("openrouter", POTETO_SECONDS).usd).toBeNull();
        expect(quoteTranscription("gladia", POTETO_SECONDS).usd).toBeNull();
    });

    it("prices a Deepgram domain model at its parent rate", () => {
        const finance = quotesFor(3600, { provider: "deepgram", model: "nova-2-finance" }).find(
            (row) => row.model === "nova-2-finance"
        );

        expect(finance?.usdPerHour).toBeCloseTo(7.167e-5 * 3600, 6);
        expect(finance?.note).toBe("same list price as nova-2");
    });
});
