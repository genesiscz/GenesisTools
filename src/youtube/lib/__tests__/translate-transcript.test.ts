import { beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import type { TranscriptSegment } from "@app/youtube/lib/transcript.types";
import { chunkSegmentsForTranslation, translateTranscript } from "@app/youtube/lib/transcripts";

const callLlmCalls: unknown[] = [];
let responses: string[] = [];

beforeEach(() => {
    callLlmCalls.length = 0;
    responses = [];
});

function stubCallLLM(opts: { systemPrompt: string; userPrompt: string; providerChoice: unknown }) {
    callLlmCalls.push(opts);

    return Promise.resolve({ content: responses.shift() ?? "" });
}

async function makeFixture() {
    const dir = await mkdtemp(join(tmpdir(), "youtube-translate-"));
    const db = new YoutubeDatabase(":memory:");
    db.upsertChannel({ handle: "@mkbhd" });
    db.upsertVideo({ id: "abc123def45", channelHandle: "@mkbhd", title: "T" });
    db.saveTranscript({
        videoId: "abc123def45",
        lang: "en",
        source: "captions",
        text: "First line. Second line.",
        segments: [
            { text: "First line.", start: 0, end: 5 },
            { text: "Second line.", start: 5, end: 10 },
        ],
        durationSec: 10,
    });

    return { db, dir };
}

const fakeChoice = { provider: { name: "fake" }, model: { id: "fake" } } as unknown as Parameters<
    typeof translateTranscript
>[0]["providerChoice"];

describe("chunkSegmentsForTranslation", () => {
    it("keeps chunks under the token budget without splitting a segment", () => {
        const segments: TranscriptSegment[] = Array.from({ length: 5 }, (_, i) => ({
            text: "word ".repeat(500), // ~625 tokens/segment at 4 chars/token
            start: i * 10,
            end: i * 10 + 10,
        }));

        const chunks = chunkSegmentsForTranslation(segments, 1000);

        expect(chunks.flat()).toHaveLength(5);
        for (const chunk of chunks) {
            expect(chunk.length).toBeGreaterThan(0);
        }
        expect(chunks.length).toBeGreaterThan(1);
    });

    it("returns a single chunk when everything fits the budget", () => {
        const segments: TranscriptSegment[] = [
            { text: "a", start: 0, end: 1 },
            { text: "b", start: 1, end: 2 },
        ];

        expect(chunkSegmentsForTranslation(segments, 3000)).toEqual([segments]);
    });
});

describe("translateTranscript", () => {
    it("reassembles translated lines onto the original segments and stores the new-lang row", async () => {
        const { db, dir } = await makeFixture();

        try {
            responses = ["[0] První řádek.\n[5] Druhý řádek."];

            const result = await translateTranscript({
                db,
                videoId: "abc123def45",
                lang: "cs",
                providerChoice: fakeChoice,
                callLLM: stubCallLLM,
            });

            expect(result.lang).toBe("cs");
            expect(result.source).toBe("ai");
            expect(result.segments).toEqual([
                { text: "První řádek.", start: 0, end: 5 },
                { text: "Druhý řádek.", start: 5, end: 10 },
            ]);
            expect(result.text).toBe("První řádek. Druhý řádek.");
            expect(callLlmCalls).toHaveLength(1);

            // Original English row is untouched.
            const original = db.getTranscript("abc123def45", { lang: "en" });
            expect(original?.text).toBe("First line. Second line.");
        } finally {
            db.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("retries once with an exact-line-count instruction on a line-count mismatch, then succeeds", async () => {
        const { db, dir } = await makeFixture();

        try {
            responses = ["[0] Only one line.", "[0] První řádek.\n[5] Druhý řádek."];

            const result = await translateTranscript({
                db,
                videoId: "abc123def45",
                lang: "cs",
                providerChoice: fakeChoice,
                callLLM: stubCallLLM,
            });

            expect(result.segments.map((s) => s.text)).toEqual(["První řádek.", "Druhý řádek."]);
            expect(callLlmCalls).toHaveLength(2);
            expect((callLlmCalls[1] as { systemPrompt: string }).systemPrompt).toContain(
                "You must return exactly 2 lines."
            );
        } finally {
            db.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("throws when the line count still mismatches after the retry", async () => {
        const { db, dir } = await makeFixture();

        try {
            responses = ["[0] Only one line.", "[0] Still only one."];

            await expect(
                translateTranscript({
                    db,
                    videoId: "abc123def45",
                    lang: "cs",
                    providerChoice: fakeChoice,
                    callLLM: stubCallLLM,
                })
            ).rejects.toThrow(/expected 2/);
            expect(callLlmCalls).toHaveLength(2);
        } finally {
            db.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("throws when there is no transcript to translate", async () => {
        const dir = await mkdtemp(join(tmpdir(), "youtube-translate-empty-"));
        const db = new YoutubeDatabase(":memory:");
        db.upsertChannel({ handle: "@mkbhd" });
        db.upsertVideo({ id: "novideo0001", channelHandle: "@mkbhd", title: "T" });

        try {
            await expect(
                translateTranscript({
                    db,
                    videoId: "novideo0001",
                    lang: "cs",
                    providerChoice: fakeChoice,
                    callLLM: stubCallLLM,
                })
            ).rejects.toThrow(/no transcript/);
        } finally {
            db.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
