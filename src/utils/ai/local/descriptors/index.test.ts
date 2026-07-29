import { describe, expect, test } from "bun:test";
import { byTask, findDescriptor, LOCAL_MODELS } from "./index";
import { EMBED_MODELS, SUMMARIZE_MODELS, TRANSCRIBE_MODELS, TRANSLATE_MODELS, TTS_MODELS } from "./models";

describe("LOCAL_MODELS", () => {
    test("carries every catalogue entry exactly once", () => {
        const sourceCount =
            EMBED_MODELS.length +
            TRANSCRIBE_MODELS.length +
            TRANSLATE_MODELS.length +
            SUMMARIZE_MODELS.length +
            TTS_MODELS.length;

        expect(LOCAL_MODELS.length).toBe(sourceCount);
        expect(new Set(LOCAL_MODELS.map((m) => m.id)).size).toBe(sourceCount);
    });

    test("preserves each entry's registry fields verbatim", () => {
        for (const entry of EMBED_MODELS) {
            const descriptor = findDescriptor(entry.id);
            expect(descriptor).toBeDefined();

            for (const [key, value] of Object.entries(entry)) {
                expect(descriptor?.[key as keyof typeof entry]).toEqual(value);
            }
        }
    });

    test("derives the runtime from the provider", () => {
        expect(findDescriptor("Xenova/multilingual-e5-small")?.runtime).toBe("transformers-js");
        expect(findDescriptor("onnx-community/whisper-tiny")?.runtime).toBe("transformers-js");
        expect(findDescriptor("coreml-contextual")?.runtime).toBe("coreml");
        expect(findDescriptor("darwinkit")?.runtime).toBe("darwinkit");
        expect(findDescriptor("nomic-embed-text")?.runtime).toBe("ollama");
    });

    test("hosted models have no runtime and no artifacts to fetch", () => {
        for (const id of ["text-embedding-3-small", "text-embedding-3-large", "gemini-embedding-001", "whisper-1"]) {
            const descriptor = findDescriptor(id);
            expect(descriptor?.runtime).toBeUndefined();
            expect(descriptor?.artifacts).toEqual([]);
        }
    });

    test("transformers.js models carry one hf artifact keyed by their repo id", () => {
        for (const descriptor of LOCAL_MODELS) {
            if (descriptor.provider !== "local-hf") {
                continue;
            }

            expect(descriptor.artifacts).toEqual([{ source: "hf", locator: descriptor.id }]);
        }
    });

    test("ollama, coreml and darwinkit models have no artifacts of ours", () => {
        for (const descriptor of LOCAL_MODELS) {
            if (descriptor.provider === "local-hf") {
                continue;
            }

            expect(descriptor.artifacts).toEqual([]);
        }
    });

    test("TTS entries are tagged orphaned but stay queryable", () => {
        const tts = byTask("tts" as never);
        expect(tts.map((m) => m.id)).toEqual(TTS_MODELS.map((m) => m.id));

        for (const descriptor of tts) {
            expect(descriptor.meta).toEqual({ orphaned: true });
        }

        for (const descriptor of LOCAL_MODELS) {
            if (descriptor.task === "tts") {
                continue;
            }

            expect(descriptor.meta).toBeUndefined();
        }
    });
});
