import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { composeImageGrid } from "@genesiscz/utils/image/grid";
import { decodeImageRgba } from "@genesiscz/utils/image/raster";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { FrameDifferenceGuard, frameDifferenceSummary } from "./difference-guard";
import { probeVideo, readVideoFrameTimes } from "./probe";
import { runVideoCommand } from "./process";
import { locateVideoSamples, planVideoSamples } from "./sampling";
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
    progress?.({ phase: "probing", completed: 0, total: 1 });
    const source = await probeVideo({ input, signal });
    const before = await stat(source.path);
    const sha256 = await videoDigest(source.path);
    const plan = planVideoSamples({ durationUs: source.durationUs, ...settings });
    const sourceUs = await readVideoFrameTimes({ input: source.path, signal });
    const samples = locateVideoSamples({ requestedUs: plan.timestampsUs, sourceUs });
    const indices = [...new Set(samples.map((sample) => sample.sourceIndex))];
    if (indices.length * source.displayWidth * source.displayHeight * 4 > 1024 * 1024 * 1024) {
        throw new Error("Full-resolution frames exceed the 1 GiB preparation budget; select a lower FPS");
    }

    const id = randomUUID();
    const root = resolve(outputRoot);
    const staging = join(root, `.preparing-${id}`);
    const destination = join(root, id);
    await mkdir(staging, { recursive: true });
    let published = false;
    try {
        progress?.({ phase: "extracting", completed: 0, total: samples.length });
        const expression = indices.map((index) => `eq(n,${index})`).join("+");
        await runVideoCommand({
            command: [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-i",
                source.path,
                "-map",
                "0:v:0",
                "-an",
                "-vf",
                `select='${expression}',format=rgba`,
                "-fps_mode",
                "vfr",
                "-start_number",
                "0",
                "-threads",
                "2",
                join(staging, "source-%05d.png"),
            ],
            signal,
        });
        const paths = new Map(
            indices.map((index, position) => [index, `source-${String(position).padStart(5, "0")}.png`])
        );
        const guard = new FrameDifferenceGuard({ minimumDifferencePct: settings.minimumDifferencePct });
        const frames: VideoFrame[] = [];
        for (const [index, sample] of samples.entries()) {
            signal?.throwIfAborted();
            const name = paths.get(sample.sourceIndex);
            if (!name || !(await Bun.file(join(staging, name)).exists())) {
                throw new Error("Decoder did not produce every selected source frame");
            }

            const image = await decodeImageRgba(join(staging, name));
            if (image.width !== source.displayWidth || image.height !== source.displayHeight) {
                throw new Error("Decoded dimensions do not match normalized video rotation");
            }

            const decision = guard.consider({ id: String(index), image });
            frames.push({ ...sample, ...decision, path: join(destination, name) });
            progress?.({ phase: "comparing", completed: index + 1, total: samples.length });
        }

        const kept = frames.filter((frame) => frame.kept);
        const sheets: VideoManifest["sheets"] = [];
        for (let offset = 0; offset < kept.length; offset += settings.framesPerImage) {
            signal?.throwIfAborted();
            const group = kept.slice(offset, offset + settings.framesPerImage);
            const name = `sheet-${String(sheets.length + 1).padStart(3, "0")}.png`;
            const grid = await composeImageGrid({
                images: group.map((frame) => ({
                    path: join(staging, paths.get(frame.sourceIndex)!),
                    label: `${(frame.actualUs / 1_000_000).toFixed(3)} s · sample ${Number(frame.id) + 1}`,
                })),
                output: join(staging, name),
                signal,
            });
            sheets.push({
                path: join(destination, name),
                frameIds: group.map((frame) => frame.id),
                firstUs: group[0].actualUs,
                lastUs: group[group.length - 1].actualUs,
                ...grid,
            });
            progress?.({
                phase: "composing",
                completed: Math.min(offset + settings.framesPerImage, kept.length),
                total: kept.length,
            });
        }

        const after = await stat(source.path);
        if (
            after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs ||
            (await videoDigest(source.path)) !== sha256
        ) {
            throw new Error("Source video changed during preparation; import it again");
        }

        const manifest: VideoManifest = {
            version: 1,
            id,
            source: { ...source, sha256 },
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
