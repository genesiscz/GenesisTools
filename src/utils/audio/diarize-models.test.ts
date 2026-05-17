import { describe, expect, it } from "bun:test";
import { DIARIZE_MODEL_DIR, EMBEDDING_MODEL, SEGMENTATION_MODEL } from "./diarize-models";

describe("diarize-models config", () => {
    it("points at the ungated GitHub-release assets", () => {
        expect(SEGMENTATION_MODEL.url).toBe(
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
        );
        expect(EMBEDDING_MODEL.url).toBe(
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx"
        );
        expect(DIARIZE_MODEL_DIR).toContain(".genesis-tools/transcribe/models/diarization");
    });
});
