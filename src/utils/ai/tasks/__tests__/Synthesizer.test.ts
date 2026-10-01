import { describe, expect, test } from "bun:test";
import { skip } from "@genesiscz/utils/test/skip";
import { notifyFirstChunk, Synthesizer } from "../Synthesizer";

describe.skipIf(skip.unlessMac)("Synthesizer", () => {
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
            /has no speech engine|does not implement AITextToSpeechProvider|not available/i
        );
    });
});

describe("notifyFirstChunk (paid-audio signal)", () => {
    test("fires once on the first chunk, and still fired when playback fails part-way", async () => {
        let calls = 0;
        async function* audio() {
            yield new Uint8Array([1]);
            yield new Uint8Array([2]);
            throw new Error("stream broke");
        }
        const consume = async () => {
            for await (const _ of notifyFirstChunk(audio(), () => calls++)) {
                // consumed
            }
        };

        await expect(consume()).rejects.toThrow("stream broke");
        expect(calls).toBe(1);
    });

    test("never fires for a request rejected before any audio", async () => {
        let calls = 0;
        // biome-ignore lint/correctness/useYield: a stream that fails before its first chunk
        async function* rejected(): AsyncGenerator<Uint8Array> {
            throw new Error("text too long");
        }
        const consume = async () => {
            for await (const _ of notifyFirstChunk(rejected(), () => calls++)) {
                // consumed
            }
        };

        await expect(consume()).rejects.toThrow("text too long");
        expect(calls).toBe(0);
    });
});
