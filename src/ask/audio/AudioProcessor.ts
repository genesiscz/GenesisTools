import { spawn } from "bun";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import logger from "../../logger";

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
    private readonly CHUNK_SIZE = 24 * 1024 * 1024; // 24MB chunks (under 25MB limit)

    async validateAudioFile(filePath: string): Promise<{
        isValid: boolean;
        format?: string;
        duration?: number;
        size?: number;
        error?: string;
    }> {
        try {
            if (!existsSync(filePath)) {
                return { isValid: false, error: "File not found" };
            }

            const file = Bun.file(filePath);
            const size = file.size;

            // Get basic file info using ffprobe if available
            const audioInfo = await this.getAudioInfo(filePath);

            return {
                isValid: true,
                format: audioInfo.format,
                duration: audioInfo.duration,
                size,
            };
        } catch (error) {
            return {
                isValid: false,
                error: error instanceof Error ? error.message : "Failed to validate audio file",
            };
        }
    }

    async convertAudioFormat(inputPath: string, outputPath: string, targetFormat: string = "mp3"): Promise<string> {
        try {
            // Ensure output directory exists
            const outputDir = dirname(outputPath);
            if (!existsSync(outputDir)) {
                await mkdir(outputDir, { recursive: true });
            }

            logger.info(`Converting ${inputPath} to ${targetFormat} format...`);

            // Use ffmpeg for conversion
            const proc = spawn(["ffmpeg", "-i", inputPath, "-f", targetFormat, "-y", outputPath], {
                stdio: ["ignore", "pipe", "pipe"],
            });

            const stdout = await new Response(proc.stdout).text();
            const stderr = await new Response(proc.stderr).text();
            const exitCode = await proc.exited;

            if (exitCode !== 0) {
                throw new Error(`FFmpeg conversion failed: ${stderr}`);
            }

            logger.info(`Audio conversion completed: ${outputPath}`);
            return outputPath;
        } catch (error) {
            logger.error(`Audio conversion failed: ${error}`);
            throw error;
        }
    }

    async splitAudioFile(
        inputPath: string,
        outputDir: string,
        chunkDurationSeconds: number = 300 // 5 minutes chunks
    ): Promise<string[]> {
        try {
            // Ensure output directory exists
            if (!existsSync(outputDir)) {
                await mkdir(outputDir, { recursive: true });
            }

            const audioInfo = await this.getAudioInfo(inputPath);
            if (!audioInfo.duration) {
                throw new Error("Cannot determine audio duration");
            }

            const baseName = inputPath.split("/").pop()?.split(".")[0] || "audio";
            const outputFiles: string[] = [];

            logger.info(`Splitting audio into ${Math.ceil(audioInfo.duration / chunkDurationSeconds)} chunks...`);

            // Create segments using ffmpeg
            const segmentTemplate = join(outputDir, `${baseName}_%03d.mp3`);

            const proc = spawn(
                [
                    "ffmpeg",
                    "-i",
                    inputPath,
                    "-f",
                    "segment",
                    "-segment_time",
                    chunkDurationSeconds.toString(),
                    "-c",
                    "copy",
                    "-map",
                    "0",
                    "-segment_format",
                    "mp3",
                    "-y",
                    segmentTemplate,
                ],
                {
                    stdio: ["ignore", "pipe", "pipe"],
                }
            );

            const stdout = await new Response(proc.stdout).text();
            const stderr = await new Response(proc.stderr).text();
            const exitCode = await proc.exited;

            if (exitCode !== 0) {
                throw new Error(`FFmpeg segmentation failed: ${stderr}`);
            }

            // Find all created segments
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

    async splitAudioBySize(
        inputPath: string,
        outputDir: string,
        maxChunkSizeBytes: number = this.CHUNK_SIZE
    ): Promise<string[]> {
        try {
            // Ensure output directory exists
            if (!existsSync(outputDir)) {
                await mkdir(outputDir, { recursive: true });
            }

            const audioInfo = await this.getAudioInfo(inputPath);
            const fileSize = Bun.file(inputPath).size;

            if (fileSize <= maxChunkSizeBytes) {
                return [inputPath]; // File is small enough, no splitting needed
            }

            const baseName = inputPath.split("/").pop()?.split(".")[0] || "audio";
            const outputFiles: string[] = [];

            // Estimate duration per chunk based on file size
            const bytesPerSecond = fileSize / (audioInfo.duration || 1);
            const chunkDurationSeconds = Math.floor((maxChunkSizeBytes * 0.9) / bytesPerSecond); // 90% to be safe

            logger.info(`Splitting audio by size (~${maxChunkSizeBytes / 1024 / 1024}MB chunks)...`);

            return await this.splitAudioFile(inputPath, outputDir, chunkDurationSeconds);
        } catch (error) {
            logger.error(`Audio size-based splitting failed: ${error}`);
            throw error;
        }
    }

    async getAudioInfo(filePath: string): Promise<{
        format: string;
        duration: number;
        bitrate?: number;
        sampleRate?: number;
        channels?: number;
    }> {
        try {
            // Use ffprobe to get audio information
            const proc = spawn(
                ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath],
                {
                    stdio: ["ignore", "pipe", "pipe"],
                }
            );

            const stdout = await new Response(proc.stdout).text();
            const stderr = await new Response(proc.stderr).text();
            const exitCode = await proc.exited;

            if (exitCode !== 0) {
                throw new Error(`FFprobe failed: ${stderr}`);
            }

            interface FFprobeStream {
                codec_type?: string;
                codec_name?: string;
                sample_rate?: string;
                channels?: number;
                bit_rate?: string;
                duration?: string;
            }

            const probeData = JSON.parse(stdout) as {
                streams?: FFprobeStream[];
                format?: { duration?: string; size?: string; bit_rate?: string };
            };

            // Find audio stream
            const audioStream = probeData.streams?.find((stream) => stream.codec_type === "audio");

            if (!audioStream) {
                throw new Error("No audio stream found in file");
            }

            return {
                format: audioStream.codec_name || "unknown",
                duration: parseFloat(String(audioStream.duration || probeData.format?.duration || "0")),
                bitrate: audioStream.bit_rate ? parseInt(audioStream.bit_rate) : undefined,
                sampleRate: audioStream.sample_rate ? parseInt(audioStream.sample_rate) : undefined,
                channels: audioStream.channels ? parseInt(audioStream.channels) : undefined,
            };
        } catch (error) {
            logger.warn(`Failed to get audio info for ${filePath}: ${error}`);
            // Return default values if ffprobe fails
            return {
                format: "unknown",
                duration: 0,
            };
        }
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

            const stdout = await new Response(proc.stdout).text();
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
            const proc = spawn(["ffmpeg", "-version"], {
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
