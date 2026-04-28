import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import type { ChannelHandle, Transcript, Video, VideoId } from "@app/youtube/lib/types";
import { Command } from "commander";
import { type CaptionSegment, extractVideoId, formatTimestamp, toSRT, toVTT } from "./transcribe";

mock.module("@app/utils/cli/executor", () => ({
    isInteractive: () => false,
    suggestCommand: (toolName: string, mods: { add?: string[] } = {}) => `${toolName} ${(mods.add ?? []).join(" ")}`,
    enhanceHelp: () => undefined,
}));

const video: Video = {
    id: "dQw4w9WgXcQ" as VideoId,
    channelHandle: "@rick" as ChannelHandle,
    title: "Never Gonna Give You Up",
    description: null,
    uploadDate: "2009-10-25",
    durationSec: 213,
    viewCount: null,
    likeCount: null,
    language: "en",
    availableCaptionLangs: ["en"],
    tags: [],
    isShort: false,
    isLive: false,
    thumbUrl: null,
    summaryShort: null,
    summaryTimestamped: null,
    summaryLong: null,
    audioPath: null,
    audioSizeBytes: null,
    audioCachedAt: null,
    videoPath: null,
    videoSizeBytes: null,
    videoCachedAt: null,
    thumbPath: null,
    thumbCachedAt: null,
    createdAt: "2026-04-01",
    updatedAt: "2026-04-01",
};

const transcript: Transcript = {
    id: 1,
    videoId: "dQw4w9WgXcQ" as VideoId,
    lang: "en",
    source: "captions",
    text: "Never gonna give you up",
    segments: [
        { text: "Never gonna", start: 0, end: 1.5 },
        { text: "give you up", start: 1.5, end: 3 },
    ],
    durationSec: 3,
    createdAt: "2026-04-01",
};

const generatedTranscript: Transcript = {
    ...transcript,
    id: 2,
    source: "ai",
    text: "Generated transcript",
};

const calls = {
    ensureMetadata: [] as VideoId[],
    getTranscript: [] as unknown[],
    transcribe: [] as unknown[],
};
let cachedTranscript: Transcript | null = transcript;

mock.module("@app/youtube/commands/_shared/ensure-pipeline", () => ({
    getYoutube: async () => ({
        videos: {
            ensureMetadata: async (id: VideoId) => {
                calls.ensureMetadata.push(id);

                return video;
            },
        },
        db: {
            getTranscript: (id: VideoId, opts: unknown) => {
                calls.getTranscript.push({ id, opts });

                return cachedTranscript;
            },
        },
        transcripts: {
            transcribe: async (opts: unknown) => {
                calls.transcribe.push(opts);

                return generatedTranscript;
            },
        },
    }),
}));

async function makeProgram(): Promise<Command> {
    const { registerTranscribeCommand } = await import("@app/youtube/commands/transcribe");
    const program = new Command().exitOverride().option("--json").option("--clipboard").option("--silent");
    registerTranscribeCommand(program);

    return program;
}

describe("extractVideoId", () => {
    it("extracts from standard watch URL", () => {
        expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    });

    it("extracts from short URL", () => {
        expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    });

    it("extracts from embed URL", () => {
        expect(extractVideoId("https://youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    });

    it("extracts from shorts URL", () => {
        expect(extractVideoId("https://youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    });

    it("extracts bare video ID", () => {
        expect(extractVideoId("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    });

    it("returns null for invalid input", () => {
        expect(extractVideoId("not-a-valid-video")).toBeNull();
        expect(extractVideoId("")).toBeNull();
        expect(extractVideoId("https://example.com")).toBeNull();
    });

    it("handles URL with extra params", () => {
        expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42")).toBe("dQw4w9WgXcQ");
    });
});

describe("formatTimestamp", () => {
    it("formats zero", () => {
        expect(formatTimestamp(0)).toBe("00:00:00.000");
    });

    it("formats fractional seconds", () => {
        expect(formatTimestamp(1.5)).toBe("00:00:01.500");
    });

    it("formats minutes", () => {
        expect(formatTimestamp(90)).toBe("00:01:30.000");
    });

    it("formats hours", () => {
        expect(formatTimestamp(3661.123)).toBe("01:01:01.123");
    });

    it("formats large values", () => {
        expect(formatTimestamp(7200)).toBe("02:00:00.000");
    });

    it("carries millisecond overflow into the next second", () => {
        expect(formatTimestamp(59.9995)).toBe("00:01:00.000");
    });
});

describe("toSRT", () => {
    const segments: CaptionSegment[] = [
        { text: "Hello world", start: 0, end: 1.5 },
        { text: "Second line", start: 2.0, end: 3.5 },
    ];

    it("formats segments with comma separator and index numbering", () => {
        const result = toSRT(segments);
        expect(result).toContain("1\n00:00:00,000 --> 00:00:01,500\nHello world");
        expect(result).toContain("2\n00:00:02,000 --> 00:00:03,500\nSecond line");
    });

    it("uses commas for millisecond separator (SRT spec)", () => {
        const result = toSRT(segments);
        expect(result).toContain(",");
        expect(result).not.toContain(".");
    });
});

describe("toVTT", () => {
    const segments: CaptionSegment[] = [{ text: "Hello world", start: 0, end: 1.5 }];

    it("includes WEBVTT header", () => {
        const result = toVTT(segments);
        expect(result).toStartWith("WEBVTT");
    });

    it("uses dot separator (VTT spec)", () => {
        const result = toVTT(segments);
        expect(result).toContain("00:00:00.000 --> 00:00:01.500");
    });
});

describe("youtube transcribe command", () => {
    let stdout = "";
    let stderr = "";
    let stdoutSpy: ReturnType<typeof spyOn>;
    let stderrWriteSpy: ReturnType<typeof spyOn>;
    let stderrErrorSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        calls.ensureMetadata = [];
        calls.getTranscript = [];
        calls.transcribe = [];
        cachedTranscript = transcript;
        stdout = "";
        stderr = "";
        process.exitCode = undefined;
        stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
            stdout += String(chunk);
            return true;
        });
        stderrWriteSpy = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
            stderr += String(chunk);
            return true;
        });
        stderrErrorSpy = spyOn(console, "error").mockImplementation((chunk?: unknown) => {
            stderr += `${String(chunk)}\n`;
        });
    });

    afterEach(() => {
        stdoutSpy.mockRestore();
        stderrWriteSpy.mockRestore();
        stderrErrorSpy.mockRestore();
        process.exitCode = 0;
    });

    it("uses cached transcripts by default", async () => {
        const program = await makeProgram();

        await program.parseAsync(["node", "test", "transcribe", "https://youtu.be/dQw4w9WgXcQ"]);

        expect(calls.ensureMetadata).toEqual(["dQw4w9WgXcQ"]);
        expect(calls.getTranscript).toEqual([{ id: "dQw4w9WgXcQ", opts: { preferLang: undefined } }]);
        expect(calls.transcribe).toEqual([]);
        expect(stdout).toContain("Never gonna give you up");
    });

    it("bypasses cached transcript with --no-cache", async () => {
        const program = await makeProgram();

        await program.parseAsync([
            "node",
            "test",
            "transcribe",
            "dQw4w9WgXcQ",
            "--no-cache",
            "--provider",
            "local-hf",
            "--lang",
            "en",
            "--silent",
        ]);

        expect(calls.getTranscript).toEqual([]);
        expect(calls.transcribe[0]).toMatchObject({
            videoId: "dQw4w9WgXcQ",
            forceTranscribe: true,
            provider: "local-hf",
            lang: "en",
        });
        expect(stdout).toContain("Generated transcript");
    });

    it("emits JSON when requested", async () => {
        const program = await makeProgram();

        await program.parseAsync(["node", "test", "--json", "transcribe", "dQw4w9WgXcQ"]);

        const parsed = SafeJSON.parse(stdout) as { videoId: string; text: string };
        expect(parsed.videoId).toBe("dQw4w9WgXcQ");
        expect(parsed.text).toBe("Never gonna give you up");
    });

    it("writes selected format to an output file", async () => {
        const dir = mkdtempSync(join(tmpdir(), "youtube-transcribe-"));
        const file = join(dir, "out.srt");
        const program = await makeProgram();

        try {
            await program.parseAsync(["node", "test", "transcribe", "dQw4w9WgXcQ", "--format", "srt", "-o", file]);

            expect(readFileSync(file, "utf8")).toContain("00:00:00,000 --> 00:00:01,500");
            expect(stderr).toContain(`Written to ${file}`);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("prints a non-interactive hint when URL is missing", async () => {
        const program = await makeProgram();

        await program.parseAsync(["node", "test", "transcribe"]);

        expect(stderr).toContain("transcribe requires a YouTube URL or video ID");
        expect(stderr).toContain("tools youtube transcribe");
        expect(process.exitCode).toBe(1);
    });
});
