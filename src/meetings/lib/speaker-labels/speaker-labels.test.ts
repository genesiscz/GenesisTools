import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { meetingsConfigSchema } from "@genesiscz/utils/meetings/config";
import { type MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import type { SourceMeeting } from "@genesiscz/utils/meetings/sources";
import { Storage } from "@genesiscz/utils/storage/storage";
import type { WordCheck } from "@genesiscz/utils/transcribe/languages/word-check";
import { OpenedMeeting } from "../opened-meeting";
import { runSuggest } from "../suggest-run";

const START = "2026-11-01T10:00:00.000Z";
const spies: Array<{ mockRestore(): void }> = [];
let stores = 0;

afterEach(() => {
    for (const spy of spies.splice(0).reverse()) {
        spy.mockRestore();
    }
});

async function runnerFixture(fields: Partial<MeetingRecord> = {}) {
    const store = new MeetingStore(new Storage(`speaker-label-tests-${++stores}`));
    const record = await store.create(
        { title: "Planning", start: START, createdBy: "new", ...fields },
        { command: "new", change: "created fixture" }
    );
    const meeting: SourceMeeting = {
        sourceMeetingId: "planning",
        title: "Planning",
        start: START,
        participants: [],
        speakers: [],
        transcript: [],
        folders: [],
    };
    const config = meetingsConfigSchema.parse({});
    const opened = OpenedMeeting.of(store, record);
    spies.push(
        spyOn(OpenedMeeting, "of").mockReturnValue(opened),
        spyOn(opened, "collect").mockResolvedValue({ record, notes: [] }),
        spyOn(opened, "meeting").mockResolvedValue(meeting),
        spyOn(opened, "config").mockResolvedValue(config),
        spyOn(opened, "evidence").mockResolvedValue(null),
        spyOn(opened, "energy").mockResolvedValue({}),
        spyOn(opened, "suggestionPresence").mockResolvedValue([]),
        spyOn(opened, "presence").mockResolvedValue([]),
        spyOn(opened, "sound").mockResolvedValue({ tracks: [], slice: () => undefined }),
        spyOn(opened, "dictionary").mockResolvedValue({ abbrExpansion: "every", entries: [] }),
        spyOn(opened, "sourceWords").mockResolvedValue([]),
        spyOn(opened, "summaryPoints").mockResolvedValue([]),
        spyOn(opened, "audioPath").mockRejectedValue(new Error("fixture has no sound"))
    );
    return { store, record, opened, meeting, config };
}

describe("suggest runner word settings", () => {
    test("the configured occurrence minimum reaches both word questions and retirement", async () => {
        const fixture = await runnerFixture();
        const { store, record, opened, meeting, config } = fixture;
        config.global.suggest.words.minOccurrences = 3;
        config.global.suggest.questionCap = 0;
        meeting.transcript = [
            { speaker: "Speaker 1", startSec: 0, text: "We use zorbax and glorpix here." },
            { speaker: "Speaker 1", startSec: 10, text: "We use zorbax and glorpix again." },
            { speaker: "Speaker 1", startSec: 20, text: "We use glorpix once more." },
        ];
        const unknown = new Set(["zorbax", "glorpix", "mobilce", "mobilkou"]);
        const check: WordCheck = {
            provider: "fixture",
            language: "cs",
            verdict: (word) =>
                unknown.has(word.toLowerCase()) ? { class: "unknown", count: 0 } : { class: "dictionary", count: 9 },
            dispose: () => undefined,
        };
        spies.push(spyOn(opened, "wordCheck").mockResolvedValue({ check }));
        await store.update(record.id, { command: "fixture", change: "old family terms" }, (current) => {
            current.items.push(
                ...["mobilce", "mobilkou"].map((heard, index) => ({
                    id: `i${index + 1}`,
                    kind: "term" as const,
                    heard,
                    status: "suggested" as const,
                    suggestedAt: START,
                    rules: [MeetingRule.UnknownWord],
                    evidence: { occurrences: index === 0 ? 2 : 1 },
                }))
            );
        });
        const result = await runSuggest({ store, record: store.read(record.id)!, rules: ["terms"] });
        expect(result.fresh.filter((item) => item.kind === "question").map((item) => item.heard)).toEqual(["glorpix"]);
        expect(result.retired).toContain("i1");
        const reopened = new MeetingStore(store.storage).read(record.id)!;
        expect(reopened.items.find((item) => item.id === "i1")?.status).toBe("rejected");
        expect(reopened.items.some((item) => item.kind === "question" && item.heard === "zorbax")).toBe(false);
    });

    test("twelve open word questions leave room for a long-stretch question", async () => {
        const { store, record, meeting, config } = await runnerFixture();
        config.global.suggest.questionCap = 12;
        config.global.suggest.longStretchWords = 1;
        meeting.transcript = [
            {
                speaker: "Speaker 1",
                startSec: 0,
                text: "We should review this long passage together before deciding who will take the next step.",
            },
        ];
        await store.update(record.id, { command: "fixture", change: "open word questions" }, (current) => {
            current.items.push({
                id: "i13",
                kind: "speaker-range",
                label: "Speaker 1",
                speaker: "Alice Example",
                fromSec: 0,
                toSec: 0,
                confidence: 0.65,
                status: "suggested",
                suggestedAt: START,
                rules: [MeetingRule.Channel],
            });
            current.items.push(
                ...Array.from({ length: 12 }, (_, index) => ({
                    id: `i${index + 1}`,
                    kind: "question" as const,
                    about: "term" as const,
                    group: "words" as const,
                    fromSec: 100 + index,
                    toSec: 101 + index,
                    question: "Which word?",
                    choices: [],
                    decides: [],
                    status: "suggested" as const,
                    suggestedAt: START,
                    rules: [MeetingRule.UnknownWord],
                }))
            );
        });
        const result = await runSuggest({ store, record: store.read(record.id)!, rules: ["evidence"] });
        expect(result.fresh.filter((item) => item.kind === "question" && item.group === "long-stretch")).toHaveLength(
            1
        );
        const reopened = new MeetingStore(store.storage).read(record.id)!;
        expect(reopened.items.filter((item) => item.kind === "question" && item.group === "words")).toHaveLength(12);
        expect(reopened.items.filter((item) => item.kind === "question" && item.group === "long-stretch")).toHaveLength(
            1
        );
    });
});
