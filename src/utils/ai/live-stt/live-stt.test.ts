import { describe, expect, test } from "bun:test";
import { createLiveSttProvider } from "./providers";
import { DEFAULT_WAKE_PHRASES, matchWake, normalizeUtterance, parseWakePhrases } from "./wake-word";

describe("wake word", () => {
    test("matches a leading phrase and returns the remainder", () => {
        const hit = matchWake("Hey Genesis, open Atlas", DEFAULT_WAKE_PHRASES);
        expect(hit).toEqual({ matched: "hey genesis", remainder: "open atlas" });
    });

    test("does not match genesis inside genesiscz", () => {
        expect(matchWake("clone genesiscz/GenesisTools", DEFAULT_WAKE_PHRASES)).toBeNull();
    });

    test("matches a whole-utterance wake", () => {
        expect(matchWake("genesis", DEFAULT_WAKE_PHRASES)).toEqual({ matched: "genesis", remainder: "" });
    });

    test("prefers the longest phrase", () => {
        const hit = matchWake("ok genesis click back", parseWakePhrases("genesis,ok genesis"));
        expect(hit?.matched).toBe("ok genesis");
        expect(hit?.remainder).toBe("click back");
    });

    test("normalize strips punctuation", () => {
        expect(normalizeUtterance("  OK, GENESIS!! ")).toBe("ok genesis");
    });
});

describe("live STT providers", () => {
    test("mock yields injected events then ends", async () => {
        const provider = createLiveSttProvider("mock", [
            { type: "partial", text: "hey gene", tMs: 10, provider: "mock" },
            { type: "final", text: "hey genesis back", tMs: 40, provider: "mock" },
        ]);
        const session = await provider.connect({ sampleRate: 16000 });
        const seen = [];
        for await (const event of session.events()) {
            seen.push(event.type);
        }
        expect(seen).toEqual(["partial", "final"]);
        await session.close();
    });

    test("unconfigured network providers refuse instead of dialing", async () => {
        const provider = createLiveSttProvider("deepgram");
        await expect(provider.connect({ sampleRate: 16000 })).rejects.toThrow("not connected");
    });
});
