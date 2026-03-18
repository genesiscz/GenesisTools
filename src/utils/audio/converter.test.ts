import { describe, expect, test } from "bun:test";
import { convertToWhisperWav, toFloat32Audio } from "./converter";

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
