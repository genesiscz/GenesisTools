import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, linkSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AreaClients } from "@genesiscz/utils/genesis-tools";
import { meetingsConfigSchema } from "@genesiscz/utils/meetings/config";
import { type MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import type { SourceMeeting } from "@genesiscz/utils/meetings/sources";
import * as voiceFeatures from "@genesiscz/utils/meetings/voice-features";
import { PROFILER_SCOPE_NAMES, profiler } from "@genesiscz/utils/profile";
import { Storage } from "@genesiscz/utils/storage/storage";
import type { WordCheck } from "@genesiscz/utils/transcribe/languages/word-check";
import { groupTurns, transcriptMarkdown, transcriptTextLines } from "@genesiscz/utils/transcribe/render";
import { OpenedMeeting } from "../opened-meeting";
import { questionView } from "../questions";
import { reviewRow } from "../review-rows";
import { suggestItems } from "../suggest";
import { runSuggest } from "../suggest-run";
import { correctTranscript } from "../transcript-corrections";
import * as labelers from "./index";
import { mergeLineLabels, proposeSpeakerLabels } from "./index";
import { seatLabeler } from "./seat";
import type { LabelContext, LineLabel } from "./types";
import { voiceWorkerSettings, voiceWorkerStart } from "./voice";

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
        spyOn(opened, "suggestionPresence").mockImplementation((options) =>
            opened.presence(options.attendance, options.attendanceId)
        ),
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
    test("suggest reopens identical voice frames and decodes again only for stale or damaged evidence", async () => {
        const { store, record, opened } = await runnerFixture();
        const folder = store.folder(record.id);
        const audioPath = join(folder, "source.wav");
        const cachePath = join(folder, "evidence", "voice-frames.bin");
        const stamp = new Date("2026-01-01T10:00:00Z");
        writeFileSync(audioPath, "audio");
        utimesSync(audioPath, stamp, stamp);
        const left = { rms: 1 / 3, lowBandShare: 1 / 7, tilt: 1 / 9, pitchHz: 8000 / 51, voicedShare: 1 };
        const right = { rms: 0, lowBandShare: 0, tilt: 0, pitchHz: null, voicedShare: 0 };
        const frames = [{ channels: [left, right] }, { channels: [right, left] }];
        const source = spyOn(opened, "audioPath").mockResolvedValue(audioPath);
        const decode = spyOn(voiceFeatures, "voiceFrames").mockResolvedValue(frames);
        const aggregate = spyOn(voiceFeatures, "lineVoices");
        spies.push(source, decode, aggregate);
        const suggest = () => runSuggest({ store, record, rules: ["evidence"] });

        await suggest();
        await suggest();
        expect(decode).toHaveBeenCalledTimes(1);
        expect(aggregate.mock.calls.map(([input]) => input.frames)).toEqual([frames, frames]);
        expect(aggregate.mock.calls[1]![0].frames).not.toBe(frames);

        // The new inode has the same path, size and modification time.
        const other = join(folder, "other.wav");
        writeFileSync(other, "other");
        utimesSync(other, stamp, stamp);
        renameSync(other, audioPath);
        linkSync(audioPath, other);
        decode.mockResolvedValue([{ channels: [right, left] }]);
        await Promise.all([suggest(), suggest()]);
        expect(decode).toHaveBeenCalledTimes(2);
        expect(aggregate.mock.calls.slice(-2).map(([input]) => input.frames)).toEqual([
            [{ channels: [right, left] }],
            [{ channels: [right, left] }],
        ]);

        // A different path to the same bytes and corruption in an otherwise complete file are misses too.
        source.mockResolvedValue(other);
        await suggest();
        expect(decode).toHaveBeenCalledTimes(3);
        const bytes = readFileSync(cachePath);
        bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
        writeFileSync(cachePath, bytes);
        await suggest();
        expect(decode).toHaveBeenCalledTimes(4);
    });

    test("suggest records collection, the selected rule and the save under its registered profiler scope", async () => {
        const { store, record } = await runnerFixture();
        const scope = profiler.scope("meetings-suggest");
        const measured = spyOn(scope, "measureAsync");
        const sections = spyOn(scope, "section");
        spies.push(measured, sections);
        await runSuggest({ store, record, rules: ["terms"], wordCheck: "off" });
        expect(PROFILER_SCOPE_NAMES).toContain("meetings-suggest");
        expect(measured.mock.calls.map(([label]) => label)).toContain("collectForSuggest");
        expect(sections.mock.calls.map(([label]) => label)).toEqual(
            expect.arrayContaining(["rule.terms", "save", "run"])
        );
    });

    test("seat lines use the segment share before energy and skip evidence unrelated to a seat", async () => {
        const { opened, meeting, config } = await runnerFixture();
        config.global.speakerLabels.seat.enabled = true;
        config.global.speakerLabels.voice.enabled = false;
        meeting.transcript = [0, 5, 10].map((startSec) => ({ speaker: "Speaker 1", startSec, text: "A line." }));
        const share = Object.assign(
            mock(() => 0.1),
            { acoustic: mock(() => undefined) }
        );
        spies.push(
            spyOn(opened, "energy").mockResolvedValue({ share }),
            spyOn(opened, "evidence").mockResolvedValue({
                files: [],
                speaking: [],
                segments: [
                    { startSec: 0, endSec: 10, channel: "mic" },
                    { startSec: 5, endSec: 10, channel: "system" },
                ],
            })
        );
        const labels = await proposeSpeakerLabels(opened, config.global.speakerLabels);
        expect(labels.map(({ index, seat }) => [index, seat])).toEqual([
            [0, "mic"],
            [2, "call"],
        ]);
        expect(share).toHaveBeenCalledTimes(1);
        expect(share.acoustic).not.toHaveBeenCalled();
    });

    test("a speakers-only run does not read term dictionaries or open sound for the seat labeler", async () => {
        const { opened, store, record, meeting, config } = await runnerFixture({
            seats: { room: ["Alice Example"], remote: [] },
        });
        config.global.speakerLabels.voice.enabled = false;
        meeting.transcript = [{ speaker: "Speaker 1", startSec: 0, text: "A line." }];
        spies.push(
            spyOn(opened, "evidence").mockResolvedValue({
                files: [],
                segments: [{ startSec: 0, endSec: 5, channel: "mic" }],
                speaking: [],
            }),
            spyOn(opened, "presence").mockResolvedValue([{ name: "Alice Example", fromSec: 0, toSec: 5 }])
        );

        const result = await runSuggest({ store, record, rules: ["speakers"] });
        expect(result.warnings).toEqual([]);
        expect(new MeetingStore(store.storage).read(record.id)?.items).toContainEqual(
            expect.objectContaining({ kind: "speaker-range", speaker: "Alice Example" })
        );
        expect(opened.dictionary).not.toHaveBeenCalled();
        expect(opened.sourceWords).not.toHaveBeenCalled();
        expect(opened.sound).not.toHaveBeenCalled();
        expect(opened.presence).toHaveBeenCalledTimes(1);
    });

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

    test("an agent's run that leaves word questions posts one window notice; other runs and callers post none", async () => {
        const { store, record, opened, meeting, config } = await runnerFixture();
        config.global.suggest.words.minOccurrences = 2;
        config.global.suggest.questionCap = 0;
        const check: WordCheck = {
            provider: "fixture",
            language: "cs",
            verdict: (word) =>
                word.toLowerCase() === "glorpix" ? { class: "unknown", count: 0 } : { class: "dictionary", count: 9 },
            dispose: () => undefined,
        };
        spies.push(spyOn(opened, "wordCheck").mockResolvedValue({ check }));
        type WindowNotice = AreaClients["person"]["windowNotice"];
        const windowNotice = mock(
            async (args: Parameters<WindowNotice>[0]): ReturnType<WindowNotice> => ({
                status: "ran",
                via: "native",
                skipped: [],
                value: { id: args.id, status: "pending", reason: null },
            })
        );
        const gt = { person: { windowNotice } };
        const agent = { kind: "agent" as const, harness: "fixture", session: "session-1" };

        meeting.transcript = [{ speaker: "Speaker 1", startSec: 0, text: "Plain words only." }];
        const plain = await runSuggest({ store, record, rules: ["terms"], actor: agent, gt });
        expect(plain.fresh).toEqual([]);
        expect(windowNotice).not.toHaveBeenCalled();

        meeting.transcript = [
            { speaker: "Speaker 1", startSec: 0, text: "We use glorpix here." },
            { speaker: "Speaker 1", startSec: 10, text: "We use glorpix again." },
        ];
        await runSuggest({ store, record: store.read(record.id)!, rules: ["terms"], actor: { kind: "cli" }, gt });
        expect(windowNotice).not.toHaveBeenCalled();

        const asked = await runSuggest({ store, record: store.read(record.id)!, rules: ["terms"], actor: agent, gt });
        expect(asked.warnings).toEqual([]);
        expect(windowNotice).toHaveBeenCalledTimes(1);
        expect(windowNotice.mock.calls[0]?.[0].open).toEqual({
            window: "--meetings",
            args: ["--meeting", record.id, "--tab", "items"],
        });
    });

    test("a test process posts nothing real: without a fake the person area refuses and the run only warns", async () => {
        const { store, record, opened, meeting, config } = await runnerFixture();
        config.global.suggest.words.minOccurrences = 1;
        const check: WordCheck = {
            provider: "fixture",
            language: "cs",
            verdict: () => ({ class: "unknown", count: 0 }),
            dispose: () => undefined,
        };
        spies.push(spyOn(opened, "wordCheck").mockResolvedValue({ check }));
        meeting.transcript = [{ speaker: "Speaker 1", startSec: 0, text: "glorpix" }];
        const result = await runSuggest({
            store,
            record,
            rules: ["terms"],
            actor: { kind: "agent", harness: "fixture", session: "session-1" },
        });
        expect(result.fresh.some((item) => item.kind === "question")).toBe(true);
        expect(result.warnings).toEqual([expect.stringContaining("The meeting review request could not reach you")]);
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
    test("a stranger stretch asks once, withdraws old seat proposals, and preserves confirmed lines after reopen", async () => {
        const { store, record, meeting, config } = await runnerFixture({
            participants: [
                { name: "Alice Example", self: true, from: ["fixture"] },
                { name: "Bob Example", from: ["fixture"] },
            ],
            seats: { room: ["Alice Example"], remote: [{ name: "Bob Example" }] },
        });
        meeting.transcript = [0, 10, 20, 30].map((startSec) => ({ speaker: "Speaker 1", startSec, text: "Yes." }));
        await store.update(record.id, { command: "fixture", change: "old proposals" }, (current) => {
            current.items.push(
                {
                    id: "i1",
                    kind: "speaker-range",
                    label: "Speaker 1",
                    fromSec: 0,
                    toSec: 30,
                    speaker: "Alice Example",
                    confidence: 0.95,
                    status: "suggested",
                    rules: [MeetingRule.Attendance],
                    suggestedAt: START,
                },
                {
                    id: "i2",
                    kind: "speaker-range",
                    label: "Speaker 1",
                    fromSec: 20,
                    toSec: 20,
                    speaker: "Bob Example",
                    confidence: 1,
                    status: "confirmed",
                    rules: [],
                    suggestedAt: START,
                }
            );
        });
        const labels: LineLabel[] = [0, 1, 2].map((index) => ({
            labeler: "voice",
            index,
            seat: "mic",
            reason: "not-the-seat-person",
            score: 0.2,
            next: { person: "Alice Example", score: 0.2 },
        }));
        spies.push(spyOn(labelers, "proposeSpeakerLabels").mockResolvedValue(labels));
        const confirmed = structuredClone(store.read(record.id)!.items.find((item) => item.id === "i2"));
        const first = await runSuggest({ store, record: store.read(record.id)!, rules: ["speakers"] });
        expect(first.retired).toContain("i1");
        const reopened = new MeetingStore(store.storage).read(record.id)!;
        const asked = reopened.items.filter((item) => item.kind === "question");
        expect(asked).toHaveLength(1);
        expect(asked[0]).toMatchObject({
            about: "speaker",
            status: "suggested",
            fromSec: 0,
            toSec: 20,
            question: "This does not sound like Alice Example. Who is speaking?",
            choices: ["Alice Example", "Bob Example"],
        });
        const ranges = reopened.items.filter((item) => asked[0]!.decides.includes(item.id));
        expect(ranges).toHaveLength(2);
        expect(ranges.every((item) => item.kind === "speaker-range" && !item.speaker)).toBe(true);
        expect(reopened.items.find((item) => item.id === "i2")).toEqual(confirmed);
        const corrected = correctTranscript({
            record: reopened,
            transcript: meeting.transcript,
            config,
            format: "txt",
            withSuggested: true,
        });
        expect(
            corrected.entries
                .slice(0, 2)
                .every((entry) => entry.speaker !== "Alice Example" && entry.speaker !== "Bob Example")
        ).toBe(true);
        expect(corrected.entries[2]?.speaker).toBe("Bob Example");
        expect(corrected.entries[3]?.speaker).toBe("Alice Example");
        const second = await runSuggest({ store, record: reopened, rules: ["speakers"] });
        expect(second.fresh).toEqual([]);
        expect(second.retired).toEqual([]);
        expect(new MeetingStore(store.storage).read(record.id)?.items).toEqual(reopened.items);
    });

    test("a voice goodbye reaches the departure reason in the suggestion pass", async () => {
        const { record, meeting } = await runnerFixture({
            participants: [{ name: "Alice Example", self: true, from: ["fixture"] }],
        });
        meeting.transcript = [
            { speaker: "Speaker 1", startSec: 0, text: "Goodbye, I have to go now." },
            { speaker: "Speaker 1", startSec: 60, text: "We continue our discussion." },
        ];
        const fresh = suggestItems({
            record,
            meeting,
            rules: ["speakers"],
            now: START,
            dictionary: { abbrExpansion: "every", entries: [] },
            sourceWords: [],
            evidence: { segments: [{ startSec: 0, endSec: 70, channel: "system" }], speaking: [], files: [] },
            presence: ["Bob Example", "Carol Example"].map((name) => ({
                name,
                fromSec: 0,
                toSec: 100,
                leftAtExact: false,
            })),
            labels: [{ labeler: "voice", index: 0, seat: "call", person: "Bob Example", score: 0.81, reason: "named" }],
        });
        expect(
            fresh.some(
                (item) =>
                    item.evidence?.departure &&
                    typeof item.evidence.departure === "object" &&
                    "reason" in item.evidence.departure &&
                    item.evidence.departure.reason === "voice"
            )
        ).toBe(true);
    });

    test("voice names carry their source and score through transcript, rows and listen; human names do not", async () => {
        const { record, meeting, config } = await runnerFixture();
        meeting.transcript = [0, 10].map((startSec) => ({
            speaker: "Speaker 1",
            startSec,
            text: "We should decide what to do next.",
        }));
        const fresh = suggestItems({
            record,
            meeting,
            rules: ["speakers"],
            now: START,
            dictionary: { abbrExpansion: "every", entries: [] },
            sourceWords: [],
            labels: [0, 1].map((index) => ({
                labeler: "voice",
                index,
                seat: "call",
                person: "Bob Example",
                score: 0.81,
                reason: "named",
            })),
        });
        record.items.push(...fresh);
        const corrected = correctTranscript({
            record,
            transcript: meeting.transcript,
            config,
            format: "txt",
            withSuggested: true,
        });
        expect(corrected.entries[0]).toMatchObject({ nameSource: "voice", nameScore: 0.81 });
        expect(transcriptTextLines(groupTurns(corrected.entries), true).join("\n")).toContain("by voice 0.81");
        expect(transcriptMarkdown(groupTurns(corrected.entries), true)).toContain("by voice 0.81");
        const range = record.items.find((item) => item.kind === "speaker-range")!;
        expect(reviewRow(record, range).what).toContain("by voice 0.81");
        const question = {
            id: "i90",
            kind: "question" as const,
            about: "speaker" as const,
            status: "suggested" as const,
            fromSec: 0,
            toSec: 10,
            question: "Who speaks?",
            choices: ["Bob Example", "Alice Example"],
            decides: [range.id],
            rules: [],
            suggestedAt: START,
        };
        record.items.push(question);
        expect(questionView(record, question, corrected.entries, 240).question).toContain("by voice 0.81");
        expect(reviewRow(record, question, corrected.entries).parts).toContainEqual(
            expect.objectContaining({
                kind: "asks",
                pieces: expect.arrayContaining([
                    expect.objectContaining({ text: expect.stringContaining("by voice 0.81") }),
                ]),
            })
        );
        range.status = "confirmed";
        const human = correctTranscript({
            record,
            transcript: meeting.transcript,
            config,
            format: "txt",
            withSuggested: true,
        });
        expect(human.entries[0]?.nameSource).toBeUndefined();
        expect(
            correctTranscript({ record, transcript: meeting.transcript, config, format: "txt" }).entries[1]?.nameSource
        ).toBeUndefined();
        record.speakers.assignments = [
            { id: "a1", label: "Speaker 1", fromSec: 10.2, toSec: 10.2, person: "Carol Example", at: START },
        ];
        const assigned = correctTranscript({
            record,
            transcript: meeting.transcript,
            config,
            format: "txt",
            withSuggested: true,
        });
        expect(assigned.entries[1]?.nameSource).toBeUndefined();
    });

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

    test("a voice name a person rejected (Not this person) is not suggested again for that line", async () => {
        const { record, meeting } = await runnerFixture();
        meeting.speakers = [{ name: "Speaker 1", origin: "platform", speakerId: 1 }];
        meeting.transcript = [{ speaker: "Speaker 1", speakerId: 1, startSec: 4, text: "A line." }];
        const named: LineLabel = {
            labeler: "voice",
            index: 0,
            seat: "call",
            person: "Bob Example",
            reason: "named",
            score: 0.71,
        };
        const inputs = {
            record,
            meeting,
            labels: [named],
            rules: ["speakers" as const],
            dictionary: { abbrExpansion: "every" as const, entries: [] },
            sourceWords: [],
            now: START,
        };
        const first = suggestItems(inputs).find((item) => item.kind === "speaker-range");
        expect(first?.speaker).toBe("Bob Example");
        expect(first?.rules).toContain(MeetingRule.VoiceEmbedding);
        expect(reviewRow(record, first!).choices.map((choice) => [choice.label, choice.action.kind])).toContainEqual([
            "Not this person",
            "reject",
        ]);
        record.items.push({ ...first!, status: "rejected", decidedAt: START });
        expect(suggestItems(inputs).filter((item) => item.kind === "speaker-range")).toEqual([]);
        const other = suggestItems({ ...inputs, labels: [{ ...named, person: "Carol Example" }] });
        expect(other.find((item) => item.kind === "speaker-range")?.speaker).toBe("Carol Example");
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

describe("voice worker start", () => {
    test("normal starts Bun directly and clears background in the worker; background is taskpolicy -b", () => {
        expect(voiceWorkerStart("normal")).toEqual({ prefix: [], clearBackground: true });
        const background = voiceWorkerStart("background");
        expect(background.clearBackground).toBe(false);
        expect(background.prefix).toEqual(existsSync("/usr/sbin/taskpolicy") ? ["/usr/sbin/taskpolicy", "-b"] : []);
    });

    test("auto workers read the free cores once: a busy Mac gets one worker, idle cores up to four", async () => {
        const config = meetingsConfigSchema.parse({});
        let reads = 0;
        const reading = (idleCores: number) => async () => {
            reads++;
            return { performanceCores: 12, idleCores };
        };
        expect((await voiceWorkerSettings(config, reading(7.9))).workers).toBe(4);
        expect((await voiceWorkerSettings(config, reading(0.3))).workers).toBe(1);
        expect(reads).toBe(2);
        const fixed = meetingsConfigSchema.parse({
            global: { speakerLabels: { voice: { compute: { priority: "background", workers: 3 } } } },
        });
        const settings = await voiceWorkerSettings(fixed, reading(0));
        expect(settings.workers).toBe(3);
        expect(settings.clearBackground).toBe(false);
        expect(reads).toBe(2);
    });
});
