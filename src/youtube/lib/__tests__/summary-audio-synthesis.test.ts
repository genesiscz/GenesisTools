import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@app/utils/env";

const synthesizeCalls: unknown[] = [];
let xaiAvailable = true;
let openaiAvailable = false;
let synthesizeResponses: Array<{ audio: Buffer; contentType: string }> = [];

mock.module("@app/utils/ai/providers", () => ({
    getTextToSpeechProvider: (type: "xai" | "openai") => {
        if (type === "xai") {
            return {
                isAvailable: async () => xaiAvailable,
                synthesize: async (text: string, options?: { voice?: string }) => {
                    synthesizeCalls.push({ provider: "xai", text, options });
                    return (
                        synthesizeResponses.shift() ?? { audio: Buffer.from("xai-audio"), contentType: "audio/mpeg" }
                    );
                },
            };
        }

        return {
            isAvailable: async () => openaiAvailable,
            synthesize: async (text: string, options?: { voice?: string }) => {
                synthesizeCalls.push({ provider: "openai", text, options });
                return synthesizeResponses.shift() ?? { audio: Buffer.from("openai-audio"), contentType: "audio/mpeg" };
            },
        };
    },
}));

const { YoutubeDatabase } = await import("@app/youtube/lib/db");
const { getOrSynthesizeSummaryAudio, NoSummaryError, NoTtsProviderError, summaryAudioDir } = await import(
    "@app/youtube/lib/summary-audio"
);

let dir: string;
let db: InstanceType<typeof YoutubeDatabase>;

beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "youtube-tts-"));
    db = new YoutubeDatabase(":memory:");
    db.upsertChannel({ handle: "@mkbhd" });
    db.upsertVideo({ id: "abc123def45", channelHandle: "@mkbhd", title: "T" });
    db.setVideoSummary("abc123def45", "long", {
        tldr: "TLDR.",
        keyPoints: ["Point one"],
        learnings: [],
        chapters: [],
        conclusion: null,
    });
    synthesizeCalls.length = 0;
    synthesizeResponses = [];
    xaiAvailable = true;
    openaiAvailable = false;
    env.testing.set("GENESIS_TOOLS_HOME", dir);
});

afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    env.testing.unset("GENESIS_TOOLS_HOME");
});

describe("getOrSynthesizeSummaryAudio", () => {
    it("synthesizes on a cache miss, then serves the cached file for free on the next call", async () => {
        const first = await getOrSynthesizeSummaryAudio({
            db,
            videoId: "abc123def45",
            mode: "long",
            userId: 1,
        });

        expect(first.cached).toBe(false);
        expect(synthesizeCalls).toHaveLength(1);
        expect(existsSync(first.path)).toBe(true);

        const second = await getOrSynthesizeSummaryAudio({
            db,
            videoId: "abc123def45",
            mode: "long",
            userId: 1,
        });

        expect(second.cached).toBe(true);
        expect(second.path).toBe(first.path);
        expect(synthesizeCalls).toHaveLength(1);
    });

    it("coalesces concurrent misses into a single synthesis", async () => {
        const [a, b] = await Promise.all([
            getOrSynthesizeSummaryAudio({ db, videoId: "abc123def45", mode: "long", userId: 1 }),
            getOrSynthesizeSummaryAudio({ db, videoId: "abc123def45", mode: "long", userId: 1 }),
        ]);

        // Only one caller synthesized; the other awaited it and came back cached.
        expect(synthesizeCalls).toHaveLength(1);
        expect([a.cached, b.cached].sort()).toEqual([false, true]);
        expect(a.path).toBe(b.path);
        expect(existsSync(a.path)).toBe(true);
    });

    it("prefers xai when available, falls back to openai otherwise", async () => {
        xaiAvailable = false;
        openaiAvailable = true;

        await getOrSynthesizeSummaryAudio({ db, videoId: "abc123def45", mode: "long", userId: 1 });

        expect((synthesizeCalls[0] as { provider: string }).provider).toBe("openai");
    });

    it("serves a cached file even when no provider is currently available", async () => {
        const first = await getOrSynthesizeSummaryAudio({ db, videoId: "abc123def45", mode: "long", userId: 1 });

        expect(first.cached).toBe(false);

        // Providers go dark, but the cached file must still serve without one.
        xaiAvailable = false;
        openaiAvailable = false;

        const second = await getOrSynthesizeSummaryAudio({ db, videoId: "abc123def45", mode: "long", userId: 1 });

        expect(second.cached).toBe(true);
        expect(second.path).toBe(first.path);
    });

    it("throws NoTtsProviderError when neither provider is available", async () => {
        xaiAvailable = false;
        openaiAvailable = false;

        await expect(
            getOrSynthesizeSummaryAudio({ db, videoId: "abc123def45", mode: "long", userId: 1 })
        ).rejects.toBeInstanceOf(NoTtsProviderError);
    });

    it("throws NoSummaryError when the video has no long summary", async () => {
        db.upsertVideo({ id: "novideo0001", channelHandle: "@mkbhd", title: "T" });

        await expect(
            getOrSynthesizeSummaryAudio({ db, videoId: "novideo0001", mode: "long", userId: 1 })
        ).rejects.toBeInstanceOf(NoSummaryError);
    });

    it("a different voice produces a new file and prunes the stale one", async () => {
        const first = await getOrSynthesizeSummaryAudio({
            db,
            videoId: "abc123def45",
            mode: "long",
            voice: "eve",
            userId: 1,
        });

        const second = await getOrSynthesizeSummaryAudio({
            db,
            videoId: "abc123def45",
            mode: "long",
            voice: "other",
            userId: 1,
        });

        expect(second.path).not.toBe(first.path);
        expect(existsSync(first.path)).toBe(false);
        expect(existsSync(second.path)).toBe(true);

        const remaining = readdirSync(summaryAudioDir()).filter((name) => name.startsWith("abc123def45-"));
        expect(remaining).toHaveLength(1);
    });
});
