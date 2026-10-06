import { describe, expect, it, mock } from "bun:test";
import type { AITranscriptionProvider, TranscribeOptions, TranscriptionResult } from "@genesiscz/utils/ai/types";

// The designed-out invariant: local diarization is ALWAYS handed the full
// original audio buffer, never a per-chunk slice — so speaker labels share
// one global space and cross-chunk remapping is structurally impossible.
// If a future change diarizes chunk-wise (or removes the diarize split-
// bypass) this test fails, catching the regression early.
//
// Only the leaf sherpa `diarize` module is mocked (nothing else imports it,
// so the global mock cannot leak into other suites); the Transcriber is
// constructed directly via its (runtime-accessible) constructor so AIConfig
// and the provider registry are NOT mocked.

const seenLengths: number[] = [];

mock.module("@genesiscz/utils/ai/local/runtimes/sherpa/diarize", () => ({
    diarizeLocal: async (buf: Buffer) => {
        seenLengths.push(buf.length);
        return [{ start: 0, end: 1, speaker: "0" }];
    },
}));

const { Transcriber } = await import("@genesiscz/utils/ai/tasks/Transcriber");

type TranscriberCtor = new (
    provider: AITranscriptionProvider
) => {
    transcribe(audio: Buffer | string, options?: TranscribeOptions): Promise<TranscriptionResult>;
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

describe("transcription cancellation phases", () => {
    it("rejects before opening a file or invoking a provider", async () => {
        let calls = 0;
        const t = new (Transcriber as unknown as TranscriberCtor)({
            ...fakeProvider,
            transcribe: async () => {
                calls++;
                throw new Error("unexpected provider");
            },
        });
        await expect(
            t.transcribe("/missing-fixture-audio.wav", {
                signal: AbortSignal.abort(new Error("cancelled before file read")),
            })
        ).rejects.toThrow("cancelled before file read");
        expect(calls).toBe(0);
    });

    it("does not start local diarization after an ignored cancellation", async () => {
        const controller = new AbortController();
        const before = seenLengths.length;
        let calls = 0;
        const t = new (Transcriber as unknown as TranscriberCtor)({
            ...fakeProvider,
            transcribe: async (_audio, options) => {
                calls++;
                expect(options?.signal).toBe(controller.signal);
                controller.abort(new Error("cancelled during request"));
                return { text: "late", segments: [{ text: "late", start: 0, end: 1 }] };
            },
        });
        await expect(t.transcribe(Buffer.from("audio"), { diarize: true, signal: controller.signal })).rejects.toThrow(
            "cancelled during request"
        );
        expect(calls).toBe(1);
        expect(seenLengths.length).toBe(before);
    });
});
