import { describe, expect, it } from "bun:test";
import { DIARIZE_ARTIFACTS, DIARIZE_MODEL_DIR, EMBEDDING_MODEL, SEGMENTATION_MODEL } from "./models";

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

    it("describes both weights as url artifacts, the tarball unpacking into the model dir", () => {
        expect(DIARIZE_ARTIFACTS).toEqual([
            { source: "url", locator: EMBEDDING_MODEL.url, file: EMBEDDING_MODEL.file },
            {
                source: "url",
                locator: SEGMENTATION_MODEL.url,
                file: SEGMENTATION_MODEL.file,
                archive: "tar.bz2",
                archiveRoot: DIARIZE_MODEL_DIR,
            },
        ]);
    });

    it("keeps the target files where the sherpa runtime has always looked for them", () => {
        expect(SEGMENTATION_MODEL.file).toBe(`${DIARIZE_MODEL_DIR}/sherpa-onnx-pyannote-segmentation-3-0/model.onnx`);
        expect(EMBEDDING_MODEL.file).toBe(
            `${DIARIZE_MODEL_DIR}/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx`
        );
    });
});
