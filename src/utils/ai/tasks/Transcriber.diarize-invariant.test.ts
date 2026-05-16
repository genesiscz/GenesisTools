import { describe, expect, it, mock } from "bun:test";
import type { AITranscriptionProvider, TranscriptionResult } from "@app/utils/ai/types";

// The designed-out invariant: local diarization is ALWAYS handed the full
// original audio buffer, never a per-chunk slice — so speaker labels share
// one global space and cross-chunk remapping is structurally impossible.
// If a future change diarizes chunk-wise (or removes the diarize split-
// bypass) this test fails, catching the regression early.
//
// Only the leaf `diarize-local` module is mocked (nothing else imports it,
// so the global mock cannot leak into other suites); the Transcriber is
// constructed directly via its (runtime-accessible) constructor so AIConfig
// and the provider registry are NOT mocked.

const seenLengths: number[] = [];

mock.module("@app/utils/audio/diarize-local", () => ({
    diarizeLocal: async (buf: Buffer) => {
        seenLengths.push(buf.length);
        return [{ start: 0, end: 1, speaker: "0" }];
    },
}));

const { Transcriber } = await import("@app/utils/ai/tasks/Transcriber");

type TranscriberCtor = new (provider: AITranscriptionProvider) => {
    transcribe(audio: Buffer, options?: { diarize?: boolean; clean?: boolean }): Promise<TranscriptionResult>;
};

const fakeProvider: AITranscriptionProvider = {
    type: "deepgram",
    isAvailable: async () => true,
    supports: () => true,
    transcribe: async () => ({ text: "a", segments: [{ text: "a", start: 0, end: 1 }] }),
    dispose: () => {},
};

describe("designed-out: diarization runs on the un-split source", () => {
    it("diarizeLocal receives the full original audio buffer, never a chunk", async () => {
        // > MAX_CLOUD_BYTES (24 MiB) with a cloud provider: without the
        // diarize split-bypass this would be chunked and diarizeLocal would
        // see chunk-sized buffers instead of the whole file.
        const big = Buffer.alloc(25 * 1024 * 1024, 1);
        const t = new (Transcriber as unknown as TranscriberCtor)(fakeProvider);
        await t.transcribe(big, { diarize: true, clean: false });
        expect(seenLengths).toEqual([big.length]);
    });
});
