import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertFileToMonoMp3, convertToWhisperWav, monoMp3Args, toFloat32Audio } from "./converter";
import { splitAudioFile } from "./split";

describe("audio converter", () => {
    test("parses a generated WAV buffer correctly", async () => {
        // Generate a synthetic 16kHz mono 16-bit WAV (1 second of silence)
        const sampleRate = 16000;
        const numSamples = sampleRate;
        const dataSize = numSamples * 2; // 16-bit = 2 bytes per sample
        const headerSize = 44;
        const wav = Buffer.alloc(headerSize + dataSize);

        // RIFF header
        wav.write("RIFF", 0);
        wav.writeUInt32LE(36 + dataSize, 4);
        wav.write("WAVE", 8);

        // fmt chunk
        wav.write("fmt ", 12);
        wav.writeUInt32LE(16, 16); // chunk size
        wav.writeUInt16LE(1, 20); // PCM
        wav.writeUInt16LE(1, 22); // mono
        wav.writeUInt32LE(sampleRate, 24);
        wav.writeUInt32LE(sampleRate * 2, 28); // byte rate
        wav.writeUInt16LE(2, 32); // block align
        wav.writeUInt16LE(16, 34); // bits per sample

        // data chunk
        wav.write("data", 36);
        wav.writeUInt32LE(dataSize, 40);

        // Write a 440 Hz sine wave
        for (let i = 0; i < numSamples; i++) {
            const sample = Math.sin((2 * Math.PI * 440 * i) / sampleRate);
            wav.writeInt16LE(Math.round(sample * 32767), headerSize + i * 2);
        }

        const float32 = await toFloat32Audio(wav);
        expect(float32).toBeInstanceOf(Float32Array);
        expect(float32.length).toBe(numSamples);

        // Check values are in [-1, 1] range
        const max = Math.max(...float32);
        const min = Math.min(...float32);
        expect(max).toBeLessThanOrEqual(1);
        expect(min).toBeGreaterThanOrEqual(-1);

        // Should have audible content (not silence)
        const rms = Math.sqrt(float32.reduce((s, v) => s + v * v, 0) / float32.length);
        expect(rms).toBeGreaterThan(0.5); // Sine wave RMS ≈ 0.707
    });

    test("handles WAV with extra chunks before data", async () => {
        // Create a WAV with a LIST chunk before the data chunk
        const sampleRate = 16000;
        const numSamples = 100;
        const dataSize = numSamples * 2;

        const listChunk = Buffer.from("LIST\x04\x00\x00\x00INFO"); // 12 bytes
        const headerSize = 44;
        const totalSize = headerSize + listChunk.length + dataSize;
        const wav = Buffer.alloc(totalSize);

        // RIFF
        wav.write("RIFF", 0);
        wav.writeUInt32LE(totalSize - 8, 4);
        wav.write("WAVE", 8);

        // fmt
        wav.write("fmt ", 12);
        wav.writeUInt32LE(16, 16);
        wav.writeUInt16LE(1, 20); // PCM
        wav.writeUInt16LE(1, 22); // mono
        wav.writeUInt32LE(sampleRate, 24);
        wav.writeUInt32LE(sampleRate * 2, 28);
        wav.writeUInt16LE(2, 32);
        wav.writeUInt16LE(16, 34);

        // LIST chunk (before data)
        listChunk.copy(wav, 36);

        // data chunk
        wav.write("data", 36 + listChunk.length);
        wav.writeUInt32LE(dataSize, 40 + listChunk.length);

        const float32 = await toFloat32Audio(wav);
        expect(float32.length).toBe(numSamples);
    });

    /**
     * The only test here that runs ffmpeg for real — it has to, since the subject is
     * whether ffmpeg's stderr gets drained. CI runners have no ffmpeg, where the spawn
     * threw ENOENT and the failure read as a hang regression rather than a missing
     * binary. Skipped rather than mocked: a mock cannot deadlock a pipe.
     */
    test.skipIf(!Bun.which("ffmpeg"))(
        "does not hang when ffmpeg writes a large amount of stderr progress output",
        async () => {
            const dir = mkdtempSync(join(tmpdir(), "audio-converter-drain-"));
            const input = join(dir, "input.wav");
            const output = join(dir, "output.mp3");

            const sampleRate = 16000;
            // 60s of audio (not 1s) so ffmpeg emits enough progress lines on stderr to
            // actually exercise the draining path — a 1s clip barely produces any.
            const numSamples = sampleRate * 60;
            const dataSize = numSamples * 2;
            const headerSize = 44;
            const wav = Buffer.alloc(headerSize + dataSize);
            wav.write("RIFF", 0);
            wav.writeUInt32LE(36 + dataSize, 4);
            wav.write("WAVE", 8);
            wav.write("fmt ", 12);
            wav.writeUInt32LE(16, 16);
            wav.writeUInt16LE(1, 20);
            wav.writeUInt16LE(1, 22);
            wav.writeUInt32LE(sampleRate, 24);
            wav.writeUInt32LE(sampleRate * 2, 28);
            wav.writeUInt16LE(2, 32);
            wav.writeUInt16LE(16, 34);
            wav.write("data", 36);
            wav.writeUInt32LE(dataSize, 40);
            writeFileSync(input, wav);

            const start = Date.now();
            await convertFileToMonoMp3(input, output);
            expect(Date.now() - start).toBeLessThan(15000);
            rmSync(dir, { recursive: true, force: true });
        }
    );

    test("convertToWhisperWav rejects garbage input", async () => {
        const garbage = Buffer.from("not a real audio file");
        let threw = false;

        try {
            await convertToWhisperWav(garbage);
        } catch (err) {
            threw = true;
            const msg = err instanceof Error ? err.message : String(err);
            expect(msg).toContain("Cannot convert audio");
        }

        expect(threw).toBe(true);
    });
});

/** The first time (seconds) a 16 kHz mono signal rises above 5 % of full scale. */
function onsetSeconds(samples: Float32Array): number {
    const index = samples.findIndex((value) => Math.abs(value) > 0.05);
    return index / 16_000;
}

function decodeMono16k(path: string): Float32Array {
    const proc = Bun.spawnSync(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], {
        env: process.env,
    });
    const bytes = proc.stdout;
    return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
}

describe("the transcription input keeps the movie clock and hears the asked tracks", () => {
    test("monoMp3Args maps one track, or mixes several as the export does", () => {
        const mixed = monoMp3Args({ input: "in.mp4", output: "out.mp3", tracks: [0, 1] }).join(" ");
        expect(mixed).toContain("[0:a:0][0:a:1]amix=inputs=2:normalize=0");

        const second = monoMp3Args({ input: "in.mp4", output: "out.mp3", tracks: [1] }).join(" ");
        expect(second).toContain("0:a:1");
        expect(second).not.toContain("0:a:0");
    });

    describe.skipIf(!Bun.which("ffmpeg"))("an audio track that starts 0.5 s after the first frame", () => {
        let dir = "";
        let movie = "";

        beforeAll(() => {
            dir = mkdtempSync(join(tmpdir(), "gt-late-audio-"));
            movie = join(dir, "late-audio.mp4");
            const made = Bun.spawnSync(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=black:s=64x64:d=2",
                    "-itsoffset",
                    "0.5",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=f=440:r=48000:d=1",
                    "-map",
                    "0:v",
                    "-map",
                    "1:a",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    movie,
                ],
                { env: process.env }
            );
            expect(made.exitCode).toBe(0);
        });

        afterAll(() => {
            rmSync(dir, { recursive: true, force: true });
        });

        test("convertFileToMonoMp3 keeps the 0.5 s of silence before the sound", async () => {
            const out = join(dir, "mono.mp3");
            await convertFileToMonoMp3(movie, out);
            expect(Math.abs(onsetSeconds(decodeMono16k(out)) - 0.5)).toBeLessThan(0.03);
        });

        test("convertToWhisperWav keeps it", async () => {
            const samples = await toFloat32Audio(await convertToWhisperWav(movie));
            expect(Math.abs(onsetSeconds(samples) - 0.5)).toBeLessThan(0.03);
        });

        test("splitAudioFile keeps it in the first chunk", async () => {
            const chunks = await splitAudioFile(movie, join(dir, "chunks"), 300);
            expect(Math.abs(onsetSeconds(decodeMono16k(chunks[0])) - 0.5)).toBeLessThan(0.03);
        });
    });
});
