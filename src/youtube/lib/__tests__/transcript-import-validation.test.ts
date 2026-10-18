import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YoutubeDatabase } from "@app/youtube/lib/db";
import {
    exportTranscripts,
    importTranscriptDir,
    parseExportJson,
    parseExportMarkdown,
    renderTranscriptMarkdown,
} from "@app/youtube/lib/transcript-export";
import { SafeJSON } from "@genesiscz/utils/json";

function exportJson(segments: unknown): string {
    return SafeJSON.stringify({ videoId: "abc123def45", text: "alpha beta", segments }, { strict: true });
}

describe("parseExportJson segment validation", () => {
    it("keeps well-formed segments, with and without a speaker", () => {
        const parsed = parseExportJson(
            exportJson([
                { text: "alpha", start: 0, end: 10 },
                { text: "beta", start: 10, end: 20, speaker: 1 },
            ])
        );

        expect(parsed?.segments).toEqual([
            { text: "alpha", start: 0, end: 10 },
            { text: "beta", start: 10, end: 20, speaker: 1 },
        ]);
    });

    // Each of these used to be cast straight into TranscriptSegment[] and written to
    // the DB by saveTranscript, surfacing much later as broken chunking or rendering.
    it("drops entries that are not segment objects", () => {
        const parsed = parseExportJson(exportJson([null, "alpha", 42, [], { text: "ok", start: 0, end: 1 }]));

        expect(parsed?.segments).toEqual([{ text: "ok", start: 0, end: 1 }]);
    });

    it("drops non-string text and non-finite or non-numeric times", () => {
        const parsed = parseExportJson(
            exportJson([
                { text: 7, start: 0, end: 1 },
                { text: "a", start: "0", end: 1 },
                { text: "b", start: 0, end: Number.NaN },
                { text: "c", start: 0 },
                { text: "ok", start: 0, end: 1 },
            ])
        );

        expect(parsed?.segments).toEqual([{ text: "ok", start: 0, end: 1 }]);
    });

    it("drops negative and reversed ranges", () => {
        const parsed = parseExportJson(
            exportJson([
                { text: "negative", start: -5, end: 10 },
                { text: "reversed", start: 20, end: 10 },
                { text: "ok", start: 0, end: 1 },
            ])
        );

        expect(parsed?.segments).toEqual([{ text: "ok", start: 0, end: 1 }]);
    });

    // `speaker` is a 0-based index, so a negative or fractional value has no speaker
    // to name — it would key a label lookup that can never match.
    it("drops negative, fractional and non-numeric speaker indices", () => {
        const parsed = parseExportJson(
            exportJson([
                { text: "negative", start: 0, end: 1, speaker: -1 },
                { text: "fractional", start: 0, end: 1, speaker: 1.5 },
                { text: "string", start: 0, end: 1, speaker: "0" },
                { text: "ok", start: 0, end: 1, speaker: 0 },
            ])
        );

        expect(parsed?.segments).toEqual([{ text: "ok", start: 0, end: 1, speaker: 0 }]);
    });

    // These files are written by `transcripts export`, so comments and trailing
    // commas mean the file was corrupted or hand-edited, not that it is convenient
    // JSON5 — strict parsing rejects rather than silently importing.
    it("rejects comment-json extensions in an exported file", () => {
        expect(() => parseExportJson('{"videoId":"abc123def45","text":"a","segments":[],}')).toThrow();
        expect(() => parseExportJson('{"videoId":"abc123def45","text":"a", // note\n"segments":[]}')).toThrow();
    });

    it("treats a zero-length segment as valid and a non-array as empty", () => {
        expect(parseExportJson(exportJson([{ text: "tick", start: 5, end: 5 }]))?.segments).toHaveLength(1);
        expect(parseExportJson(exportJson("nope"))?.segments).toEqual([]);
        expect(parseExportJson(exportJson(undefined))?.segments).toEqual([]);
    });
});

describe("parseExportJson fields", () => {
    it("fills defaults for fields the file leaves out and keeps the ones it has", () => {
        const parsed = parseExportJson(SafeJSON.stringify({ videoId: "abc123def45", text: "hello" }, { strict: true }));

        expect(parsed).toEqual({
            videoId: "abc123def45",
            title: "abc123def45",
            channel: "@unknown",
            uploadDate: null,
            durationSec: null,
            lang: "en",
            source: "captions",
            text: "hello",
            segments: [],
        });
    });

    it("ignores fields of the wrong type instead of importing them", () => {
        const parsed = parseExportJson(
            SafeJSON.stringify(
                { videoId: "abc123def45", text: "t", title: 5, channel: null, uploadDate: 20260314, durationSec: "9" },
                { strict: true }
            )
        );

        expect(parsed).toMatchObject({
            title: "abc123def45",
            channel: "@unknown",
            uploadDate: null,
            durationSec: null,
        });
    });

    it("returns null when the file is not an export object", () => {
        expect(parseExportJson("null")).toBeNull();
        expect(parseExportJson(SafeJSON.stringify({ text: "no id" }, { strict: true }))).toBeNull();
        expect(parseExportJson(SafeJSON.stringify({ videoId: "abc123def45" }, { strict: true }))).toBeNull();
    });
});

describe("parseExportMarkdown", () => {
    const exported = [
        "---",
        "videoId: abc123def45",
        'title: "Say \\"hi\\" \\\\ now"',
        "channel: @acme-channel",
        "uploadDate: 2026-03-14",
        "durationSec: 100.5",
        "lang: cs",
        "source: ai",
        "---",
        "",
        "# ignored heading",
        "",
        "[0:05] first line",
        "[1:02:03] after an hour",
        "",
    ].join("\n");

    it("reads the frontmatter, unquotes the title and infers segment ends from the next start", () => {
        const parsed = parseExportMarkdown(exported, "fallback-id");

        expect(parsed).toMatchObject({
            videoId: "abc123def45",
            title: 'Say "hi" \\ now',
            channel: "@acme-channel",
            uploadDate: "2026-03-14",
            durationSec: 100.5,
            lang: "cs",
            source: "ai",
            text: "first line after an hour",
        });
        expect(parsed?.segments).toEqual([
            { text: "first line", start: 5, end: 3723 },
            { text: "after an hour", start: 3723, end: 100.5 },
        ]);
    });

    it("ends the last segment at its own start when the duration is unknown", () => {
        const parsed = parseExportMarkdown("[0:10] only line", "abc123def45");

        expect(parsed?.segments).toEqual([{ text: "only line", start: 10, end: 10 }]);
    });

    it("takes the video id from the file name and defaults the rest when there is no frontmatter", () => {
        const parsed = parseExportMarkdown("[0:01] a\n[0:02] b", "abc123def45");

        expect(parsed).toMatchObject({
            videoId: "abc123def45",
            title: "abc123def45",
            channel: "@unknown",
            uploadDate: null,
            durationSec: null,
            lang: "en",
            source: "captions",
            text: "a b",
        });
    });

    it("keeps unstamped lines as plain text, and a malformed stamp stays text", () => {
        const parsed = parseExportMarkdown("just words\n[1x:02] not a stamp\n\n# Title\nmore words", "abc123def45");

        expect(parsed?.segments).toEqual([]);
        expect(parsed?.text).toBe("just words [1x:02] not a stamp more words");
    });

    it("a stamp whose number is too large to read stays plain text", () => {
        const huge = "9".repeat(400);
        const parsed = parseExportMarkdown(`[0:03] real\n[${huge}] impossible`, "abc123def45");

        expect(parsed?.segments).toEqual([{ text: "real", start: 3, end: 3 }]);
        expect(parsed?.text).toBe("real");

        const onlyHuge = parseExportMarkdown(`[${huge}] impossible`, "abc123def45");

        expect(onlyHuge?.segments).toEqual([]);
        expect(onlyHuge?.text).toBe(`[${huge}] impossible`);
    });

    it("prefers stamped lines for the text and drops the plain ones", () => {
        const parsed = parseExportMarkdown("intro\n[0:03] stamped", "abc123def45");

        expect(parsed?.text).toBe("stamped");
        expect(parsed?.segments).toHaveLength(1);
    });

    it("returns null for a file with a heading and no content", () => {
        expect(parseExportMarkdown("---\nvideoId: abc123def45\n---\n\n# Only a title\n", "abc123def45")).toBeNull();
        expect(parseExportMarkdown("", "abc123def45")).toBeNull();
    });

    it("ignores frontmatter lines without a colon", () => {
        const parsed = parseExportMarkdown("---\nnot a pair\nlang: de\n---\n[0:01] x", "abc123def45");

        expect(parsed?.lang).toBe("de");
    });
});

describe("transcript export and import on disk", () => {
    let dir: string;
    let db: YoutubeDatabase;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "youtube-transcript-export-"));
        db = new YoutubeDatabase(":memory:");
        db.upsertChannel({ handle: "@acme-channel", title: "Acme" });
        db.upsertVideo({
            id: "abc123def45",
            channelHandle: "@acme-channel",
            title: "Widgets, explained",
            uploadDate: "2026-03-14",
            durationSec: 120,
        });
        db.upsertVideo({ id: "xyz987uvw65", channelHandle: "@acme-channel", title: "No transcript yet" });
        db.saveTranscript({
            videoId: "abc123def45",
            lang: "en",
            source: "captions",
            text: "Welcome back. We build widgets.",
            segments: [
                { text: "Welcome back.", start: 0, end: 5 },
                { text: "We build widgets.", start: 5, end: 120 },
            ],
            durationSec: 120,
        });
    });

    afterEach(() => {
        db.close();
        rmSync(dir, { recursive: true, force: true });
    });

    it("writes one file per video, creating the folder, and reports bytes and skipped videos", async () => {
        const target = join(dir, "nested", "out");

        const result = await exportTranscripts({
            db,
            videoIds: ["abc123def45", "xyz987uvw65", "missing0000"],
            dir: target,
            format: "srt",
        });

        const path = join(target, "abc123def45.srt");

        expect(result.dir).toBe(target);
        expect(result.written).toEqual([{ videoId: "abc123def45", path, bytes: readFileSync(path).byteLength }]);
        expect(readFileSync(path, "utf8")).toBe(
            "1\n00:00:00,000 --> 00:00:05,000\nWelcome back.\n\n2\n00:00:05,000 --> 00:02:00,000\nWe build widgets.\n"
        );
        expect(result.skipped).toEqual([
            { videoId: "xyz987uvw65", reason: "no-transcript" },
            { videoId: "missing0000", reason: "no-transcript" },
        ]);
        expect(existsSync(join(target, "xyz987uvw65.srt"))).toBe(false);
    });

    it("skips a video whose row disappears between the two reads and writes no file for it", async () => {
        class VanishingVideoDb extends YoutubeDatabase {
            override getVideo(): null {
                return null;
            }
        }
        const racing = new VanishingVideoDb(":memory:");

        try {
            racing.upsertChannel({ handle: "@acme-channel" });
            racing.upsertVideo({ id: "abc123def45", channelHandle: "@acme-channel", title: "Gone soon" });
            racing.saveTranscript({
                videoId: "abc123def45",
                lang: "en",
                source: "captions",
                text: "text",
                segments: [],
            });

            const result = await exportTranscripts({ db: racing, videoIds: ["abc123def45"], dir, format: "txt" });

            expect(result.written).toEqual([]);
            expect(result.skipped).toEqual([{ videoId: "abc123def45", reason: "no-video-row" }]);
            expect(existsSync(join(dir, "abc123def45.txt"))).toBe(false);
        } finally {
            racing.close();
        }
    });

    it("keeps an existing file unless overwrite is set", async () => {
        const path = join(dir, "abc123def45.txt");
        writeFileSync(path, "old contents");

        const kept = await exportTranscripts({ db, videoIds: ["abc123def45"], dir, format: "txt" });

        expect(kept.written).toEqual([]);
        expect(kept.skipped).toEqual([{ videoId: "abc123def45", reason: "exists" }]);
        expect(readFileSync(path, "utf8")).toBe("old contents");

        const replaced = await exportTranscripts({
            db,
            videoIds: ["abc123def45"],
            dir,
            format: "txt",
            overwrite: true,
        });

        expect(replaced.written).toHaveLength(1);
        expect(readFileSync(path, "utf8")).toBe("Welcome back. We build widgets.\n");
    });

    it("a json export imports back into a fresh database with the exact segments", async () => {
        await exportTranscripts({ db, videoIds: ["abc123def45"], dir, format: "json" });
        const fresh = new YoutubeDatabase(":memory:");

        try {
            const result = await importTranscriptDir({ db: fresh, dir });

            expect(result.imported).toEqual([{ videoId: "abc123def45", file: "abc123def45.json", segments: 2 }]);
            expect(result.skipped).toEqual([]);
            expect(fresh.getVideo("abc123def45")).toMatchObject({
                title: "Widgets, explained",
                channelHandle: "@acme-channel",
                uploadDate: "2026-03-14",
                durationSec: 120,
            });
            expect(fresh.getTranscript("abc123def45")).toMatchObject({
                lang: "en",
                source: "captions",
                text: "Welcome back. We build widgets.",
                segments: [
                    { text: "Welcome back.", start: 0, end: 5 },
                    { text: "We build widgets.", start: 5, end: 120 },
                ],
            });
        } finally {
            fresh.close();
        }
    });

    it("a markdown export imports back with starts kept and ends inferred", async () => {
        await exportTranscripts({ db, videoIds: ["abc123def45"], dir, format: "md" });
        const fresh = new YoutubeDatabase(":memory:");

        try {
            const result = await importTranscriptDir({ db: fresh, dir });

            expect(result.imported).toEqual([{ videoId: "abc123def45", file: "abc123def45.md", segments: 2 }]);
            expect(fresh.getTranscript("abc123def45")?.segments).toEqual([
                { text: "Welcome back.", start: 0, end: 5 },
                { text: "We build widgets.", start: 5, end: 120 },
            ]);
        } finally {
            fresh.close();
        }
    });

    it("imports in file name order, ignores other extensions, and reports files it cannot use", async () => {
        const valid = db.getTranscript("abc123def45");

        if (!valid) {
            throw new Error("fixture transcript missing");
        }

        writeFileSync(join(dir, "a-broken.json"), '{"videoId":"abc123def45","text":"x",}');
        writeFileSync(join(dir, "b-no-text.json"), SafeJSON.stringify({ videoId: "abc123def45" }, { strict: true }));
        writeFileSync(join(dir, "c-empty.md"), "# Just a heading\n");
        writeFileSync(join(dir, "d-notes.txt"), "not an export");
        writeFileSync(
            join(dir, "e-good.md"),
            renderTranscriptMarkdown(
                {
                    id: "good0000001",
                    title: "Good one",
                    channelHandle: "@acme-channel",
                    uploadDate: null,
                    durationSec: 30,
                },
                { ...valid, videoId: "good0000001" }
            )
        );
        mkdirSync(join(dir, "f-subdir"));
        const fresh = new YoutubeDatabase(":memory:");

        try {
            const result = await importTranscriptDir({ db: fresh, dir });

            expect(result.imported.map((entry) => entry.file)).toEqual(["e-good.md"]);
            expect(result.skipped.map((entry) => entry.file)).toEqual([
                "a-broken.json",
                "b-no-text.json",
                "c-empty.md",
            ]);
            expect(result.skipped[0].reason).not.toBe("unrecognised format");
            expect(result.skipped.slice(1).map((entry) => entry.reason)).toEqual([
                "unrecognised format",
                "unrecognised format",
            ]);
            expect(fresh.getVideo("good0000001")?.title).toBe("Good one");
            expect(fresh.getVideo("abc123def45")).toBeNull();
        } finally {
            fresh.close();
        }
    });

    it("stores an ai transcript as ai and anything else as captions", async () => {
        writeFileSync(
            join(dir, "ai.json"),
            SafeJSON.stringify({ videoId: "aiaiaiaiai1", text: "spoken", source: "ai" }, { strict: true })
        );
        writeFileSync(
            join(dir, "other.json"),
            SafeJSON.stringify({ videoId: "otherother12", text: "typed", source: "manual" }, { strict: true })
        );
        const fresh = new YoutubeDatabase(":memory:");

        try {
            await importTranscriptDir({ db: fresh, dir });

            expect(fresh.getTranscript("aiaiaiaiai1")?.source).toBe("ai");
            expect(fresh.getTranscript("otherother12")?.source).toBe("captions");
            expect(fresh.getVideo("aiaiaiaiai1")?.channelHandle).toBe("@unknown");
        } finally {
            fresh.close();
        }
    });

    it("refuses a folder that does not exist", async () => {
        const missing = join(dir, "nope");

        await expect(importTranscriptDir({ db, dir: missing })).rejects.toThrow(
            `transcript import: directory not found: ${missing}`
        );
    });
});
