import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { SafeJSON } from "@genesiscz/utils/json";
import { splitFrontmatter } from "@genesiscz/utils/json2md/frontmatter";
import { stripStamp } from "@genesiscz/utils/json2md/integrity";
import {
    defineMeetingsPolished,
    isDefinedMeetingsPolished,
    MEETINGS_POLISHED_SPECIFIER,
} from "@genesiscz/utils/meetings/polished";
import { type MeetingItem, MeetingStore } from "@genesiscz/utils/meetings/record";
import type { SourceMeeting, TranscriptSource } from "@genesiscz/utils/meetings/sources";
import { Storage } from "@genesiscz/utils/storage/storage";
import { adoptPolishedDraft, initPolished, polishedModuleSource } from "./adopt";
import { adoptPolishedMarkdown } from "./adopt-md";
import { buildPolished } from "./build";
import { type PartTimes, renderTimes, tokenizeBareTimes } from "./tokens";

const POLISHED_MODULE = resolve(moduleDir(import.meta), "../../../utils/meetings/polished.ts");

describe("time tokens", () => {
    const parts = new Map<string, PartTimes>([
        ["t", { record: "second", link: (atSec) => `https://example.test/play?at=${atSec}` }],
        ["p", { record: "first", marker: "first recording", link: () => null }],
    ]);

    test("a token becomes its part's play link outside a fence and plain text with the marker inside one", () => {
        const unknown = new Set<string>();
        const text = renderTimes(
            "At [[t:01:05]], [[p:00:10]] and [[x:00:01]].\n```diff\n- [[t:01:05]] a\n+ [[p:00:10]] b\n```",
            parts,
            unknown
        );

        expect(text).toContain("`01:05`<sup>[play](https://example.test/play?at=65)</sup>");
        expect(text).toContain("`00:10` and");
        expect(text).toContain("- 01:05 a\n+ first recording 00:10 b");
        expect([...unknown]).toEqual(["[[x:00:01]]"]);
    });

    test("bare times on bullet lines become tokens; a time after a part's marker belongs to that part", () => {
        const markers = new Map([["first recording", "p"]]);
        const text = tokenizeBareTimes(
            "- read at 12:34 and first recording 00:22\nplain 01:00\n- v1:2 stays",
            "t",
            markers
        );

        expect(text).toBe("- read at [[t:12:34]] and first recording [[p:00:22]]\nplain 01:00\n- v1:2 stays");
    });
});

describe("defineMeetingsPolished", () => {
    test("validates, marks and fills the defaults", () => {
        const defined = defineMeetingsPolished({ title: "Planning", parts: [{ record: "r1", token: "t" }] });

        expect(isDefinedMeetingsPolished(defined)).toBe(true);
        expect(defined.transcript.applyAbove).toBe(70);
    });

    test("refuses a token used twice and an entry naming no part's record", () => {
        expect(() =>
            defineMeetingsPolished({
                title: "Planning",
                parts: [
                    { record: "r1", token: "t" },
                    { record: "r2", token: "t" },
                ],
            })
        ).toThrow(/used twice/);
        expect(() =>
            defineMeetingsPolished({
                title: "Planning",
                parts: [{ record: "r1", token: "t" }],
                unresolved: [{ id: "U1", record: "r9", at: "00:01", question: "Who?" }],
            })
        ).toThrow(/not the record of any part/);
    });
});

describe("adoptPolishedDraft", () => {
    test("maps every known field and keeps the rest under extras, with a report line each", () => {
        const { config, report } = adoptPolishedDraft({
            title: "Planning",
            ado: "123",
            mood: "calm",
            termFixes: { main: [] },
            parts: [
                {
                    part: 2,
                    record: "r2",
                    token: "t",
                    wisprflow: "w2",
                    shareLink: "https://example.test/2",
                    color: "red",
                },
                { part: 1, record: "r1", token: "p", wisprflow: "w1" },
            ],
            participants: [{ person: "Alice Example", role: "host", seat: "room", present: "all", mood: "calm" }],
            glossaryMd: "| a | b |",
            referencesMd: "# References\n- the plan, read at 12:34",
        });

        expect(config.parts.map((part) => part.record)).toEqual(["r1", "r2"]);
        expect(config.parts[1]?.sources?.wisprflow).toEqual({ meetingId: "w2", shareLink: "https://example.test/2" });
        expect(config.frontmatter).toEqual({ ado: "123" });
        expect(config.glossary?.md).toBe("| a | b |");
        expect(config.references?.linkBareTimes).toBe("t");
        expect(Object.keys(config.extras ?? {}).sort()).toEqual([
            "mood",
            "participants[0].mood",
            "parts[1].color",
            "termFixes",
        ]);
        expect(report.kept.some((line) => line.startsWith("mood (unknown field)"))).toBe(true);
        expect(report.notes.some((note) => note.includes("marker"))).toBe(true);
        expect(polishedModuleSource(config, "/notes/Planning.polished.ts")).toStartWith(
            'import { defineMeetingsPolished } from "@genesiscz/utils/meetings/polished";'
        );
    });
});

describe("adoptPolishedMarkdown", () => {
    const play = (meeting: string, at: string) =>
        `\`${at}\`<sup>[play](https://example.test/meetings/play?meeting=${meeting}&at=${encodeURIComponent(at)})</sup>`;
    const fence = "```";
    const markdown = [
        "---",
        "tags: [work, planning]",
        "title: Planning",
        "source: wisprflow",
        "wisprflow_id: w-1",
        "meeting_record: rec-1",
        "share_link: https://example.test/share/1",
        "start: 2026-11-02 15:00 (Europe/Prague)",
        "end: 2026-11-02 16:00 (Europe/Prague)",
        "written: 2026-11-03 10:00",
        "status: draft",
        'waiting_for: ["listen questions Q1 to Q2"]',
        'sessions: ["claude:abc(planning)"]',
        "---",
        "",
        "# Planning (polished)",
        "",
        `Read at ${play("rec-1", "00:05")}.`,
        "",
        "## Participants",
        "",
        "| Person | Role |",
        "|---|---|",
        "| Alice Example | host |",
        "",
        "## Glossary",
        "",
        `- **API**: heard as apí ${play("rec-1", "00:10")}, elsewhere ${play("other", "00:11")}`,
        "",
        "## Summary",
        "",
        `- Decided ${play("rec-old", "1:00:05")} at ${play("rec-1", "6:07")}.`,
        "",
        "## Summary diff",
        "",
        `${fence}diff`,
        `- old ${play("rec-1", "00:05")}`,
        "## not a heading inside a fence",
        fence,
        "",
        "## Transcript",
        "",
        `<details>\n<summary>Part 1</summary>\n\n**Alice Example** ${play("rec-1", "00:00")} Ahoj.\n\n</details>`,
        "",
        "## Diffs",
        "",
        "Speaker diffs.",
        "",
        "## Unresolved",
        "",
        "**U1** a question",
        "",
    ].join("\n");

    test("maps the front matter, tokenizes the play links of its parts and freezes the sections the records write", () => {
        const aliases: Record<string, string> = { "rec-1": "rec-1", "rec-old": "rec-1" };
        const { config, report } = adoptPolishedMarkdown({ markdown, resolve: (ref) => aliases[ref] });

        expect(config.title).toBe("Planning");
        expect(config.heading).toBeUndefined();
        expect(config.status).toBe("draft");
        expect(config.writtenAt).toBe("2026-11-03 10:00");
        expect(config.frontmatter).toEqual({ tags: ["work", "planning"] });
        expect(config.parts).toEqual([
            {
                record: "rec-1",
                token: "t",
                start: "2026-11-02 15:00",
                end: "2026-11-02 16:00",
                sources: { wisprflow: { meetingId: "w-1", shareLink: "https://example.test/share/1" } },
            },
        ]);
        expect(config.intro).toBe("Read at [[t:00:05]].");
        expect(config.glossary?.md).toBe(`- **API**: heard as apí [[t:00:10]], elsewhere ${play("other", "00:11")}`);
        expect(config.summary?.md).toBe(`- Decided ${play("rec-old", "1:00:05")} at ${play("rec-1", "6:07")}.`);
        expect(config.sections).toEqual([
            {
                heading: "Summary diff",
                after: "summary",
                md: `${fence}diff\n- old ${play("rec-1", "00:05")}\n## not a heading inside a fence\n${fence}`,
            },
        ]);
        expect(config.overrides?.sections?.participants).toStartWith("| Person | Role |");
        expect(config.overrides?.sections?.transcript).toContain("**Alice Example** [[t:00:00]] Ahoj.");
        expect(config.overrides?.sections?.unresolved).toBe("**U1** a question");
        expect(config.overrides?.sections?.questions).toBeNull();
        expect(config.adopted?.frontmatterKeys).toEqual([
            "meeting_record",
            "title",
            "status",
            "written",
            "wisprflow_id",
            "share_link",
            "start",
            "end",
            "source",
            "waiting_for",
        ]);
        expect(
            report.notes.some((note) =>
                note.startsWith("Play links: 3 became [[<token>:MM:SS]] tokens, 3 stay as written")
            )
        ).toBe(true);
        expect(report.notes.some((note) => note.startsWith("waiting_for"))).toBe(true);
        expect(report.notes.some((note) => note.startsWith("sessions"))).toBe(true);
        expect(() =>
            adoptPolishedMarkdown({
                markdown: markdown.replace("meeting_record: rec-1\n", ""),
                resolve: () => undefined,
            })
        ).toThrow(/No meeting "rec-1"/);
        expect(() => adoptPolishedMarkdown({ markdown: "no title" })).toThrow(/title line/);
    });
});

function fakeSource(meeting: SourceMeeting): TranscriptSource {
    return {
        id: "wisprflow",
        label: "Fake",
        load: async () => meeting,
        revision: async () => null,
        describe: () => ({ meetingId: meeting.sourceMeetingId }),
        dictionary: async () => [],
        recordingClock: async () => null,
        evidence: async () => null,
        liveRecording: async () => null,
        calendarEntries: async () => ({ ok: true, from: "wisprflow", entries: [] }),
        folders: async () => [],
        meetingsBetween: async () => null,
        meetingFolders: async () => [],
        folderWrite: { supported: false, reason: "fake", manualStep: "none" },
    };
}

describe("buildPolished", () => {
    test("writes the stamped file, keeps it unchanged, refuses a hand edit, and writes neither the module nor the record", async () => {
        const store = new MeetingStore(new Storage(`meetings-polish-${process.pid}`));
        const meeting: SourceMeeting = {
            sourceMeetingId: "abc",
            title: "Planning",
            start: "2026-11-02T15:00:00.000Z",
            participants: [{ name: "Alice Example", self: true, from: ["fake"] }],
            speakers: [],
            transcript: [
                { speaker: "Alice Example", startSec: 0, text: "Ahoj, jak to jde?" },
                { speaker: "Speaker 2", startSec: 5, text: "Dobře, díky." },
                { speaker: "Speaker 2", startSec: 10, text: "Mám otázku k apí." },
            ],
            folders: [],
        };
        const at = "2026-11-02T16:00:00.000Z";
        const items: MeetingItem[] = [
            {
                kind: "speaker-range",
                id: "i1",
                status: "suggested",
                label: "Speaker 2",
                fromSec: 5,
                toSec: 5,
                speaker: "Bob Example",
                confidence: 0.8,
                rules: ["agent"],
                evidence: { reason: "answers Alice", transcriptLine: 1 },
                suggestedAt: at,
            },
            {
                kind: "speaker-range",
                id: "i2",
                status: "suggested",
                label: "Speaker 2",
                fromSec: 10,
                toSec: 10,
                speaker: "Bob Example",
                confidence: 0.5,
                rules: ["agent"],
                evidence: { reason: "the same voice", transcriptLine: 2 },
                suggestedAt: at,
            },
            {
                kind: "term",
                id: "i3",
                status: "suggested",
                atSec: 10,
                heard: "apí",
                proposed: "API",
                confidence: 0.9,
                rules: ["agent"],
                evidence: { reason: "a developer word" },
                suggestedAt: at,
            },
            {
                kind: "question",
                id: "i4",
                status: "suggested",
                about: "speaker",
                fromSec: 10,
                toSec: 10,
                question: "Who asks about the API?",
                choices: ["Bob Example", "Carol Example"],
                decides: ["i2"],
                rules: ["agent"],
                suggestedAt: at,
            },
        ];
        const record = await store.create(
            {
                title: "Planning",
                start: meeting.start,
                createdBy: "new",
                participants: meeting.participants,
                sources: { wisprflow: { meetingId: "abc" } },
                items,
            },
            { command: "new", change: "test" }
        );
        // Reached through a symlink, as /tmp and /var are on macOS: Bun 1.4.2 lists such a folder once per process.
        const folder = `${mkdtempSync(join(tmpdir(), "meetings-polish-"))}-link`;
        symlinkSync(folder.replace(/-link$/, ""), folder, "junction");
        const file = join(folder, "Planning.polished.ts");
        const config = {
            title: "Planning",
            parts: [{ record: record.id, token: "t" }],
            summary: { md: "- Decided at [[t:00:05]]." },
            unresolved: [
                {
                    id: "U1",
                    record: record.id,
                    at: "00:10",
                    heard: "apí",
                    sentence: "Mám otázku k apí.",
                    readings: ["API"],
                },
            ],
            openQuestions: { intro: "Ask Bob." },
        };
        writeFileSync(
            file,
            `import { defineMeetingsPolished } from ${SafeJSON.stringify(POLISHED_MODULE)};\nexport default defineMeetingsPolished(${SafeJSON.stringify(config)});\n`
        );
        const moduleBefore = statSync(file).mtimeMs;
        const recordBefore = readFileSync(store.path(record.id), "utf8");
        const linked = () => ({ source: fakeSource(meeting), sourceMeetingId: "abc" });

        const first = await buildPolished({ file, store, linked });
        const markdown = readFileSync(first.outPath, "utf8");

        expect(first.outcome).toBe("written");
        expect(markdown).toContain("# Planning (polished)");
        expect(markdown).toContain(
            "- 00:05 [Fake: Speaker 2] Dobře, díky.\n+ 00:05 Bob Example 80 %\n// answers Alice"
        );
        expect(markdown).toContain("| Bob Example | 1 | 0 | 1 |");
        expect(markdown).toContain("- 00:10 apí\n+ 00:10 API\n// a developer word 90 %");
        expect(markdown).toContain("**U1** `00:10`");
        expect(markdown).toContain("- b) něco jiného");
        expect(markdown).toContain(`### Open (1, record ${record.id})`);
        expect(markdown).toContain("- **Q1** `00:10`");
        expect(markdown).toContain("json2md:stamp");

        expect((await buildPolished({ file, store, linked })).outcome).toBe("unchanged");
        expect((await buildPolished({ file, store, linked, mode: "check" })).check?.verdict).toBe("clean");

        writeFileSync(first.outPath, markdown.replace("## Summary", "## Summary\n\nA hand edit."));
        expect((await buildPolished({ file, store, linked })).outcome).toBe("refused");
        expect((await buildPolished({ file, store, linked, mode: "check" })).check?.verdict).toBe("hand-edited");
        expect((await buildPolished({ file, store, linked, force: true })).outcome).toBe("written");

        expect(statSync(file).mtimeMs).toBe(moduleBefore);
        expect(readFileSync(store.path(record.id), "utf8")).toBe(recordBefore);

        // A polished markdown with no .ts: init adopts it, and the first build writes the same body again.
        const handFolder = mkdtempSync(join(tmpdir(), "meetings-polish-hand-"));
        const handMd = join(handFolder, "Hand.polished.md");
        const written = readFileSync(first.outPath, "utf8");
        // Written by hand under the older key names, which the first build replaces with its own.
        writeFileSync(
            handMd,
            stripStamp(written)
                .body.replace(/^meeting_records:.*\n(?: {2}- .*\n)*/m, `meeting_record: ${record.id}\n`)
                .replace(/^wisprflow_ids:.*\n(?: {2}- .*\n)*/m, "wisprflow_id: abc\n")
        );
        expect(readFileSync(handMd, "utf8")).toContain(`wisprflow_id: abc\nmeeting_record: ${record.id}\n`);
        const init = await initPolished({ from: handMd, store });
        writeFileSync(
            init.path,
            readFileSync(init.path, "utf8").replace(MEETINGS_POLISHED_SPECIFIER, POLISHED_MODULE.replaceAll("\\", "/"))
        );
        expect(init.path).toBe(join(handFolder, "Hand.polished.ts"));
        expect((await buildPolished({ file: init.path, store, linked })).outcome).toBe("refused");
        expect((await buildPolished({ file: init.path, store, linked, force: true })).outcome).toBe("written");
        const rebuiltFront = splitFrontmatter(stripStamp(readFileSync(handMd, "utf8")).body).raw ?? "";
        expect(rebuiltFront).toContain("meeting_records:");
        expect(rebuiltFront).toContain("wisprflow_ids:");
        expect(rebuiltFront).not.toMatch(/^(meeting_record|wisprflow_id):/m);
        expect(splitFrontmatter(stripStamp(readFileSync(handMd, "utf8")).body).body.trimEnd()).toBe(
            splitFrontmatter(stripStamp(written).body).body.trimEnd()
        );

        // The phrases follow the file's language; a language with no block in the config writes English and says so.
        for (const [language, expected, warns] of [
            ["en", "- b) something else", false],
            ["de", "- b) something else", true],
        ] as const) {
            // A module written after the first build, in the folder the process imported from already.
            const other = join(folder, `Planning-${language}.polished.ts`);
            writeFileSync(
                other,
                `import { defineMeetingsPolished } from ${SafeJSON.stringify(POLISHED_MODULE)};\nexport default defineMeetingsPolished(${SafeJSON.stringify({ ...config, language })});\n`
            );
            const built = await buildPolished({ file: other, store, linked });

            expect(readFileSync(built.outPath, "utf8")).toContain(expected);
            expect(built.warnings.some((warning) => warning.includes(`languages.${language}`))).toBe(warns);
        }
    });
});
