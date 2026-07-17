import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YoutubeConfig } from "@app/youtube/lib/config";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { TranscriptService } from "@app/youtube/lib/transcripts";
import type { TranscriptServiceDeps } from "@app/youtube/lib/transcripts.types";

let dir: string;
let db: YoutubeDatabase;
let config: YoutubeConfig;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yt-transcript-fallback-"));
    db = new YoutubeDatabase(":memory:");
    config = new YoutubeConfig({ baseDir: dir });
    db.upsertChannel({ handle: "@chan" });
    db.upsertVideo({ id: "vid00000001", channelHandle: "@chan", title: "Video one" });
});

afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
});

function fakeDeps(opts: { captions: boolean }): TranscriptServiceDeps {
    return {
        fetchCaptions: async () =>
            opts.captions
                ? { text: "from captions", segments: [{ text: "from captions", start: 0, end: 1 }], lang: "en" }
                : null,
        downloadAudio: async (input) => {
            await Bun.write(input.outPath, "riff");

            return { path: input.outPath, sizeBytes: 4, durationSec: null };
        },
        createTranscriber: async () => ({
            transcribe: async () => ({
                text: "from asr",
                segments: [{ text: "from asr", start: 0, end: 1 }],
                language: "en",
                duration: 1,
            }),
            dispose: () => {},
        }),
    };
}

describe("transcript fallback chain", () => {
    it("captions available → free tier, hook not called", async () => {
        let gated = 0;
        const service = new TranscriptService(db, config, fakeDeps({ captions: true }));
        const transcript = await service.transcribe({
            videoId: "vid00000001",
            beforeAiTranscription: () => {
                gated += 1;
            },
        });

        expect(transcript.source).toBe("captions");
        expect(gated).toBe(0);
    });

    it("no captions → hook awaited once, then AI transcript", async () => {
        let gated = 0;
        const service = new TranscriptService(db, config, fakeDeps({ captions: false }));
        const transcript = await service.transcribe({
            videoId: "vid00000001",
            beforeAiTranscription: () => {
                gated += 1;
            },
        });

        expect(gated).toBe(1);
        expect(transcript.source).toBe("ai");
        expect(transcript.text).toBe("from asr");
    });

    it("hook rejection aborts before ASR and saves nothing", async () => {
        const service = new TranscriptService(db, config, fakeDeps({ captions: false }));

        await expect(
            service.transcribe({
                videoId: "vid00000001",
                beforeAiTranscription: () => {
                    throw new Error("Insufficient credits: have 0, need 10");
                },
            })
        ).rejects.toThrow("Insufficient credits");
        expect(db.getTranscript("vid00000001")).toBeNull();
    });

    it("forceTranscribe also passes through the gate", async () => {
        let gated = 0;
        const service = new TranscriptService(db, config, fakeDeps({ captions: true }));
        const transcript = await service.transcribe({
            videoId: "vid00000001",
            forceTranscribe: true,
            beforeAiTranscription: () => {
                gated += 1;
            },
        });

        expect(gated).toBe(1);
        expect(transcript.source).toBe("ai");
    });
});
