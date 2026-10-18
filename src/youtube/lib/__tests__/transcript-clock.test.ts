import { describe, expect, it } from "bun:test";
import type { Transcript } from "@app/youtube/lib/transcript.types";
import {
    type ExportVideoMeta,
    formatClock,
    parseClock,
    renderTranscript,
    renderTranscriptMarkdown,
    renderTranscriptSrt,
    renderTranscriptVtt,
    transcriptToExportJson,
    videoUrl,
} from "@app/youtube/lib/transcript-export";
import { SafeJSON } from "@genesiscz/utils/json";

describe("parseClock", () => {
    it("reads the three shapes formatClock writes", () => {
        expect(parseClock("42")).toBe(42);
        expect(parseClock("12:03")).toBe(723);
        expect(parseClock("1:02:03")).toBe(3723);
    });

    it("round-trips formatClock", () => {
        for (const seconds of [0, 59, 60, 723, 3599, 3723, 86_399]) {
            expect(parseClock(formatClock(seconds))).toBe(seconds);
        }
    });

    it("rejects components that are only partly numeric", () => {
        // `Number.parseInt` stops at the first non-digit, so these used to import as
        // 62 / 12 / 5 with fabricated segment timing rather than being skipped.
        expect(parseClock("1x:02")).toBeNull();
        expect(parseClock("12junk")).toBeNull();
        expect(parseClock("5.5")).toBeNull();
        expect(parseClock("-1:00")).toBeNull();
        expect(parseClock(" 12:03")).toBeNull();
    });

    it("rejects a digit run too long to be a number", () => {
        expect(parseClock("9".repeat(400))).toBeNull();
        expect(parseClock(`1:${"9".repeat(400)}`)).toBeNull();
    });

    it("rejects empty components and unsupported arity", () => {
        expect(parseClock("")).toBeNull();
        expect(parseClock(":30")).toBeNull();
        expect(parseClock("1:2:3:4")).toBeNull();
    });
});

describe("formatClock", () => {
    it("writes mm:ss below an hour and h:mm:ss from an hour up", () => {
        expect(formatClock(0)).toBe("0:00");
        expect(formatClock(65)).toBe("1:05");
        expect(formatClock(3599)).toBe("59:59");
        expect(formatClock(3600)).toBe("1:00:00");
        expect(formatClock(3725)).toBe("1:02:05");
    });

    it("floors fractions and clamps negative input to zero", () => {
        expect(formatClock(65.9)).toBe("1:05");
        expect(formatClock(-30)).toBe("0:00");
    });
});

describe("videoUrl", () => {
    it("links the watch page and deep-links a whole-second offset", () => {
        expect(videoUrl("abc123def45")).toBe("https://www.youtube.com/watch?v=abc123def45");
        expect(videoUrl("abc123def45", 123.9)).toBe("https://www.youtube.com/watch?v=abc123def45&t=123s");
        expect(videoUrl("abc123def45", 0)).toBe("https://www.youtube.com/watch?v=abc123def45&t=0s");
    });

    it("ignores a missing offset and clamps a negative one", () => {
        expect(videoUrl("abc123def45", null)).toBe("https://www.youtube.com/watch?v=abc123def45");
        expect(videoUrl("abc123def45", undefined)).toBe("https://www.youtube.com/watch?v=abc123def45");
        expect(videoUrl("abc123def45", -5)).toBe("https://www.youtube.com/watch?v=abc123def45&t=0s");
    });
});

const video: ExportVideoMeta = {
    id: "abc123def45",
    title: "Widgets, explained",
    channelHandle: "@acme-channel",
    uploadDate: "2026-03-14",
    durationSec: 4000,
};

const transcript: Transcript = {
    id: 1,
    videoId: "abc123def45",
    lang: "en",
    source: "captions",
    text: "Welcome back. Today we build widgets.",
    segments: [
        { text: "Welcome back.", start: 0, end: 4.25 },
        { text: "Today we build widgets.", start: 3661.5, end: 3700 },
    ],
    durationSec: 3700,
    createdAt: "2026-03-14T10:00:00Z",
};

describe("transcriptToExportJson", () => {
    it("carries the video and transcript fields and a watch url", () => {
        const exported = transcriptToExportJson(video, transcript);

        expect(exported).toMatchObject({
            videoId: "abc123def45",
            title: "Widgets, explained",
            channel: "@acme-channel",
            url: "https://www.youtube.com/watch?v=abc123def45",
            uploadDate: "2026-03-14",
            durationSec: 4000,
            lang: "en",
            source: "captions",
            text: transcript.text,
        });
        expect(exported.segments).toEqual(transcript.segments);
        expect(new Date(exported.exportedAt).toISOString()).toBe(exported.exportedAt);
    });

    it("falls back to the transcript duration, then null, when the video row has none", () => {
        expect(transcriptToExportJson({ ...video, durationSec: null }, transcript).durationSec).toBe(3700);
        expect(
            transcriptToExportJson({ ...video, durationSec: null }, { ...transcript, durationSec: null }).durationSec
        ).toBeNull();
    });
});

describe("renderTranscriptSrt and renderTranscriptVtt", () => {
    it("numbers SRT cues and writes comma-separated milliseconds", () => {
        expect(renderTranscriptSrt(transcript.segments)).toBe(
            [
                "1\n00:00:00,000 --> 00:00:04,250\nWelcome back.",
                "2\n01:01:01,500 --> 01:01:40,000\nToday we build widgets.",
            ].join("\n\n")
        );
    });

    it("writes VTT with a header and dot-separated milliseconds", () => {
        expect(renderTranscriptVtt(transcript.segments)).toBe(
            [
                "WEBVTT",
                "00:00:00.000 --> 00:00:04.250\nWelcome back.",
                "01:01:01.500 --> 01:01:40.000\nToday we build widgets.",
            ].join("\n\n")
        );
    });

    it("rounds to the nearest millisecond, carries into the next second, and clamps negatives", () => {
        const srt = renderTranscriptSrt([{ text: "edge", start: 59.9996, end: -2 }]);

        expect(srt).toBe("1\n00:01:00,000 --> 00:00:00,000\nedge");
    });

    it("renders no cues for an empty transcript", () => {
        expect(renderTranscriptSrt([])).toBe("");
        expect(renderTranscriptVtt([])).toBe("WEBVTT\n\n");
    });
});

describe("renderTranscriptMarkdown", () => {
    it("writes quoted frontmatter, a heading and one [clock] line per segment", () => {
        const markdown = renderTranscriptMarkdown({ ...video, title: 'He said "hi" \\ bye' }, transcript);
        const [frontmatter, heading, ...body] = markdown.split("\n\n");

        expect(frontmatter).toContain(
            '---\nvideoId: abc123def45\ntitle: "He said \\"hi\\" \\\\ bye"\nchannel: @acme-channel'
        );
        expect(frontmatter).toContain(
            "uploadDate: 2026-03-14\ndurationSec: 4000\nlang: en\nsource: captions\nsegments: 2"
        );
        expect(heading).toBe('# He said "hi" \\ bye');
        expect(body.join("\n\n")).toBe("[0:00] Welcome back.\n[1:01:01] Today we build widgets.\n");
    });

    it("falls back to the plain text when there are no segments, and leaves unknown fields empty", () => {
        const markdown = renderTranscriptMarkdown(
            { ...video, uploadDate: null, durationSec: null },
            { ...transcript, segments: [], durationSec: null }
        );

        expect(markdown).toContain("uploadDate: \ndurationSec: \n");
        expect(markdown).toContain("segments: 0");
        expect(markdown.endsWith("# Widgets, explained\n\nWelcome back. Today we build widgets.\n")).toBe(true);
    });
});

describe("renderTranscript", () => {
    it("txt is the plain text with one trailing newline", () => {
        expect(renderTranscript(video, transcript, "txt")).toBe("Welcome back. Today we build widgets.\n");
    });

    it("json is pretty-printed strict JSON that round-trips the export object", () => {
        const raw = renderTranscript(video, transcript, "json");
        const parsed = SafeJSON.parse(raw, { strict: true }) as ReturnType<typeof transcriptToExportJson>;

        expect(raw.endsWith("}\n")).toBe(true);
        expect(raw).toContain('\n  "videoId": "abc123def45"');
        expect(parsed.segments).toEqual(transcript.segments);
        expect(parsed.channel).toBe("@acme-channel");
    });

    it("srt and vtt end with a newline and md routes to the markdown renderer", () => {
        expect(renderTranscript(video, transcript, "srt")).toBe(`${renderTranscriptSrt(transcript.segments)}\n`);
        expect(renderTranscript(video, transcript, "vtt")).toBe(`${renderTranscriptVtt(transcript.segments)}\n`);
        expect(renderTranscript(video, transcript, "md")).toContain("[0:00] Welcome back.");
    });
});
