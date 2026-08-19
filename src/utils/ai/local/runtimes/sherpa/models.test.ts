import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { env } from "@genesiscz/utils/env";
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

    /**
     * The safety property the path exists for: `ArtifactStore.prune()` deletes
     * under this dir, so a sandboxed run (the test preload sets
     * GENESIS_TOOLS_HOME to a throwaway root before any import) must resolve it
     * INSIDE the sandbox. The suffix assertion above also passed for the old
     * bare-homedir() spelling, which pointed sandboxed prunes at real weights.
     */
    it("follows GENESIS_TOOLS_HOME instead of the real home", () => {
        const sandboxHome = env.tools.getHome();

        expect(sandboxHome).not.toBe(homedir());
        expect(DIARIZE_MODEL_DIR.startsWith(sandboxHome)).toBe(true);
        // lint-rules-ignore: asserts against the REAL home on purpose — the whole point is that the sandbox is elsewhere
        expect(DIARIZE_MODEL_DIR.startsWith(`${homedir()}/.genesis-tools`)).toBe(false);
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
