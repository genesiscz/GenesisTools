import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import logger from "@app/logger";

const DOWNLOAD_TIMEOUT_MS = 30_000;

/** Fetch a model asset with a hard timeout so a hung connection fails fast
 *  (the caller degrades to transcript-without-speakers) instead of blocking
 *  the CLI forever. */
async function fetchModel(url: string): Promise<ArrayBuffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

    try {
        const res = await fetch(url, { signal: controller.signal });

        if (!res.ok) {
            throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
        }

        return await res.arrayBuffer();
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
            throw new Error(`Failed to download ${url}: timed out after ${DOWNLOAD_TIMEOUT_MS}ms`);
        }

        throw error;
    } finally {
        clearTimeout(timer);
    }
}

export const DIARIZE_MODEL_DIR = join(homedir(), ".genesis-tools", "transcribe", "models", "diarization");

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

async function provisionModels(): Promise<{ segmentation: string; embedding: string }> {
    await mkdir(DIARIZE_MODEL_DIR, { recursive: true });

    if (!existsSync(EMBEDDING_MODEL.file)) {
        logger.info("Downloading diarization embedding model (~25 MB)…");
        await Bun.write(EMBEDDING_MODEL.file, await fetchModel(EMBEDDING_MODEL.url));
    }

    if (!existsSync(SEGMENTATION_MODEL.file)) {
        logger.info("Downloading diarization segmentation model (~6 MB)…");
        const tar = join(DIARIZE_MODEL_DIR, "seg.tar.bz2");
        await Bun.write(tar, await fetchModel(SEGMENTATION_MODEL.url));
        const proc = Bun.spawn(["tar", "xjf", tar, "-C", DIARIZE_MODEL_DIR], { stderr: "pipe" });
        const extractFailed = (await proc.exited) !== 0;
        const stderr = extractFailed ? await new Response(proc.stderr).text() : "";
        await rm(tar, { force: true });

        if (extractFailed) {
            throw new Error(`Failed to extract segmentation model: ${stderr}`);
        }
    }

    return { segmentation: SEGMENTATION_MODEL.file, embedding: EMBEDDING_MODEL.file };
}

let inFlight: Promise<{ segmentation: string; embedding: string }> | undefined;

/** Ensure both ONNX models exist locally; download (+extract) on first use.
 *  Assets are ungated k2-fsa/sherpa-onnx GitHub releases — no auth needed.
 *  Concurrent callers share one in-flight provisioning so two diarize calls
 *  can't race on the same download/extract targets; a failed attempt clears
 *  the cache so the next call retries instead of being permanently bricked. */
export function ensureDiarizationModels(): Promise<{ segmentation: string; embedding: string }> {
    if (!inFlight) {
        inFlight = provisionModels().catch((err) => {
            inFlight = undefined;
            throw err;
        });
    }

    return inFlight;
}
