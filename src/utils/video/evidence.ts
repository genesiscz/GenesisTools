import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { ProgressEvent } from "@genesiscz/utils/jobs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { RecordingEditor } from "@genesiscz/utils/recording-editor/editor";
import { frameDifferenceSummary } from "./difference-guard";
import {
    type VideoFrame,
    type VideoManifest,
    type VideoProgress,
    type VideoSettings,
    videoSettingsSchema,
} from "./types";

export async function videoDigest(input: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(input)) {
        hash.update(chunk);
    }

    return hash.digest("hex");
}

export { frameSelectExpression } from "@genesiscz/utils/recording-editor/editor";

const PHASES = new Set<VideoProgress["phase"]>(["probing", "extracting", "comparing", "composing"]);

/** The editor's progress in the frame review's phases; the editor's own step boundaries are dropped. */
function toVideoProgress(event: ProgressEvent): VideoProgress | undefined {
    const phase = event.message as VideoProgress["phase"] | undefined;

    if (event.unit === "steps" || !phase || !PHASES.has(phase)) {
        return undefined;
    }

    return { phase, completed: event.done, total: event.total };
}

/**
 * The frame review's evidence (frames at a rate, change-only by a percentage, contact sheets of N frames) as one
 * recording-editor plan in a staging folder, published by rename only when the source did not change meanwhile.
 */
export async function prepareVideoEvidence({
    input,
    outputRoot,
    settings: rawSettings,
    signal,
    progress,
}: {
    input: string;
    outputRoot: string;
    settings: VideoSettings;
    signal?: AbortSignal;
    progress?: (event: VideoProgress) => void;
}): Promise<VideoManifest> {
    signal?.throwIfAborted();
    const settings = videoSettingsSchema.parse(rawSettings);
    const path = resolve(input);
    const before = await stat(path).catch((error: unknown) => {
        logger.debug({ error, path }, "video evidence source is unreadable");
        throw new Error("Choose a local video file up to 1 GiB");
    });

    if (!before.isFile() || before.size <= 0 || before.size > 1024 * 1024 * 1024) {
        throw new Error("Choose a local video file up to 1 GiB");
    }

    const sha256 = await videoDigest(path);
    const id = randomUUID();
    const root = resolve(outputRoot);
    const staging = join(root, `.preparing-${id}`);
    const destination = join(root, id);
    await mkdir(staging, { recursive: true });
    let published = false;
    try {
        const window =
            settings.startUs !== undefined || settings.endUs !== undefined
                ? [{ kind: "range" as const, fromUs: settings.startUs, toUs: settings.endUs }]
                : [];
        const job = new RecordingEditor().run(
            {
                source: { file: path },
                steps: [
                    ...window,
                    { kind: "frames", fps: settings.fps, changeOnly: true, threshold: settings.minimumDifferencePct },
                    { kind: "grid", perImage: settings.framesPerImage, labels: "sample" },
                ],
            },
            {
                outputDir: staging,
                layout: "flat",
                receipts: false,
                signal,
                onProgress: (event) => {
                    const mapped = toVideoProgress(event);

                    if (mapped) {
                        progress?.(mapped);
                    }
                },
            }
        );
        const result = await job.done;

        if (result.source.kind !== "video") {
            throw new Error("Video evidence needs a video file");
        }

        const moved = (file: string) => join(destination, relative(staging, file));
        const frames: VideoFrame[] = result.frames.map((frame) => ({
            requestedUs: frame.requestedUs ?? frame.actualUs,
            actualUs: frame.actualUs,
            sourceIndex: frame.sourceIndex ?? 0,
            id: frame.id,
            kept: frame.kept,
            differencePct: frame.differencePct,
            comparedToId: frame.comparedToId,
            path: moved(frame.path),
        }));
        const sheets: VideoManifest["sheets"] = result.sheets.map((sheet) => ({ ...sheet, path: moved(sheet.path) }));
        const after = await stat(path);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || (await videoDigest(path)) !== sha256) {
            throw new Error("Source video changed during preparation; import it again");
        }

        const manifest: VideoManifest = {
            version: 1,
            id,
            source: { ...result.source.info, sha256 },
            settings,
            frames,
            sheets,
            counts: frameDifferenceSummary({ decisions: frames, framesPerImage: settings.framesPerImage }),
            manifestPath: join(destination, "manifest.json"),
            createdAt: new Date().toISOString(),
        };
        await Bun.write(join(staging, "manifest.json"), SafeJSON.stringify(manifest, null, 2));
        signal?.throwIfAborted();
        await rename(staging, destination);
        published = true;
        progress?.({ phase: "ready", completed: frames.length, total: frames.length });
        logger.info({ id, counts: manifest.counts, manifestPath: manifest.manifestPath }, "Video evidence prepared");
        return manifest;
    } finally {
        if (!published) {
            await rm(staging, { recursive: true, force: true });
        }
    }
}
