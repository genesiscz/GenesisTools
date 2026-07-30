import { describe, expect, test } from "bun:test";
import type { SpeechModelV3 } from "@ai-sdk/provider";
import type { AITask, AITextToSpeechProvider, TTSOptions, TTSResult } from "../types";
import { toSpeechModel } from "./speech-adapter";
import { speechEngineIds } from "./speech-engines";

function fakeProvider(seen: { options?: TTSOptions; text?: string }): AITextToSpeechProvider {
    return {
        type: "macos",
        async isAvailable() {
            return true;
        },
        supports(task: AITask) {
            return task === "tts";
        },
        async synthesize(text: string, options?: TTSOptions): Promise<TTSResult> {
            seen.text = text;
            seen.options = options;
            return { audio: Buffer.from("aiff-bytes"), contentType: "audio/x-aiff" };
        },
    };
}

/** `SpeechModel` (from "ai") is a version union; `doGenerate` lives on the concrete spec. */
function asV3(model: ReturnType<typeof toSpeechModel>): SpeechModelV3 {
    return model as SpeechModelV3;
}

describe("toSpeechModel", () => {
    test("passes voice, language and a supported format through", async () => {
        const seen: { options?: TTSOptions; text?: string } = {};
        const model = asV3(toSpeechModel({ provider: fakeProvider(seen), providerId: "macos", modelId: "system" }));

        const result = await model.doGenerate({ text: "ahoj", voice: "Zuzana", language: "cs", outputFormat: "mp3" });

        expect(seen.text).toBe("ahoj");
        expect(seen.options).toEqual({ voice: "Zuzana", language: "cs", format: "mp3" });
        expect(result.audio).toBeInstanceOf(Uint8Array);
    });

    test("drops an output format our TTS options cannot express", async () => {
        const seen: { options?: TTSOptions } = {};
        const model = asV3(toSpeechModel({ provider: fakeProvider(seen), providerId: "macos", modelId: "system" }));

        await model.doGenerate({ text: "ahoj", outputFormat: "opus" });

        expect(seen.options).toEqual({});
    });
});

describe("speech engine table", () => {
    test("covers every provider the TTS paths can name", () => {
        // `summary-audio` hard-codes xai→openai, and `tools say` defaults to the
        // first local one, which is macos. A missing entry here is a provider
        // that resolves and then cannot speak.
        expect(speechEngineIds().sort()).toEqual(["macos", "openai", "xai"]);
    });
});
