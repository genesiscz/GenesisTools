import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
    wordTimingFile,
    wordTimingFileSchema,
    wordTimingWindowSchema,
} from "@genesiscz/utils/meetings/word-timing-cache";
import { isStorePackageInstalled } from "@genesiscz/utils/package-store";
import { z } from "zod";

export const wordTimingModelIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/);
export const wordTimingWorkerInputSchema = z
    .object({
        audioPath: z.string().min(1),
        window: wordTimingWindowSchema,
        model: wordTimingModelIdSchema,
        language: z
            .string()
            .regex(/^[a-z]{2,3}$/)
            .optional(),
    })
    .strict();
export const wordTimingWorkerResultSchema = z.object({
    words: z.array(z.object({ text: z.string(), startSec: z.number(), endSec: z.number() })).max(512),
    pcmSha256: z.string(),
    modelFiles: z.array(wordTimingFileSchema).min(1).max(256),
});
export type WordTimingWorkerInput = z.infer<typeof wordTimingWorkerInputSchema>;
export type WordTimingWorkerResult = z.infer<typeof wordTimingWorkerResultSchema>;

/** Generation-only inspection. Ordinary transcript reads validate the saved file identities without importing ML. */
export async function cachedWordTimingModel(model: string) {
    wordTimingModelIdSchema.parse(model);
    if (!isStorePackageInstalled("@huggingface/transformers")) {
        throw new Error("The local Transformers runtime is not installed. Install it before generating word timings.");
    }
    const { HfSource } = await import("@genesiscz/utils/ai/local/artifacts/sources/hf");
    const source = new HfSource();
    const cacheRoot = await source.resolveTransformersCache();
    if (!cacheRoot) {
        throw new Error("The installed Transformers runtime has no local cache directory");
    }
    return wordTimingModelFiles(cacheRoot, model);
}

/** Inspect the exact runtime cache, never the independent Python/hub inventory. */
export function wordTimingModelFiles(cacheRoot: string, model: string) {
    wordTimingModelIdSchema.parse(model);
    const root = join(cacheRoot, model);
    if (!existsSync(root)) {
        throw new Error(`Model ${model} is not cached. Word timing generation does not download models.`);
    }
    const files: ReturnType<typeof wordTimingFile>[] = [];
    const walk = (folder: string, depth: number) => {
        if (depth > 8) {
            throw new Error("Cached model directory exceeds the inspection depth");
        }
        for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const path = join(folder, entry.name);
            if (entry.isDirectory()) {
                walk(path, depth + 1);
            } else {
                files.push(wordTimingFile(path));
                if (files.length > 256) {
                    throw new Error("Cached model has too many files for bounded word timing inspection");
                }
            }
        }
    };
    walk(root, 0);
    if (!files.length) {
        throw new Error(`Cached model ${model} is empty`);
    }
    return files;
}

/** Runs in a bounded child process, so cancellation and an ONNX crash cannot terminate the Meetings service. */
export async function runWordTimingWorker(raw: unknown): Promise<WordTimingWorkerResult> {
    const input = wordTimingWorkerInputSchema.parse(raw);
    const duration = input.window.toSec - input.window.fromSec;
    if (!(duration > 0 && duration <= 20)) {
        throw new Error("Word timing generation needs a positive window of at most 20 seconds");
    }
    const modelFiles = await cachedWordTimingModel(input.model);
    const [{ probeAudio }, { toFloat32AudioWindow }, { TransformersJsRuntime }] = await Promise.all([
        import("./audio"),
        import("@genesiscz/utils/audio/converter"),
        import("@genesiscz/utils/ai/local/runtimes/transformers-js"),
    ]);
    const probe = await probeAudio(input.audioPath);
    if (probe.durationSec <= 0 || input.window.toSec > probe.durationSec + 0.01) {
        throw new Error("The word timing window extends beyond the source audio");
    }

    const runtime = new TransformersJsRuntime({ localFilesOnly: true });
    try {
        const samples = await toFloat32AudioWindow(input.audioPath, { ...input.window, tracks: probe.tracks });
        const pcmSha256 = createHash("sha256")
            .update(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength))
            .digest("hex");
        const pipe = await runtime.getPipeline("automatic-speech-recognition", input.model);
        const result = await pipe(samples, {
            return_timestamps: "word",
            task: "transcribe",
            chunk_length_s: 29,
            stride_length_s: 0,
            condition_on_prev_tokens: false,
            num_beams: 1,
            ...(input.language ? { language: input.language } : {}),
        });
        const parsed = z
            .object({
                chunks: z
                    .array(
                        z.object({
                            text: z.string(),
                            timestamp: z.tuple([z.number().nullable(), z.number().nullable()]),
                        })
                    )
                    .max(512),
            })
            .safeParse(result);
        if (!parsed.success) {
            throw new Error("The cached model did not return word timestamps. Use a timestamp-enabled Whisper export.");
        }
        // Missing boundaries stay invalid; -1 is never accepted by the alignment policy.
        const words = parsed.data.chunks.map(({ text, timestamp }) => ({
            text,
            startSec: timestamp[0] ?? -1,
            endSec: timestamp[1] ?? -1,
        }));
        if (words.length && !words.some((word) => word.startSec >= 0 && word.endSec > word.startSec)) {
            throw new Error("The cached model returned no usable word timestamp intervals");
        }
        return { words, pcmSha256, modelFiles };
    } finally {
        runtime.dispose();
    }
}
