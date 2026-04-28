import { describe, expect, test } from "bun:test";
import { Synthesizer } from "../Synthesizer";

describe("Synthesizer", () => {
    test("create({ provider: 'macos' }) resolves to macOS provider", async () => {
        const s = await Synthesizer.create({ provider: "macos" });
        expect(s.providerType).toBe("macos");
    });

    test("default create() resolves to a local provider", async () => {
        const s = await Synthesizer.create();
        // local on macOS = "macos"; on linux it would be the first available local backend (none today, would throw).
        expect(["macos"]).toContain(s.providerType);
    });

    test("speak() throws clearly when provider type is unsupported", async () => {
        await expect(Synthesizer.create({ provider: "deepgram" })).rejects.toThrow(
            /does not implement AITextToSpeechProvider|not available/i
        );
    });
});
