import { describe, expect, test } from "bun:test";
import { _fp16IncompatibleForTest, getWhisperDtype, isFp16Incompatible } from "./dtype";
import { type PipelineInstance, TransformersJsRuntime } from "./index";

function fakePipeline(): PipelineInstance {
    const pipe = (async () => ({})) as unknown as PipelineInstance;
    pipe.dispose = async () => {};
    pipe.tokenizer = {};

    return pipe;
}

interface LoadCall {
    task: string;
    model: string;
    options: Record<string, unknown>;
}

function makeRuntime(behaviour: (call: LoadCall, attempt: number) => void) {
    const calls: LoadCall[] = [];
    const runtime = new TransformersJsRuntime({
        ensureInstalled: async () => true,
        resolveDeviceFn: async () => "cpu",
        promptForToken: async () => null,
        loader: async (task, model, options) => {
            const call = { task, model, options };
            calls.push(call);
            behaviour(call, calls.length);

            return fakePipeline();
        },
    });

    return { runtime, calls };
}

describe("fp16 ONNX self-healing", () => {
    test("an InsertedPrecisionFreeCast crash marks the model and retries with extended optimization", async () => {
        const model = `test-org/fp16-crasher-${Math.random().toString(36).slice(2)}`;
        expect(isFp16Incompatible(model)).toBe(false);

        const { runtime, calls } = makeRuntime((_call, attempt) => {
            if (attempt === 1) {
                throw new Error("Non-zero status code returned ... InsertedPrecisionFreeCast ... failed");
            }
        });

        await runtime.getPipeline("feature-extraction", model);

        expect(calls.length).toBe(2);
        expect(calls[0]?.options.session_options).toBeUndefined();
        expect(calls[1]?.options.session_options).toEqual({ graphOptimizationLevel: "extended" });

        // The set is what makes this self-healing: the NEXT load of the same
        // model in this process starts lowered instead of crashing again.
        expect(isFp16Incompatible(model)).toBe(true);
    });

    test("a model already known bad starts with extended optimization, no crash needed", async () => {
        const { runtime, calls } = makeRuntime(() => {});

        await runtime.getPipeline("automatic-speech-recognition", "onnx-community/whisper-large-v3-turbo");

        expect(calls.length).toBe(1);
        expect(calls[0]?.options.session_options).toEqual({ graphOptimizationLevel: "extended" });
    });

    test("the seeded set keeps the model the workaround was discovered on", () => {
        expect(_fp16IncompatibleForTest().has("onnx-community/whisper-large-v3-turbo")).toBe(true);
    });

    test("a crash that is not the fp16 bug is rethrown untouched", async () => {
        const model = `test-org/other-failure-${Math.random().toString(36).slice(2)}`;
        const { runtime, calls } = makeRuntime(() => {
            throw new Error("something else entirely");
        });

        await expect(runtime.getPipeline("feature-extraction", model)).rejects.toThrow("something else entirely");
        expect(calls.length).toBe(1);
        expect(isFp16Incompatible(model)).toBe(false);
    });

    test("a gated model with no token available reports the token instruction", async () => {
        const { runtime } = makeRuntime(() => {
            throw new Error("Unauthorized");
        });

        await expect(runtime.getPipeline("feature-extraction", "gated/model")).rejects.toThrow(
            /requires a HuggingFace token/
        );
    });
});

describe("pipeline caching", () => {
    test("a loaded pipeline is reused and concurrent callers share one load", async () => {
        const { runtime, calls } = makeRuntime(() => {});

        const [a, b] = await Promise.all([
            runtime.getPipeline("feature-extraction", "some/model"),
            runtime.getPipeline("feature-extraction", "some/model"),
        ]);
        const c = await runtime.getPipeline("feature-extraction", "some/model");

        expect(calls.length).toBe(1);
        expect(a).toBe(b);
        expect(b).toBe(c);
    });

    test("task and model together key the cache", async () => {
        const { runtime, calls } = makeRuntime(() => {});

        await runtime.getPipeline("feature-extraction", "some/model");
        await runtime.getPipeline("summarization", "some/model");

        expect(calls.length).toBe(2);
    });

    test("dispose drops the cache so the next call reloads", async () => {
        const { runtime, calls } = makeRuntime(() => {});

        await runtime.getPipeline("feature-extraction", "some/model");
        runtime.dispose();
        await runtime.getPipeline("feature-extraction", "some/model");

        expect(calls.length).toBe(2);
    });
});

describe("dtype policy", () => {
    test("speech recognition gets the per-vendor whisper dtypes, everything else gets q4", async () => {
        const { runtime, calls } = makeRuntime(() => {});

        await runtime.getPipeline("automatic-speech-recognition", "Xenova/whisper-large-v3");
        await runtime.getPipeline("feature-extraction", "Xenova/multilingual-e5-small");

        expect(calls[0]?.options.dtype).toEqual({ encoder_model: "fp16", decoder_model: "q4" });
        expect(calls[1]?.options.dtype).toBe("q4");
    });

    test("each whisper vendor keeps its own file layout", () => {
        expect(getWhisperDtype("onnx-community/whisper-small")).toEqual({
            encoder_model: "fp16",
            decoder_model_merged: "q4",
        });
        expect(getWhisperDtype("distil-whisper/distil-large-v3")).toEqual({
            encoder_model: "q8",
            decoder_model_merged: "q8",
        });
        expect(getWhisperDtype("Xenova/whisper-large-v3")).toEqual({
            encoder_model: "fp16",
            decoder_model: "q4",
        });
    });
});
