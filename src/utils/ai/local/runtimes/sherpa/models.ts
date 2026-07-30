import { join } from "node:path";
import { ArtifactStore } from "../../artifacts";
import type { ArtifactRef } from "../../descriptors/types";
import { DIARIZE_MODEL_DIR } from "./paths";

export { DIARIZE_MODEL_DIR } from "./paths";

export const SEGMENTATION_MODEL = {
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
    file: join(DIARIZE_MODEL_DIR, "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx"),
};

// CAM++ multilingual (zh+en) speaker embedding. The previous model
// (wespeaker_en_voxceleb_resnet34_LM) is an older architecture trained only
// on English-celebrity VoxCeleb and scored ≈chance discriminating Czech
// speakers regardless of input format (verified: .mp3/.wav/.mp4 all ~0.5).
// Speaker embeddings encode voice timbre (largely language-independent), so a
// modern multilingual CAM++ model transfers to Czech far better.
export const EMBEDDING_MODEL = {
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
    file: join(DIARIZE_MODEL_DIR, "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"),
};

/**
 * The two weight files diarization needs, as artifact refs. Ungated k2-fsa
 * GitHub release assets — no auth, and upstream publishes no checksums, so no
 * `sha256` here; the store verifies one the moment a ref carries it.
 *
 * The segmentation asset is a tarball whose top-level folder is
 * `sherpa-onnx-pyannote-segmentation-3-0/`, so it unpacks into the model dir
 * and yields `SEGMENTATION_MODEL.file`.
 */
export const DIARIZE_ARTIFACTS: ArtifactRef[] = [
    { source: "url", locator: EMBEDDING_MODEL.url, file: EMBEDDING_MODEL.file },
    {
        source: "url",
        locator: SEGMENTATION_MODEL.url,
        file: SEGMENTATION_MODEL.file,
        archive: "tar.bz2",
        archiveRoot: DIARIZE_MODEL_DIR,
    },
];

let inFlight: Promise<{ segmentation: string; embedding: string }> | undefined;

async function provisionModels(store: ArtifactStore): Promise<{ segmentation: string; embedding: string }> {
    const resolved = await store.ensure(DIARIZE_ARTIFACTS);
    const embedding = resolved.find((r) => r.ref.locator === EMBEDDING_MODEL.url)?.path;
    const segmentation = resolved.find((r) => r.ref.locator === SEGMENTATION_MODEL.url)?.path;

    if (!embedding || !segmentation) {
        throw new Error("Diarization artifacts did not resolve to both model files");
    }

    return { segmentation, embedding };
}

/** Ensure both ONNX models exist locally; download (+extract) on first use.
 *  Assets are ungated k2-fsa/sherpa-onnx GitHub releases — no auth needed.
 *  Concurrent callers share one in-flight provisioning so two diarize calls
 *  can't race on the same download/extract targets; a failed attempt clears
 *  the cache so the next call retries instead of being permanently bricked. */
export function ensureDiarizationModels(store?: ArtifactStore): Promise<{ segmentation: string; embedding: string }> {
    if (!inFlight) {
        inFlight = provisionModels(store ?? ArtifactStore.default()).catch((err) => {
            inFlight = undefined;
            throw err;
        });
    }

    return inFlight;
}

/** Test seam: the in-flight cache is module-global and outlives one test. */
export function _resetDiarizationProvisioningForTest(): void {
    inFlight = undefined;
}
