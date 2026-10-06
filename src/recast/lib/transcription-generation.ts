import { createHash } from "node:crypto";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertFileToMonoMp3 } from "@genesiscz/utils/audio/converter";
import { logger } from "@genesiscz/utils/logger";
import { recastAudioSelection, reviewRecastTranscript } from "./transcription";

export async function transcribeRecastSelection({
    input,
    sourceId,
    audioPath,
    startMs,
    endMs,
    model,
    language,
    signal,
}: {
    input: unknown;
    sourceId: string;
    audioPath: string;
    startMs: number;
    endMs: number;
    model?: string;
    language?: string;
    signal?: AbortSignal;
}) {
    const { source } = recastAudioSelection({ input, sourceId, startMs, endMs });
    const abortSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(600000)]);
    abortSignal.throwIfAborted();
    const info = await lstat(audioPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== source.bytes) {
        throw new Error("The recording no longer matches its saved source.");
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of Bun.file(audioPath).stream()) {
        abortSignal.throwIfAborted();
        length += chunk.byteLength;
        if (length > source.bytes) {
            throw new Error("The recording grew while being read. Import the new source first.");
        }
        chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks, length);
    if (bytes.length !== source.bytes || createHash("sha256").update(bytes).digest("hex") !== source.contentHash) {
        throw new Error("The recording bytes changed. Import the new source before transcribing it.");
    }
    const folder = await mkdtemp(join(tmpdir(), "recast-transcribe-"));
    try {
        abortSignal.throwIfAborted();
        const original = join(folder, source.assetName);
        await writeFile(original, bytes, { mode: 0o600, signal: abortSignal });
        const clip = join(folder, "selection.mp3");
        logger.debug({ sourceId, startMs, endMs, bytes: source.bytes }, "recast: preparing selected audio interval");
        await convertFileToMonoMp3(original, clip, {
            range: { startSeconds: startMs / 1000, endSeconds: endMs / 1000 },
            timeoutMs: 60000,
            signal: abortSignal,
        });
        abortSignal.throwIfAborted();
        const { ai } = await import("@genesiscz/utils/ai/tasks/facade");
        abortSignal.throwIfAborted();
        logger.debug({ model: model ?? "app default" }, "recast: transcribing selected interval");
        const result = await ai.transcribe(clip, { app: "recast", model, language, clean: false, signal: abortSignal });
        abortSignal.throwIfAborted();
        return reviewRecastTranscript({
            input,
            sourceId,
            startMs,
            endMs,
            result,
            engine: `${result.provider}/${result.model}`.slice(0, 200),
        });
    } finally {
        await rm(folder, { recursive: true, force: true }).catch((error) =>
            logger.warn({ error, folder }, "recast: audio temporary files could not be removed")
        );
    }
}
