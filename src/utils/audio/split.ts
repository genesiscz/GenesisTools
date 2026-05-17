import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, parse } from "node:path";
import logger from "@app/logger";
import { MONO_MP3_BITRATE_KBPS } from "@app/utils/audio/converter";
import { getAudioInfo } from "@app/utils/audio/probe";
import { spawn } from "bun";

/** 24 MB chunks — under the 25 MB cloud upload limit. */
export const CHUNK_SIZE = 24 * 1024 * 1024;
const SEGMENT_BITRATE_KBPS = MONO_MP3_BITRATE_KBPS;
const SEGMENT_BYTES_PER_SEC = (SEGMENT_BITRATE_KBPS * 1000) / 8;

/** Split audio into fixed-duration MP3 segments (re-encoded mono). */
export async function splitAudioFile(
    inputPath: string,
    outputDir: string,
    chunkDurationSeconds: number = 300
): Promise<string[]> {
    try {
        if (!existsSync(outputDir)) {
            await mkdir(outputDir, { recursive: true });
        }

        const audioInfo = await getAudioInfo(inputPath);

        if (!audioInfo.duration) {
            throw new Error("Cannot determine audio duration");
        }

        const baseName = parse(inputPath).name || "audio";
        const outputFiles: string[] = [];

        logger.info(`Splitting audio into ${Math.ceil(audioInfo.duration / chunkDurationSeconds)} chunks...`);

        const segmentTemplate = join(outputDir, `${baseName}_%03d.mp3`);

        const proc = spawn(
            [
                "ffmpeg",
                "-i",
                inputPath,
                "-vn",
                "-map",
                "0:a:0",
                "-c:a",
                "libmp3lame",
                "-b:a",
                `${SEGMENT_BITRATE_KBPS}k`,
                "-f",
                "segment",
                "-segment_time",
                chunkDurationSeconds.toString(),
                "-segment_format",
                "mp3",
                "-reset_timestamps",
                "1",
                "-y",
                segmentTemplate,
            ],
            {
                stdio: ["ignore", "pipe", "pipe"],
            }
        );

        const _stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;

        if (exitCode !== 0) {
            throw new Error(`FFmpeg segmentation failed: ${stderr}`);
        }

        for (let i = 0; i < Math.ceil(audioInfo.duration / chunkDurationSeconds); i++) {
            const segmentFile = join(outputDir, `${baseName}_${i.toString().padStart(3, "0")}.mp3`);

            if (existsSync(segmentFile)) {
                outputFiles.push(segmentFile);
            }
        }

        logger.info(`Created ${outputFiles.length} audio segments`);

        return outputFiles;
    } catch (error) {
        logger.error(`Audio splitting failed: ${error}`);
        throw error;
    }
}

/** Split only if the file exceeds `maxChunkSizeBytes`; chunk duration is
 *  derived from the fixed re-encode bitrate (not the source byte rate). */
export async function splitAudioBySize(
    inputPath: string,
    outputDir: string,
    maxChunkSizeBytes: number = CHUNK_SIZE
): Promise<string[]> {
    try {
        if (!existsSync(outputDir)) {
            await mkdir(outputDir, { recursive: true });
        }

        const fileSize = Bun.file(inputPath).size;

        if (fileSize <= maxChunkSizeBytes) {
            return [inputPath];
        }

        const chunkDurationSeconds = Math.floor((maxChunkSizeBytes * 0.9) / SEGMENT_BYTES_PER_SEC);

        logger.info(`Splitting audio by size (~${maxChunkSizeBytes / 1024 / 1024}MB chunks)...`);

        return await splitAudioFile(inputPath, outputDir, chunkDurationSeconds);
    } catch (error) {
        logger.error(`Audio size-based splitting failed: ${error}`);
        throw error;
    }
}
