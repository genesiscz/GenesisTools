// ONNX Runtime 1.24.x has a CPU graph optimization bug: the loop re-runs Level3 after
// InsertCast, exposing InsertedPrecisionFreeCast nodes to SimplifiedLayerNormFusion which
// crashes on fp16 models. Workaround: lower graphOptimizationLevel to 'extended' (skips
// the buggy Level3 re-run). Ref: microsoft/onnxruntime#26631, huggingface/transformers.js#1567
// Track this set at runtime so the error-recovery path can add models dynamically.
const FP16_INCOMPATIBLE_ENCODERS = new Set(["onnx-community/whisper-large-v3-turbo"]);

/**
 * Mutable on purpose: `TransformersJsRuntime` adds a model here the first time
 * ONNX Runtime crashes on it, so the retry — and every later load in the same
 * process — starts with the lowered optimization level instead of paying for
 * the crash again. A static per-descriptor policy would delete that
 * self-healing, which is why it is not one.
 */
export function isFp16Incompatible(model: string): boolean {
    return FP16_INCOMPATIBLE_ENCODERS.has(model);
}

export function markFp16Incompatible(model: string): void {
    FP16_INCOMPATIBLE_ENCODERS.add(model);
}

/** Test seam — the set is process-global, so a second test would inherit the first's discovery. */
export function _fp16IncompatibleForTest(): ReadonlySet<string> {
    return FP16_INCOMPATIBLE_ENCODERS;
}

/**
 * Whisper ONNX dtype config per model vendor.
 * - onnx-community: uses merged decoder files (decoder_model_merged_q4.onnx)
 * - Xenova: uses separate decoder files (decoder_model_q4.onnx), no merged q4
 * - distil-whisper: only has fp32 + quantized (int8), no fp16/q4 variants
 */
export function getWhisperDtype(model: string): Record<string, string> | string {
    if (model.startsWith("onnx-community/")) {
        return { encoder_model: "fp16", decoder_model_merged: "q4" };
    }

    if (model.startsWith("distil-whisper/")) {
        // distil-whisper only has fp32 and quantized (int8) — no fp16/q4
        return { encoder_model: "q8", decoder_model_merged: "q8" };
    }

    // Xenova and others: separate encoder/decoder files
    return { encoder_model: "fp16", decoder_model: "q4" };
}
