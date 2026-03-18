import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Convert any audio file/buffer to 16kHz mono 16-bit PCM Float32Array
 * suitable for Whisper and other speech models.
 *
 * Conversion chain: afconvert (macOS) → ffmpeg (cross-platform) → raw WAV parse
 */
export async function toFloat32Audio(input: Buffer | string): Promise<Float32Array> {
    const audio = typeof input === "string" ? readFileSync(input) : input;

    // Already WAV? Parse directly
    if (isWav(audio)) {
        const resampled = await ensureWhisperFormat(audio);
        return parseWavToFloat32(resampled);
    }

    // Non-WAV: convert to 16kHz mono WAV first
    const wav = await convertToWhisperWav(audio);
    return parseWavToFloat32(wav);
}

/**
 * Convert any audio buffer to 16kHz mono 16-bit WAV.
 * Tries afconvert (macOS built-in, zero deps) then ffmpeg.
 */
export async function convertToWhisperWav(audio: Buffer | string): Promise<Buffer> {
    const tmpIn = join(tmpdir(), `gt-audio-in-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const tmpOut = `${tmpIn}.wav`;

    if (typeof audio === "string") {
        // Input is a file path — use it directly
        return convertFileToWhisperWav(audio, tmpOut);
    }

    await Bun.write(tmpIn, audio);

    try {
        return await convertFileToWhisperWav(tmpIn, tmpOut);
    } finally {
        cleanup(tmpIn);
    }
}

async function convertFileToWhisperWav(inputPath: string, outputPath: string): Promise<Buffer> {
    try {
        const afResult = await tryAfconvert(inputPath, outputPath);

        if (afResult) {
            return afResult;
        }

        const ffResult = await tryFfmpeg(inputPath, outputPath);

        if (ffResult) {
            return ffResult;
        }

        throw new Error(
            "Cannot convert audio. Install ffmpeg (brew install ffmpeg) or use WAV input.\n" +
                "On macOS, afconvert should work automatically for most formats."
        );
    } catch (err) {
        cleanup(outputPath);
        throw err;
    }
}

async function tryAfconvert(inputPath: string, outputPath: string): Promise<Buffer | null> {
    try {
        // LEI16@16000 = Little-Endian Integer 16-bit at 16kHz, -c 1 = mono
        const proc = Bun.spawn(["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", inputPath, outputPath], {
            stdout: "pipe",
            stderr: "pipe",
        });

        await proc.exited;

        if (proc.exitCode !== 0) {
            return null;
        }

        if (!existsSync(outputPath)) {
            return null;
        }

        const result = Buffer.from(readFileSync(outputPath));
        cleanup(outputPath);
        return result;
    } catch {
        return null;
    }
}

async function tryFfmpeg(inputPath: string, outputPath: string): Promise<Buffer | null> {
    try {
        const proc = Bun.spawn(
            [
                "ffmpeg",
                "-y",
                "-i",
                inputPath,
                "-ar",
                "16000", // 16kHz
                "-ac",
                "1", // mono
                "-acodec",
                "pcm_s16le", // 16-bit signed little-endian
                "-f",
                "wav",
                outputPath,
            ],
            { stdout: "pipe", stderr: "pipe" }
        );

        await proc.exited;

        if (proc.exitCode !== 0) {
            return null;
        }

        if (!existsSync(outputPath)) {
            return null;
        }

        const result = Buffer.from(readFileSync(outputPath));
        cleanup(outputPath);
        return result;
    } catch {
        return null;
    }
}

/**
 * If the WAV is already 16kHz/mono/16-bit, return as-is.
 * Otherwise convert it.
 */
async function ensureWhisperFormat(wav: Buffer): Promise<Buffer> {
    const sampleRate = wav.readUInt32LE(24);
    const numChannels = wav.readUInt16LE(22);
    const bitsPerSample = wav.readUInt16LE(34);

    if (sampleRate === 16000 && numChannels === 1 && bitsPerSample === 16) {
        return wav;
    }

    // Need resampling — convert via external tool
    return convertToWhisperWav(wav);
}

/**
 * Parse a 16kHz mono 16-bit WAV buffer into Float32Array [-1, 1].
 */
function parseWavToFloat32(wav: Buffer): Float32Array {
    if (!isWav(wav)) {
        throw new Error("Not a valid WAV file");
    }

    // Find the "data" chunk — it's not always at offset 44
    let offset = 12; // skip RIFF header (12 bytes)

    while (offset < wav.length - 8) {
        const chunkId = wav.toString("ascii", offset, offset + 4);
        const chunkSize = wav.readUInt32LE(offset + 4);

        if (chunkId === "data") {
            offset += 8; // skip chunk header
            const pcm = wav.subarray(offset, offset + chunkSize);
            const numChannels = wav.readUInt16LE(22);
            const bitsPerSample = wav.readUInt16LE(34);

            if (bitsPerSample === 16) {
                const bytesPerSample = 2 * numChannels;
                const sampleCount = Math.floor(pcm.length / bytesPerSample);
                const samples = new Float32Array(sampleCount);

                for (let i = 0; i < sampleCount; i++) {
                    // Take first channel, normalize Int16 to [-1, 1]
                    samples[i] = pcm.readInt16LE(i * bytesPerSample) / 32768;
                }

                return samples;
            }

            if (bitsPerSample === 32) {
                const audioFormat = wav.readUInt16LE(20);
                const sampleCount = Math.floor(pcm.length / (4 * numChannels));
                const samples = new Float32Array(sampleCount);

                if (audioFormat === 3) {
                    // IEEE Float: copy to aligned buffer to avoid RangeError on unaligned byteOffset
                    const aligned = new Uint8Array(pcm.length);
                    pcm.copy(aligned);
                    const floatView = new Float32Array(aligned.buffer);

                    for (let i = 0; i < sampleCount; i++) {
                        samples[i] = floatView[i * numChannels];
                    }
                } else {
                    // Int32 PCM: normalize to [-1, 1]
                    for (let i = 0; i < sampleCount; i++) {
                        samples[i] = pcm.readInt32LE(i * 4 * numChannels) / 2147483648;
                    }
                }

                return samples;
            }

            throw new Error(`Unsupported WAV bit depth: ${bitsPerSample}`);
        }

        // Next chunk (pad to even boundary)
        offset += 8 + chunkSize + (chunkSize % 2);
    }

    throw new Error("No 'data' chunk found in WAV file");
}

function isWav(buf: Buffer): boolean {
    return buf.length > 44 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE";
}

function cleanup(path: string): void {
    try {
        unlinkSync(path);
    } catch {
        // ignore
    }
}
