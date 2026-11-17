import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { meetingsConfigSchema } from "@genesiscz/utils/meetings/config";
import { type MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import type { SourceMeeting } from "@genesiscz/utils/meetings/sources";
import { Storage } from "@genesiscz/utils/storage/storage";
import type { WordCheck } from "@genesiscz/utils/transcribe/languages/word-check";
import { OpenedMeeting } from "../opened-meeting";
import { suggestItems } from "../suggest";
import { runSuggest } from "../suggest-run";
import { correctTranscript } from "../transcript-corrections";
import { mergeLineLabels, proposeSpeakerLabels } from "./index";
import { seatLabeler } from "./seat";
import type { LabelContext, LineLabel } from "./types";

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

function labelContext(attended: LabelContext["attended"]): LabelContext {
    return {
        lines: [
            { index: 0, fromSec: 0, toSec: 10, seat: "mic" },
            { index: 1, fromSec: 10, toSec: 20, seat: "call" },
            { index: 2, fromSec: 20, toSec: 30, seat: "mic" },
        ],
        attended,
        sound: { tracks: [], slice: () => undefined },
        project: undefined,
    };
}

const alice = { person: "Alice Example", seat: "mic" as const, fromSec: 0, toSec: 30 };
const bob = { person: "Bob Example", seat: "call" as const, fromSec: 0, toSec: 30 };

describe("seat labeler", () => {
    test("one attended person per seat names every line on that seat, without writing", async () => {
        const context = labelContext([alice, bob]);
        const before = structuredClone(context.attended);
        const labels = await seatLabeler.propose(context);
        expect(labels.map((label) => [label.person, label.reason])).toEqual([
            ["Alice Example", "seat-of-one"],
            ["Bob Example", "seat-of-one"],
            ["Alice Example", "seat-of-one"],
        ]);
        expect(context.attended).toEqual(before);
        expect(seatLabeler.rule).toBe(MeetingRule.Attendance);
    });

    test("two people sharing a seat name none of that seat's lines", async () => {
        const labels = await seatLabeler.propose(labelContext([alice, { ...alice, person: "Carol Example" }, bob]));
        expect(labels.filter((label) => label.seat === "mic").map((label) => [label.person, label.reason])).toEqual([
            [undefined, "seat-shared"],
            [undefined, "seat-shared"],
        ]);
        expect(labels[1]?.person).toBe("Bob Example");
    });

    test("unknown seats and missing attendance give no name", async () => {
        const labels = await seatLabeler.propose(labelContext([{ ...alice, seat: undefined }]));
        expect(labels.every((label) => !label.person && label.reason === "seat-unknown")).toBe(true);
    });

    test("joins and leaves bound the full line, and repeated stays are still one person", async () => {
        const labels = await seatLabeler.propose(
            labelContext([
                { ...alice, toSec: 10 },
                { ...alice, toSec: 10 },
                { ...alice, person: "Carol Example", fromSec: 20 },
                { ...bob, fromSec: 15 },
            ])
        );
        expect(labels.map((label) => label.person)).toEqual(["Alice Example", undefined, "Carol Example"]);
        expect(labels[1]?.reason).toBe("seat-unknown");
        const joined = await seatLabeler.propose(
            labelContext([alice, { ...alice, person: "Carol Example", fromSec: 5 }])
        );
        expect(joined[0]?.reason).toBe("seat-shared");
    });

    test("merge keeps seat ownership ahead of another name, but a stranger veto removes it", () => {
        const owned: LineLabel = {
            labeler: "seat",
            index: 0,
            seat: "mic",
            person: "Alice Example",
            reason: "seat-of-one",
        };
        const named: LineLabel = { ...owned, person: "Bob Example", reason: "named", score: 0.8 };
        expect(mergeLineLabels(new Map([["seat", [named, owned]]]))).toEqual([owned]);
        const veto: LineLabel = { ...owned, person: undefined, reason: "not-the-seat-person", score: 0.2 };
        expect(mergeLineLabels(new Map([["seat", [owned, veto]]]))).toEqual([veto]);
    });
});

describe("speaker-label integration", () => {
    test("the registry reads channels and seat attendance, respects seat times, and honors disabled labelers", async () => {
        const { opened, meeting, config } = await runnerFixture({
            seats: { room: ["Alice Example"], remote: [{ name: "Bob Example", fromSec: 15 }] },
        });
        meeting.transcript = [0, 10, 20, 30].map((startSec) => ({ speaker: "Speaker 1", startSec, text: "A line." }));
        spies.push(
            spyOn(opened, "evidence").mockResolvedValue({
                segments: [
                    { startSec: 0, endSec: 10, channel: "mic" },
                    { startSec: 10, endSec: 30, channel: "system" },
                ],
                speaking: [],
                files: [],
            }),
            spyOn(opened, "presence").mockResolvedValue([
                { name: "Alice Example", fromSec: 0, toSec: 35 },
                { name: "Bob Example", fromSec: 0, toSec: 35 },
            ])
        );
        const labels = await proposeSpeakerLabels(opened, config.global.speakerLabels);
        expect(labels.map((label) => [label.index, label.seat, label.person])).toEqual([
            [0, "mic", "Alice Example"],
            [1, "call", undefined],
            [2, "call", "Bob Example"],
        ]);
        config.global.speakerLabels.seat.enabled = false;
        expect(await proposeSpeakerLabels(opened, config.global.speakerLabels)).toEqual([]);
    });

    test("an attended person with no seat entry shares the call seat, so the listed remote person is not named", async () => {
        const { opened, meeting, config } = await runnerFixture({
            seats: { room: ["Alice Example"], remote: [{ name: "Bob Example" }] },
        });
        meeting.transcript = [0, 10].map((startSec) => ({ speaker: "Speaker 1", startSec, text: "A line." }));
        spies.push(
            spyOn(opened, "evidence").mockResolvedValue({
                segments: [
                    { startSec: 0, endSec: 10, channel: "mic" },
                    { startSec: 10, endSec: 20, channel: "system" },
                ],
                speaking: [],
                files: [],
            }),
            spyOn(opened, "presence").mockResolvedValue([
                { name: "Alice Example", fromSec: 0, toSec: 25 },
                { name: "Bob Example", fromSec: 0, toSec: 25 },
                { name: "Carol Example", fromSec: 0, toSec: 25 },
            ])
        );
        const labels = await proposeSpeakerLabels(opened, config.global.speakerLabels);
        expect(labels.map((label) => [label.seat, label.person, label.reason])).toEqual([
            ["mic", "Alice Example", "seat-of-one"],
            ["call", undefined, "seat-shared"],
        ]);
    });

    test("labels win over platform and reference names; confirmed ranges remain unchanged", async () => {
        const { record, meeting, config } = await runnerFixture();
        meeting.speakers = [{ name: "Alice Example", origin: "platform", speakerId: 1 }];
        meeting.transcript = [{ speaker: "Alice Example", speakerId: 1, startSec: 0, text: "A line." }];
        record.speakers.labels["Alice Example"] = "Carol Example";
        const labels: LineLabel[] = [
            { labeler: "seat", index: 0, seat: "call", person: "Bob Example", reason: "seat-of-one", score: 0.91 },
        ];
        const inputs = {
            record,
            meeting,
            labels,
            rules: ["speakers" as const],
            dictionary: { abbrExpansion: "every" as const, entries: [] },
            sourceWords: [],
            now: START,
        };
        const fresh = suggestItems(inputs);
        const range = fresh.find((item) => item.kind === "speaker-range");
        expect(range?.speaker).toBe("Bob Example");
        expect(range?.confidence).toBe(0.91);
        expect(range?.evidence?.score).toBe(0.91);
        record.items.push(...fresh);
        expect(
            correctTranscript({ record, transcript: meeting.transcript, config, format: "txt", withSuggested: true })
                .entries[0]?.speaker
        ).toBe("Bob Example");
        expect(suggestItems(inputs)).toEqual([]);
        if (!range) {
            throw new Error("missing label range");
        }
        range.status = "confirmed";
        const before = structuredClone(range);
        expect(suggestItems({ ...inputs, labels: [{ ...labels[0]!, person: "Carol Example" }] })).toEqual([]);
        expect(range).toEqual(before);
    });

    test("an agreeing old channel rule joins the item, while a different person gives one question even on a short line", async () => {
        const { record, meeting } = await runnerFixture({
            participants: [{ name: "Alice Example", self: true, from: ["fixture"] }],
        });
        meeting.transcript = [{ speaker: "Speaker 1", startSec: 0, text: "Yes." }];
        const inputs = {
            record,
            meeting,
            rules: ["evidence" as const],
            evidence: {
                selfName: "Alice Example",
                segments: [{ startSec: 0, endSec: 5, channel: "mic" as const }],
                speaking: [],
                files: [],
            },
            energyMicShare: () => 1,
            dictionary: { abbrExpansion: "every" as const, entries: [] },
            sourceWords: [],
            now: START,
        };
        const labels: LineLabel[] = [
            { labeler: "seat", index: 0, seat: "mic", person: "Alice Example", reason: "seat-of-one" },
        ];
        const agreed = suggestItems({ ...inputs, labels }).filter((item) => item.kind === "speaker-range");
        expect(agreed).toHaveLength(1);
        expect(agreed[0]?.rules).toContain(MeetingRule.Attendance);
        expect(agreed[0]?.rules).toContain(MeetingRule.Channel);
        const fresh = suggestItems({ ...inputs, labels: [{ ...labels[0]!, person: "Bob Example" }] });
        const ranges = fresh.filter((item) => item.kind === "speaker-range");
        const questions = fresh.filter((item) => item.kind === "question");
        expect(ranges).toHaveLength(1);
        expect(ranges[0]?.speaker).toBeUndefined();
        expect(questions).toHaveLength(1);
        expect(questions[0]?.choices).toEqual(expect.arrayContaining(["Alice Example", "Bob Example"]));
        expect(questions[0]?.decides).toEqual([ranges[0]!.id]);
        record.items.push(...fresh);
        expect(suggestItems({ ...inputs, labels: [{ ...labels[0]!, person: "Bob Example" }] })).toEqual([]);
    });

    test("runSuggest saves seat proposals once and a reopened store adds none on the second pass", async () => {
        const { store, record, opened, meeting } = await runnerFixture({
            seats: { room: ["Alice Example"], remote: [{ name: "Bob Example" }] },
        });
        meeting.transcript = [0, 10].map((startSec) => ({ speaker: "Speaker 1", startSec, text: "A line." }));
        spies.push(
            spyOn(opened, "evidence").mockResolvedValue({
                segments: [{ startSec: 0, endSec: 15, channel: "mic" }],
                speaking: [],
                files: [],
            }),
            spyOn(opened, "presence").mockResolvedValue([{ name: "Alice Example", fromSec: 0, toSec: 15 }])
        );
        const first = await runSuggest({ store, record, rules: ["speakers"] });
        expect(first.fresh.filter((item) => item.kind === "speaker-range")).toHaveLength(2);
        const reopened = new MeetingStore(store.storage).read(record.id)!;
        expect(reopened.items.filter((item) => item.kind === "speaker-range").map((item) => item.speaker)).toEqual([
            "Alice Example",
            "Alice Example",
        ]);
        const second = await runSuggest({ store, record: reopened, rules: ["speakers"] });
        expect(second.fresh).toEqual([]);
        expect(new MeetingStore(store.storage).read(record.id)?.items).toEqual(reopened.items);
    });
});
