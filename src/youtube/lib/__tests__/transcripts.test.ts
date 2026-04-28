import { beforeEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { YoutubeConfig } from "@app/youtube/lib/config";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import { TranscriptService } from "@app/youtube/lib/transcripts";

let captionResult: unknown = null;
const captionCalls: unknown[] = [];
const downloadAudioCalls: unknown[] = [];
const transcriberCreateCalls: unknown[] = [];
const transcriberTranscribeCalls: unknown[] = [];
const transcriberDisposeCalls: unknown[] = [];
let transcriberResult: unknown = {
    text: "AI transcript",
    language: "en",
    duration: 10,
    segments: [{ text: "AI transcript", start: 0, end: 10 }],
};

beforeEach(() => {
    captionResult = null;
    transcriberResult = {
        text: "AI transcript",
        language: "en",
        duration: 10,
        segments: [{ text: "AI transcript", start: 0, end: 10 }],
    };
    captionCalls.length = 0;
    downloadAudioCalls.length = 0;
    transcriberCreateCalls.length = 0;
    transcriberTranscribeCalls.length = 0;
    transcriberDisposeCalls.length = 0;
});

describe("TranscriptService", () => {
    it("returns cached transcripts without fetching captions or transcribing", async () => {
        const { db, config, dir } = await makeFixture();

        try {
            db.saveTranscript({
                videoId: "abc123def45",
                lang: "en",
                source: "captions",
                text: "Cached",
                segments: [{ text: "Cached", start: 0, end: 1 }],
            });
            const service = new TranscriptService(db, config, makeDeps());

            await expect(service.transcribe({ videoId: "abc123def45" })).resolves.toMatchObject({
                text: "Cached",
                source: "captions",
            });
            expect(captionCalls).toHaveLength(0);
            expect(transcriberCreateCalls).toHaveLength(0);
        } finally {
            db.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("persists captions when available before falling back to AI", async () => {
        const { db, config, dir } = await makeFixture();

        try {
            captionResult = {
                text: "Caption text",
                lang: "cs",
                segments: [{ text: "Caption text", start: 0, end: 2 }],
            };
            await config.set("preferredLangs", ["en", "cs"]);
            const service = new TranscriptService(db, config, makeDeps());

            await expect(service.transcribe({ videoId: "abc123def45", lang: "cs" })).resolves.toMatchObject({
                text: "Caption text",
                lang: "cs",
                source: "captions",
            });
            expect(captionCalls).toEqual([{ videoId: "abc123def45", preferredLangs: ["cs", "en"] }]);
            expect(db.getTranscript("abc123def45", { lang: "cs", source: "captions" })?.text).toBe("Caption text");
            expect(downloadAudioCalls).toHaveLength(0);
        } finally {
            db.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("downloads audio under the config cache dir and stores AI transcripts", async () => {
        const { db, config, dir } = await makeFixture();
        const progress: unknown[] = [];

        try {
            await config.update({ provider: { transcribe: "groq" } });
            const service = new TranscriptService(db, config, makeDeps());

            await expect(
                service.transcribe({
                    videoId: "abc123def45",
                    provider: "openai",
                    persistProvider: true,
                    onProgress: (info) => progress.push(info),
                })
            ).resolves.toMatchObject({
                text: "AI transcript",
                lang: "en",
                source: "ai",
            });
            const expectedAudioPath = join(
                dirname(config.where()),
                "cache",
                "channels",
                "mkbhd",
                "videos",
                "abc123def45",
                "audio",
                "abc123def45.wav"
            );
            expect(downloadAudioCalls[0]).toMatchObject({
                idOrUrl: "abc123def45",
                outPath: expectedAudioPath,
                format: "wav",
                sampleRate: 16000,
            });
            expect(existsSync(expectedAudioPath)).toBe(true);
            expect(db.getVideo("abc123def45")?.audioPath).toBe(expectedAudioPath);
            expect(transcriberCreateCalls).toEqual([{ provider: "openai", persist: true }]);
            expect(transcriberTranscribeCalls[0]).toMatchObject({ audioPath: expectedAudioPath });
            expect(transcriberDisposeCalls).toHaveLength(1);
            expect(progress).toEqual([
                { phase: "audio", message: "downloading audio" },
                { phase: "audio", percent: 50, message: "half" },
                { phase: "transcribe", message: "running ASR" },
            ]);
        } finally {
            db.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("uses existing audio path and force-transcribes even when captions are available", async () => {
        const { db, config, dir } = await makeFixture();
        const existingAudio = join(dir, "existing.wav");

        try {
            writeFileSync(existingAudio, "audio");
            db.setVideoBinaryPath("abc123def45", "audio", existingAudio, 5);
            captionResult = { text: "Caption text", lang: "en", segments: [] };
            const service = new TranscriptService(db, config, makeDeps());

            await expect(service.transcribe({ videoId: "abc123def45", forceTranscribe: true })).resolves.toMatchObject({
                source: "ai",
            });
            expect(captionCalls).toHaveLength(0);
            expect(downloadAudioCalls).toHaveLength(0);
            expect(transcriberTranscribeCalls[0]).toMatchObject({ audioPath: existingAudio });
        } finally {
            db.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("throws for unknown videos", async () => {
        const dir = await mkdtemp(join(tmpdir(), "youtube-transcripts-"));
        const db = new YoutubeDatabase(":memory:");
        const config = new YoutubeConfig({ baseDir: dir });
        const service = new TranscriptService(db, config);

        try {
            await expect(service.transcribe({ videoId: "missing" })).rejects.toThrow("unknown video: missing");
        } finally {
            db.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

async function makeFixture(): Promise<{ db: YoutubeDatabase; config: YoutubeConfig; dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), "youtube-transcripts-"));
    const db = new YoutubeDatabase(":memory:");
    const config = new YoutubeConfig({ baseDir: dir });
    db.upsertChannel({ handle: "@mkbhd", title: "MKBHD" });
    db.upsertVideo({ id: "abc123def45", channelHandle: "@mkbhd", title: "Video" });

    return { db, config, dir };
}

function makeDeps() {
    return {
        fetchCaptions: async (opts: { videoId: string; preferredLangs?: string[] }) => {
            captionCalls.push(opts);

            return captionResult as {
                text: string;
                segments: Array<{ text: string; start: number; end: number }>;
                lang: string;
            } | null;
        },
        downloadAudio: async (opts: {
            outPath: string;
            onProgress?: (info: { phase: "download"; percent: number; message: string }) => void;
        }) => {
            downloadAudioCalls.push(opts);
            opts.onProgress?.({ phase: "download", percent: 50, message: "half" });
            writeFileSync(opts.outPath, "audio");

            return { path: opts.outPath, sizeBytes: 5, durationSec: null };
        },
        createTranscriber: async (opts: { provider?: string; persist?: boolean }) => {
            transcriberCreateCalls.push(opts);

            return {
                transcribe: async (audioPath: string, opts: unknown) => {
                    transcriberTranscribeCalls.push({ audioPath, opts });

                    return transcriberResult as {
                        text: string;
                        language?: string;
                        duration?: number;
                        segments?: Array<{ text: string; start: number; end: number }>;
                    };
                },
                dispose: () => {
                    transcriberDisposeCalls.push(true);
                },
            };
        },
    };
}
