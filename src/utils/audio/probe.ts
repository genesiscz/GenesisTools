import { existsSync } from "node:fs";
import logger from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { spawn } from "bun";

export interface AudioInfo {
    format: string;
    duration: number;
    bitrate?: number;
    sampleRate?: number;
    channels?: number;
}

export interface AudioValidation {
    isValid: boolean;
    format?: string;
    duration?: number;
    size?: number;
    error?: string;
}

/** Probe an audio file with ffprobe. Returns safe defaults if ffprobe fails
 *  (never throws) so callers can degrade gracefully. */
export async function getAudioInfo(filePath: string): Promise<AudioInfo> {
    try {
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

        const probeData = SafeJSON.parse(stdout) as {
            streams?: FFprobeStream[];
            format?: { duration?: string; size?: string; bit_rate?: string };
        };

        const audioStream = probeData.streams?.find((stream) => stream.codec_type === "audio");

        if (!audioStream) {
            throw new Error("No audio stream found in file");
        }

        return {
            format: audioStream.codec_name || "unknown",
            duration: parseFloat(String(audioStream.duration || probeData.format?.duration || "0")),
            bitrate: audioStream.bit_rate ? parseInt(String(audioStream.bit_rate), 10) : undefined,
            sampleRate: audioStream.sample_rate ? parseInt(String(audioStream.sample_rate), 10) : undefined,
            channels: audioStream.channels ? parseInt(String(audioStream.channels), 10) : undefined,
        };
    } catch (error) {
        logger.warn(`Failed to get audio info for ${filePath}: ${error}`);

        return {
            format: "unknown",
            duration: 0,
        };
    }
}

/** Validate an audio file exists and is probeable; returns size + basic info. */
export async function validateAudioFile(filePath: string): Promise<AudioValidation> {
    try {
        if (!existsSync(filePath)) {
            return { isValid: false, error: "File not found" };
        }

        const file = Bun.file(filePath);
        const size = file.size;
        const audioInfo = await getAudioInfo(filePath);

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
