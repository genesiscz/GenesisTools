import { describe, expect, test } from "bun:test";
import type { TranscriptionModelV3 } from "@ai-sdk/provider";
import type { AITask, AITranscriptionProvider, TranscribeOptions, TranscriptionResult } from "../types";
import { toTranscriptionModel } from "./transcription-adapter";

/**
 * `TranscriptionModel` (from "ai") is a version union, so `doGenerate` is only
 * reachable through the concrete spec version the adapter produces.
 */
function asV3(model: ReturnType<typeof toTranscriptionModel>): TranscriptionModelV3 {
    return model as TranscriptionModelV3;
}

function fakeProvider(seen: { options?: TranscribeOptions; bytes?: number }): AITranscriptionProvider {
    return {
        type: "local-hf",
        async isAvailable() {
            return true;
        },
        supports(task: AITask) {
            return task === "transcribe";
        },
        async transcribe(audio: Buffer, options?: TranscribeOptions): Promise<TranscriptionResult> {
            seen.options = options;
            seen.bytes = audio.length;

            return {
                text: "ahoj svete",
                segments: [{ text: "ahoj svete", start: 0.5, end: 1.25 }],
                language: "cs",
                duration: 1.25,
            };
        },
    };
}

describe("toTranscriptionModel", () => {
    test("maps our result onto the SDK's segment shape", async () => {
        const seen: { options?: TranscribeOptions; bytes?: number } = {};
        const model = asV3(
            toTranscriptionModel({
                provider: fakeProvider(seen),
                providerId: "local-hf",
                modelId: "onnx-community/whisper-large-v3-turbo",
            })
        );

        const result = await model.doGenerate({
            audio: Buffer.from("audio-bytes"),
            mediaType: "audio/wav",
        });

        expect(result.text).toBe("ahoj svete");
        expect(result.segments).toEqual([{ text: "ahoj svete", startSecond: 0.5, endSecond: 1.25 }]);
        expect(result.language).toBe("cs");
        expect(result.durationInSeconds).toBe(1.25);
        expect(seen.bytes).toBe(11);
    });

    test("reads the language/diarize hints out of its OWN providerOptions key", async () => {
        const seen: { options?: TranscribeOptions } = {};
        const model = asV3(
            toTranscriptionModel({
                provider: fakeProvider(seen),
                providerId: "local-hf",
                modelId: "whisper",
            })
        );

        await model.doGenerate({
            audio: Buffer.from("x"),
            mediaType: "audio/wav",
            providerOptions: {
                "local-hf": { language: "cs", diarize: true, speakers: 2 },
                deepgram: { language: "en" },
            },
        });

        expect(seen.options).toMatchObject({ language: "cs", diarize: true, speakers: 2, model: "whisper" });
    });

    test("accepts base64 audio, which is the SDK's other input form", async () => {
        const seen: { bytes?: number } = {};
        const model = asV3(
            toTranscriptionModel({
                provider: fakeProvider(seen),
                providerId: "local-hf",
                modelId: "whisper",
            })
        );

        await model.doGenerate({
            audio: Buffer.from("four").toString("base64"),
            mediaType: "audio/wav",
        });

        expect(seen.bytes).toBe(4);
    });
});
