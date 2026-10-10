import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { completeTranscript, parseLive } from "./live";
import { pageText, parseMcpTranscript } from "./mcp";
import { mergeFrontmatter, writeGuarded } from "./output";
import { groupTurns, renderSrt } from "./render";
import { fillSpeakerMentions, resolveSpeakers } from "./speakers";
import { applyFixes, buildVocabulary, findSuspectTerms, selectFixes } from "./terms";
import type { Meeting, TranscriptEntry } from "./types";

function entry(speaker: string, startSec: number, text: string): TranscriptEntry {
    return { speaker, startSec, text };
}

describe("resolveSpeakers", () => {
    test("a manual pick in the app wins over the automatic consensus", () => {
        const map = SafeJSON.stringify({
            people: {
                a: { name: "Alice Example", origin: "self" },
                b: { name: "Bob", origin: "user" },
            },
            assignments: {
                "1": { consensus: "a", user: "b" },
                "2": { consensus: "a", user: null },
                "3": { consensus: null, user: null },
            },
        });

        expect(resolveSpeakers(map)).toEqual([
            { speakerId: 1, name: "Bob", origin: "user", isSelf: false },
            { speakerId: 2, name: "Alice Example", origin: "self", isSelf: true },
        ]);
    });
});

describe("fillSpeakerMentions", () => {
    test("replaces the app's speaker tokens, and an unnamed speaker becomes Speaker N", () => {
        const participants = [{ speakerId: 1, name: "Bob" }];

        expect(fillSpeakerMentions("<@speaker:1> asked, <@speaker:2> answered.", participants)).toBe(
            "Bob asked, Speaker 2 answered."
        );
    });
});

describe("MCP transcript pages", () => {
    test("a speaker label cut at a page boundary joins back into one line", () => {
        const first =
            "<<<HEADER>>>\nBob: Hi.\nS\n\n(...truncated, 9 chars remaining; continue with view_transcript.start_char=17...)\n<<<END TRANSCRIPT>>>";
        const second = "<<<HEADER>>>\npeaker 1: Yes.\n<<<END TRANSCRIPT>>>";
        const entries = parseMcpTranscript(pageText(first) + pageText(second));

        expect(entries.map((e) => [e.speaker, e.speakerId, e.text])).toEqual([
            ["Bob", undefined, "Hi."],
            ["Speaker 1", 1, "Yes."],
        ]);
    });
});

describe("groupTurns", () => {
    test("joins one speaker's lines and starts a paragraph after a long pause", () => {
        const turns = groupTurns([
            entry("Bob", 0, "One."),
            entry("Bob", 5, "Two."),
            entry("Bob", 60, "Three."),
            entry("Alice Example", 61, "Four."),
        ]);

        expect(turns.map((t) => t.speaker)).toEqual(["Bob", "Alice Example"]);
        expect(turns[0]!.paragraphs.map((p) => p.text)).toEqual(["One. Two.", "Three."]);
    });

    test("first names shorten the label", () => {
        expect(groupTurns([entry("Alice Example", 0, "Hi.")], true)[0]!.speaker).toBe("Alice");
    });
});

describe("renderSrt", () => {
    test("each cue ends where the next starts", () => {
        const meeting = { transcript: [entry("Bob", 0, "Hi."), entry("Alice", 3671, "Bye.")] } as Meeting;
        const srt = renderSrt(meeting, {
            source: "local",
            frontmatter: false,
            summary: false,
            timestamps: false,
            firstNames: false,
        });

        expect(srt).toContain("1\n00:00:00,000 --> 01:01:11,000\nBob: Hi.");
        expect(srt).toContain("2\n01:01:11,000 --> 01:01:17,000\nAlice: Bye.");
    });
});

describe("findSuspectTerms", () => {
    const vocab = buildVocabulary([["Zustand", "React Query", "Redux"].map((term) => ({ term, source: "test" }))]);

    test("finds a misheard term and names the right candidate", () => {
        const suspects = findSuspectTerms({ entries: [entry("Bob", 0, "Použijeme Zushtent místo toho.")], vocab });

        expect(suspects[0]?.heard).toBe("Zushtent");
        expect(suspects[0]?.candidates[0]?.term).toBe("Zustand");
    });

    test("a correct term with a Czech case ending is not a mishearing", () => {
        expect(findSuspectTerms({ entries: [entry("Bob", 0, "Data jsou v Reduxu a v Zustandu.")], vocab })).toEqual([]);
    });

    test("a correct term does not glue onto the next word", () => {
        const suspects = findSuspectTerms({ entries: [entry("Bob", 0, "Máme react-query jakoby všude.")], vocab });

        expect(suspects.map((s) => s.heard)).toEqual([]);
    });
});

describe("applyFixes", () => {
    test("replaces whole words only, and a named pair overrides the candidate", () => {
        const suspect = { heard: "Zushtent", occurrences: 1, kind: "exact" as const, candidates: [] };
        const fixes = selectFixes(
            ["redakt::Redux", "Zushtent"],
            [{ ...suspect, candidates: [{ term: "Zustand", confidence: 80, source: "test" }] }],
            0
        );
        const { entries, replaced } = applyFixes([entry("Bob", 0, "redakt a redaktor, Zushtent")], fixes);

        expect(entries[0]!.text).toBe("Redux a redaktor, Zustand");
        expect(replaced).toBe(2);
    });

    test("an unknown heard word without a replacement is refused", () => {
        expect(() => selectFixes(["nothing"], [], 0)).toThrow(/not among the suspect terms/);
        expect(() => selectFixes(["nothing::"], [], 0)).toThrow(/expected "heard::Replacement"/);
    });
});

describe("output guard", () => {
    const generated = "---\ntitle: New\nspeakers:\n  - Bob\n---\n\n# New\n\nBody.\n";

    test("keeps the file's own frontmatter and adds only the missing keys", () => {
        const merged = mergeFrontmatter("---\ntitle: Mine\ntags: [x]\n---\n\n# Old\n", generated);

        expect(merged).toBe("---\ntitle: Mine\ntags: [x]\nspeakers:\n  - Bob\n---\n\n# New\n\nBody.\n");
    });

    test("a different file is left alone until --confirm, and the diff comes back", () => {
        const path = join(mkdtempSync(join(tmpdir(), "wisprflow-")), "Transcript.md");
        writeFileSync(path, "old\n");

        const refused = writeGuarded({ path, content: generated, confirm: false, keepFrontmatter: true });
        expect(refused.status).toBe("differs");
        expect(refused.diff).toContain("+# New");
        expect(readFileSync(path, "utf8")).toBe("old\n");

        expect(writeGuarded({ path, content: generated, confirm: true, keepFrontmatter: true }).status).toBe(
            "replaced"
        );
        expect(writeGuarded({ path, content: generated, confirm: false, keepFrontmatter: true }).status).toBe(
            "unchanged"
        );
    });
});

describe("completeTranscript", () => {
    const self = { speakerId: 1, name: "Martin Example", isSelf: true };
    const live = parseLive(
        [
            SafeJSON.stringify({ meta: { v: 3 } }),
            SafeJSON.stringify({
                id: "a",
                text: " early",
                speaker: { id: 1001, source: "system" },
                startRecordingMs: 5_000,
                endRecordingMs: 6_000,
            }),
            SafeJSON.stringify({
                id: "c",
                timestamp: "147:59",
                text: " from Filip",
                speaker: { id: 1001, source: "system", name: "Filip Kalina" },
                startRecordingMs: 9_000_000,
                endRecordingMs: 9_004_000,
            }),
            SafeJSON.stringify({
                id: "b",
                timestamp: "175:24",
                text: " from the mic",
                speaker: { id: 1, source: "mic", name: null },
                startRecordingMs: 8_000_000,
                endRecordingMs: 8_002_000,
            }),
            SafeJSON.stringify({
                id: "d",
                text: "   ",
                speaker: { id: 1, source: "mic" },
                startRecordingMs: 9_100_000,
            }),
        ].join("\n")
    );

    test("a refined transcript that stops early gets the live lines after its end, ordered by recording time", () => {
        const refined = [entry("Speaker 1", 6, "refined start"), entry("Speaker 2", 798, "refined end")];
        const { transcript, gap } = completeTranscript(refined, live, [self]);

        expect(transcript.map((e) => e.text)).toEqual(["refined start", "refined end", "from the mic", "from Filip"]);
        expect(transcript[2]).toMatchObject({ speaker: "Martin Example", startSec: 8000 });
        expect(transcript[3]).toMatchObject({ speaker: "Filip Kalina", startSec: 9000 });
        expect(gap).toEqual({ refinedUntilSec: 798, liveUntilSec: 9004, appendedLines: 2 });
    });

    test("a refined transcript that reaches the end of the recording is left alone", () => {
        const refined = [entry("Speaker 1", 6, "start"), entry("Speaker 2", 8990, "end")];
        const { transcript, gap } = completeTranscript(refined, live, [self]);

        expect(transcript).toBe(refined);
        expect(gap).toBeUndefined();
    });

    test("live lines that repeat the last refined entry's speech are skipped, and the refined end moves past them", () => {
        const spoken = (id: string, text: string, startMs: number, endMs: number) =>
            SafeJSON.stringify({ id, text, speaker: { id: 1001 }, startRecordingMs: startMs, endRecordingMs: endMs });
        const tailLive = parseLive(
            [
                spoken("r1", "we ship the release on monday", 101_000, 104_000),
                spoken("r2", "after the security review", 120_000, 160_000),
                spoken("n1", "next topic is hiring", 200_000, 203_000),
            ].join("\n")
        );
        const refined = [entry("Speaker 2", 100, "We ship the release on Monday, after the security review.")];
        const { transcript, gap } = completeTranscript(refined, tailLive, [self]);

        expect(transcript.map((e) => e.text)).toEqual([refined[0].text, "next topic is hiring"]);
        expect(gap).toEqual({ refinedUntilSec: 160, liveUntilSec: 203, appendedLines: 1 });
    });

    test("with no refined transcript every live line is kept, a short recording included", () => {
        const { transcript, gap } = completeTranscript([], live, [self]);

        expect(transcript.map((e) => e.text)).toEqual(["early", "from the mic", "from Filip"]);
        expect(gap).toEqual({ refinedUntilSec: 0, liveUntilSec: 9004, appendedLines: 3 });
    });

    test("a speaker's current assignment wins over the name the live line captured", () => {
        const renamed = { speakerId: 1001, name: "Renamed Person", isSelf: false };
        const { transcript } = completeTranscript([entry("Speaker 1", 6, "start")], live, [self, renamed]);

        expect(transcript.at(-1)).toMatchObject({ text: "from Filip", speaker: "Renamed Person" });
    });

    test("an unfinished last line is skipped while the meeting is still being written; a broken middle line throws", () => {
        const done = SafeJSON.stringify({ text: "done", startRecordingMs: 1_000 });

        expect(parseLive(`${done}\n{"text":"half`).map((l) => l.text)).toEqual(["done"]);
        expect(() => parseLive(`{"text":"half\n${done}\n`)).toThrow();
    });
});
