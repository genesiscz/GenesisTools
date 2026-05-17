import { describe, expect, it } from "bun:test";
import { DIARIZE_MODEL_DIR, EMBEDDING_MODEL, SEGMENTATION_MODEL } from "./diarize-models";

describe("diarize-models config", () => {
    it("points at the ungated GitHub-release assets", () => {
        expect(SEGMENTATION_MODEL.url).toBe(
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
        );
        expect(EMBEDDING_MODEL.url).toBe(
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"
        );
        expect(DIARIZE_MODEL_DIR).toMatch(/[\\/]\.genesis-tools[\\/]transcribe[\\/]models[\\/]diarization/);
    });
});
