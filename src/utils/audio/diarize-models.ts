import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import logger from "@app/logger";

export const DIARIZE_MODEL_DIR = join(homedir(), ".genesis-tools", "transcribe", "models", "diarization");

export const SEGMENTATION_MODEL = {
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
    file: join(DIARIZE_MODEL_DIR, "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx"),
};

export const EMBEDDING_MODEL = {
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx",
    file: join(DIARIZE_MODEL_DIR, "wespeaker_en_voxceleb_resnet34_LM.onnx"),
};

/** Ensure both ONNX models exist locally; download (+extract) on first use.
 *  Assets are ungated k2-fsa/sherpa-onnx GitHub releases — no auth needed. */
export async function ensureDiarizationModels(): Promise<{ segmentation: string; embedding: string }> {
    await mkdir(DIARIZE_MODEL_DIR, { recursive: true });

    if (!existsSync(EMBEDDING_MODEL.file)) {
        logger.info("Downloading diarization embedding model (~25 MB)…");
        const res = await fetch(EMBEDDING_MODEL.url);

        if (!res.ok) {
            throw new Error(`Failed to download embedding model: HTTP ${res.status}`);
        }

        await Bun.write(EMBEDDING_MODEL.file, await res.arrayBuffer());
    }

    if (!existsSync(SEGMENTATION_MODEL.file)) {
        logger.info("Downloading diarization segmentation model (~6 MB)…");
        const res = await fetch(SEGMENTATION_MODEL.url);

        if (!res.ok) {
            throw new Error(`Failed to download segmentation model: HTTP ${res.status}`);
        }

        const tar = join(DIARIZE_MODEL_DIR, "seg.tar.bz2");
        await Bun.write(tar, await res.arrayBuffer());
        const proc = Bun.spawn(["tar", "xjf", tar, "-C", DIARIZE_MODEL_DIR], { stderr: "pipe" });

        if ((await proc.exited) !== 0) {
            throw new Error(`Failed to extract segmentation model: ${await new Response(proc.stderr).text()}`);
        }
    }

    return { segmentation: SEGMENTATION_MODEL.file, embedding: EMBEDDING_MODEL.file };
}
