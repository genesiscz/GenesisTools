import { existsSync } from "node:fs";
import { logger } from "@app/logger";
import { convertAudioFormat as convertAudioFormatUtil } from "@app/utils/audio/converter";
import { getAudioInfo, validateAudioFile } from "@app/utils/audio/probe";
import { CHUNK_SIZE, splitAudioBySize, splitAudioFile } from "@app/utils/audio/split";
import { spawn } from "bun";

export type FFProbeResult = {
    format: {
        format_name?: string;
    };
    streams?: Array<{
        codec_type: string;
        codec_name?: string;
        width?: number;
        height?: number;
        channels?: number;
    }>;
};

export class AudioProcessor {
    async validateAudioFile(filePath: string): ReturnType<typeof validateAudioFile> {
        return validateAudioFile(filePath);
    }

    async convertAudioFormat(inputPath: string, outputPath: string, targetFormat: string = "mp3"): Promise<string> {
        return convertAudioFormatUtil(inputPath, outputPath, targetFormat);
    }

    async splitAudioFile(inputPath: string, outputDir: string, chunkDurationSeconds: number = 300): Promise<string[]> {
        return splitAudioFile(inputPath, outputDir, chunkDurationSeconds);
    }

    async splitAudioBySize(
        inputPath: string,
        outputDir: string,
        maxChunkSizeBytes: number = CHUNK_SIZE
    ): Promise<string[]> {
        return splitAudioBySize(inputPath, outputDir, maxChunkSizeBytes);
    }

    async getAudioInfo(filePath: string): ReturnType<typeof getAudioInfo> {
        return getAudioInfo(filePath);
    }

    async optimizeForTranscription(inputPath: string, outputPath: string): Promise<string> {
        try {
            logger.info("Optimizing audio for transcription...");

            // Optimize for speech recognition:
            // - Mono audio
            // - 16kHz sample rate (good for speech)
            // - Moderate bitrate for quality
            const proc = spawn(
                [
                    "ffmpeg",
                    "-i",
                    inputPath,
                    "-ac",
                    "1", // Mono
                    "-ar",
                    "16000", // 16kHz sample rate
                    "-ab",
                    "64k", // 64k bitrate
                    "-f",
                    "mp3",
                    "-y",
                    outputPath,
                ],
                {
                    stdio: ["ignore", "pipe", "pipe"],
                }
            );

            const _stdout = await new Response(proc.stdout).text();
            const stderr = await new Response(proc.stderr).text();
            const exitCode = await proc.exited;

            if (exitCode !== 0) {
                throw new Error(`Audio optimization failed: ${stderr}`);
            }

            logger.info(`Audio optimization completed: ${outputPath}`);
            return outputPath;
        } catch (error) {
            logger.error(`Audio optimization failed: ${error}`);
            throw error;
        }
    }

    async cleanupTempFiles(files: string[]): Promise<void> {
        for (const file of files) {
            try {
                if (existsSync(file)) {
                    const { unlink } = await import("node:fs/promises");
                    await unlink(file);
                    logger.debug(`Cleaned up temporary file: ${file}`);
                }
            } catch (error) {
                logger.warn(`Failed to clean up temporary file ${file}: ${error}`);
            }
        }
    }

    isFFmpegAvailable(): boolean {
        try {
            // Try to run ffmpeg to check if it's available
            const _proc = spawn(["ffmpeg", "-version"], {
                stdio: ["ignore", "ignore", "ignore"],
            });

            // Don't wait for it to complete, just check if it can start
            return true;
        } catch {
            return false;
        }
    }

    async getFFmpegInfo(): Promise<{
        available: boolean;
        version?: string;
        supportedFormats: string[];
    }> {
        const available = this.isFFmpegAvailable();

        if (!available) {
            return {
                available: false,
                supportedFormats: [],
            };
        }

        try {
            const proc = spawn(["ffmpeg", "-formats"], {
                stdio: ["ignore", "pipe", "pipe"],
            });

            const stdout = await new Response(proc.stdout).text();
            const exitCode = await proc.exited;

            if (exitCode !== 0) {
                return {
                    available: true,
                    supportedFormats: ["mp3", "wav", "m4a", "aac", "ogg", "flac"], // Common formats
                };
            }

            // Parse formats from ffmpeg output
            const formats = stdout
                .split("\n")
                .filter((line) => line.includes("E audio"))
                .map((line) => {
                    const match = line.match(/\s+(\w+)\s+/);
                    return match ? match[1] : null;
                })
                .filter(Boolean) as string[];

            return {
                available: true,
                supportedFormats: formats,
            };
        } catch (error) {
            logger.warn(`Failed to get FFmpeg info: ${error}`);
            return {
                available: true,
                supportedFormats: ["mp3", "wav", "m4a", "aac", "ogg", "flac"],
            };
        }
    }
}

// Singleton instance
export const audioProcessor = new AudioProcessor();
