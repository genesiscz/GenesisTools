import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, linkSync, mkdtempSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import type { AreaClients } from "@genesiscz/utils/genesis-tools";
import { meetingsConfigSchema } from "@genesiscz/utils/meetings/config";
import { type MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import type { SourceMeeting } from "@genesiscz/utils/meetings/sources";
import type { ChannelEmbedding } from "@genesiscz/utils/meetings/voice";
import * as voiceEmbedding from "@genesiscz/utils/meetings/voice";
import * as voiceFeatures from "@genesiscz/utils/meetings/voice-features";
import { addVoicePrint } from "@genesiscz/utils/meetings/voice-store";
import { PROFILER_SCOPE_NAMES, profiler } from "@genesiscz/utils/profile";
import { Storage } from "@genesiscz/utils/storage/storage";
import type { WordCheck } from "@genesiscz/utils/transcribe/languages/word-check";
import { groupTurns, transcriptMarkdown, transcriptTextLines } from "@genesiscz/utils/transcribe/render";
import * as speechHistory from "../local-speech";
import { OpenedMeeting } from "../opened-meeting";
import { questionView } from "../questions";
import { rawMeeting } from "../raw";
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

    test("seat lines prefer calibrated energy, keep the segment fallback and skip unrelated evidence", async () => {
        const { opened, meeting, config } = await runnerFixture();
        config.global.speakerLabels.seat.enabled = true;
        config.global.speakerLabels.voice.enabled = false;
        meeting.transcript = [0, 5, 10, 15].map((startSec) => ({ speaker: "Speaker 1", startSec, text: "A line." }));
        const share = Object.assign(
            mock((from: number) => (from === 0 ? 0 : undefined)),
            { raw: (from: number) => (from === 5 ? 0.9 : undefined), acoustic: mock(() => undefined) }
        );
        spies.push(
            spyOn(opened, "energy").mockResolvedValue({ share }),
            spyOn(opened, "evidence").mockResolvedValue({
                files: [],
                speaking: [],
                segments: [
                    { startSec: 0, endSec: 10, channel: "mic" },
                    { startSec: 5, endSec: 10, channel: "system" },
                    { startSec: 10, endSec: 15, channel: "mic" },
                ],
            })
        );
        const labels = await proposeSpeakerLabels(opened, config.global.speakerLabels);
        expect(labels.map(({ index, seat }) => [index, seat])).toEqual([
            [0, "call"],
            [1, "mic"],
            [2, "mic"],
        ]);
        expect(share).toHaveBeenCalledTimes(4);
        expect(share.acoustic).not.toHaveBeenCalled();
    });

    test("calibrated seat answers stay below apply in the unsure band, including after reopening old answers", async () => {
        const owner = "Alice Example";
        const { opened, meeting, config, store, record } = await runnerFixture({
            seats: { room: [owner], remote: [] },
        });
        config.global.speakerLabels.voice.enabled = false;
        config.global.suggest.applyAbove = 0.45;
        meeting.transcript = [0, 5, 10, 15, 20].map((startSec) => ({ speaker: "Voice", startSec, text: "A line." }));
        const evidence = {
            selfName: owner,
            files: [],
            speaking: [],
            segments: [{ startSec: 0, endSec: 30, channel: "mic" as const }],
        };
        spies.push(spyOn(opened, "evidence").mockResolvedValue(evidence));
        const run = () => runSuggest({ store, record, rules: ["speakers", "evidence"] });
        await run();
        const shares = new Map([
            [0, 0.2],
            [5, 0.62],
            [10, 0.7],
            [20, 0.5],
        ]);
        spies.push(spyOn(opened, "energy").mockResolvedValue({ share: (from) => shares.get(from) }));
        const labels = await proposeSpeakerLabels(opened, config.global.speakerLabels);
        expect(labels.filter((label) => label.person === owner).map((label) => label.index)).toEqual([1, 2, 3]);
        const preview = await labelers.preparePreviewLabels(opened, config.global.speakerLabels, []);
        const weak = (await preview(config.global.speakerLabels.voice, 0.35)).find((label) => label.index === 1);
        expect(weak?.score).toBeLessThan(0.35);
        const allApply = await preview(config.global.speakerLabels.voice, 0);
        expect(allApply.some((label) => label.index === 1 && label.person)).toBe(false);

        // An agreeing legacy channel rule must not push the fresh seat answer over the threshold either.
        const fresh = suggestItems({
            record,
            meeting,
            labels,
            rules: ["evidence"],
            evidence,
            energyMicShare: (from) => shares.get(from),
            dictionary: { abbrExpansion: "every", entries: [] },
            sourceWords: [],
            now: START,
        });
        expect(
            fresh.find((item) => item.evidence?.reason === "seat-of-one" && item.evidence.transcriptLine === 1)
                ?.confidence
        ).toBeLessThan(0.45);

        await run();
        const savedSeats = new MeetingStore(store.storage)
            .read(record.id)!
            .items.filter((item) => item.status === "suggested" && item.evidence?.reason === "seat-of-one");
        expect(savedSeats.map((item) => item.evidence?.transcriptLine)).toEqual([1, 2, 3]);
        expect(savedSeats[0]?.confidence).toBeLessThan(0.45);
        expect(savedSeats.slice(1).map((item) => item.confidence)).toEqual([0.95, 0.95]);
    });

    test("a speakers-only voice pass saves each local speech removal once", async () => {
        const { store, record, meeting, config } = await runnerFixture();
        config.global.speakerLabels.voice.enabled = true;
        meeting.transcript = [{ startSec: 5, speaker: "Voice", text: "Fixture render complete." }];
        spies.push(
            spyOn(speechHistory, "localSpeechDuring").mockReturnValue([
                { ts: Date.parse(START) + 5000, text: "Fixture render complete" },
            ]),
            spyOn(labelers, "proposeSpeakerLabels").mockResolvedValue([
                { index: 0, seat: "mic", reason: "named", labeler: "voice", person: "Alice Example", score: 0.8 },
            ])
        );
        const run = () => runSuggest({ store, record, rules: ["speakers"] });
        await run();
        await run();
        const saved = new MeetingStore(store.storage).read(record.id)!.items;
        expect(saved.some((item) => item.rules.includes(MeetingRule.VoiceEmbedding))).toBe(true);
        expect(saved.filter((item) => item.kind === "removal")).toEqual([
            expect.objectContaining({
                confidence: 0.9,
                rules: [MeetingRule.LocalSpeech],
                evidence: { reason: "local speech output", transcriptLine: 0 },
            }),
        ]);
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

    test("a test process posts nothing real: without a fake the sandbox home sends no request and the run only warns", async () => {
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
        expect(result.warnings).toEqual([expect.stringContaining("no review request was sent")]);
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

    test("suggest asks every fifty-word speaker stretch even when ordinary questions fill the cap", async () => {
        const { store, record, meeting, config } = await runnerFixture();
        config.global.suggest.questionCap = 1;
        meeting.transcript = [0, 5, 10, 15, 20].map((startSec, index) => ({
            speaker: "Voice",
            startSec,
            text: index === 0 || index === 4 ? "words ".repeat(50).trim() : "Pause.",
        }));
        const base = { status: "suggested" as const, rules: [], suggestedAt: START };
        await store.update(record.id, { command: "test", change: "two separate stretches" }, (current) => {
            current.items.push(
                {
                    ...base,
                    kind: "question",
                    id: "i1",
                    about: "speaker",
                    question: "Who?",
                    fromSec: 40,
                    toSec: 40,
                    choices: ["River Example"],
                    decides: [],
                },
                ...[0, 20].map((sec, index) => ({
                    ...base,
                    kind: "speaker-range" as const,
                    id: `i${index + 2}`,
                    label: "Voice",
                    fromSec: sec,
                    toSec: sec,
                    speaker: "River Example",
                    confidence: 0.69,
                }))
            );
        });
        const suggest = () => runSuggest({ store, record: store.read(record.id)!, rules: ["evidence"] });
        await suggest();
        await suggest();
        const saved = new MeetingStore(store.storage).read(record.id)!;
        expect(
            saved.items.flatMap((item) =>
                item.kind === "question" && item.group === "long-stretch" ? [item.fromSec] : []
            )
        ).toEqual([0, 20]);
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
    test("R3 preview and writer agree on the muted room guest and leave preview bytes untouched", async () => {
        const owner = "Elm Example";
        const guest = "Finch Example";
        const { store, record, meeting, opened, config } = await runnerFixture({
            seats: { room: [owner, guest], remote: [] },
            participants: [
                { name: owner, self: true, from: ["fixture"] },
                { name: guest, from: ["fixture"] },
            ],
        });
        config.global.speakerLabels.voice.enabled = false;
        meeting.transcript = [{ speaker: "Voice", startSec: 0, text: "Yes please." }];
        spies.push(
            spyOn(opened, "evidence").mockResolvedValue({
                selfName: owner,
                files: [],
                segments: [{ startSec: 0, endSec: 30, channel: "mic" }],
                speaking: [{ tSec: 0, speaking: [], muted: [guest] }],
            }),
            spyOn(opened, "energy").mockResolvedValue({
                share: Object.assign(() => 1, {
                    voice: () => ({
                        person: guest,
                        quality: "matched" as const,
                        candidates: [],
                        model: "fixture",
                        reason: "independent match",
                    }),
                }),
            })
        );
        const args = { store, record, rules: ["evidence" as const] };
        const bytes = readFileSync(store.path(record.id));
        const { previewSuggestions } = await import("../suggest-run");
        const preview = await previewSuggestions(args);
        expect(readFileSync(store.path(record.id))).toEqual(bytes);
        const predicted = preview.changes.fresh.find((item) => item.kind === "speaker-range");
        expect(predicted).toMatchObject({ speaker: guest, rules: [MeetingRule.Voice] });
        await runSuggest(args);
        const saved = new MeetingStore(store.storage).read(record.id)!;
        expect(saved.items.find((item) => item.id === predicted!.id)).toMatchObject({
            speaker: guest,
            rules: [MeetingRule.Voice],
        });
        expect((await runSuggest({ ...args, record: saved })).fresh).toEqual([]);
    });
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

    test("a stranger stretch never offers a person outside their stay at that time", async () => {
        const { store, record, meeting, opened } = await runnerFixture({
            participants: [
                { name: "Alice Example", self: true, from: ["fixture"] },
                { name: "Bob Example", from: ["fixture"] },
                { name: "Carol Example", from: ["fixture"] },
            ],
            seats: { room: ["Alice Example"], remote: [{ name: "Bob Example" }, { name: "Carol Example" }] },
        });
        meeting.transcript = [0, 10, 20, 30].map((startSec) => ({ speaker: "Speaker 1", startSec, text: "Yes." }));
        spies.push(
            spyOn(opened, "presence").mockResolvedValue([
                { name: "Alice Example", fromSec: 0, toSec: 1000 },
                { name: "Bob Example", fromSec: 0, toSec: 1000 },
                { name: "Carol Example", fromSec: 500, toSec: 900 },
            ])
        );
        const labels: LineLabel[] = [0, 1, 2].map((index) => ({
            labeler: "voice",
            index,
            seat: "mic",
            reason: "not-the-seat-person",
            score: 0.2,
            next: { person: "Alice Example", score: 0.2 },
        }));
        spies.push(spyOn(labelers, "proposeSpeakerLabels").mockResolvedValue(labels));
        await runSuggest({ store, record: store.read(record.id)!, rules: ["speakers"] });
        const asked = new MeetingStore(store.storage).read(record.id)!.items.filter((item) => item.kind === "question");
        expect(asked).toHaveLength(1);
        expect(asked[0]).toMatchObject({ fromSec: 0, choices: ["Alice Example", "Bob Example"] });
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

    test("suggest persists a final goodbye identified by the current voice pass", async () => {
        const { store, record, meeting, opened, config } = await runnerFixture({
            participants: [
                { name: "River Example", self: true, from: ["fixture"], firstSeenSec: 0 },
                { name: "Sky Example", from: ["fixture"], firstSeenSec: 0 },
                { name: "Lake Example", from: ["fixture"], firstSeenSec: 0 },
            ],
        });
        meeting.transcript = [
            { startSec: 2400, speaker: "Remote", text: "I have to go now." },
            { startSec: 2500, speaker: "Other", text: "We can continue." },
        ];
        config.global.speakerLabels.voice.enabled = true;
        spies.push(
            spyOn(opened, "evidence").mockResolvedValue({
                segments: [{ startSec: 0, endSec: 2600, channel: "system" }],
                speaking: [],
                files: [],
            })
        );
        const labelers = await import("./index");
        spies.push(
            spyOn(labelers, "proposeSpeakerLabels").mockResolvedValue([
                { labeler: "voice", index: 0, seat: "call", person: "Sky Example", score: 0.82, reason: "named" },
            ])
        );
        await runSuggest({ store, record, rules: ["speakers"] });
        const reopened = new MeetingStore(store.storage).read(record.id)!;
        expect(reopened.participants[1]?.stays).toEqual([
            { fromSec: 0, toSec: 2400, source: "platform-roster", leaveSource: "goodbye", confidence: 0.8 },
        ]);
        expect(reopened.participants[2]?.stays?.[0]?.toSec).toBeUndefined();
    });

    test("a late roster speaker's goodbye survives an unavailable attendance override", async () => {
        const { store, record, meeting, opened } = await runnerFixture({
            platform: "teams",
            participants: [
                { name: "River Example", self: true, from: ["platform-roster"], firstSeenSec: 0 },
                { name: "Lake Example", from: ["platform-roster"], firstSeenSec: 0 },
                { name: "Sky Example", from: ["platform-roster"], firstSeenSec: 600 },
                { name: "Reed Example", from: ["platform-roster"], firstSeenSec: 0 },
            ],
        });
        meeting.transcript = [
            { speaker: "River Example", startSec: 0, text: "Welcome to the meeting." },
            { speaker: "Call", startSec: 601, text: "Hello!" },
            { speaker: "River Example", startSec: 2396, text: "I have to go now." },
            { speaker: "Call", startSec: 2398, text: "See you later." },
            { speaker: "River Example", startSec: 2400, text: "Thanks, bye." },
            { speaker: "Call", startSec: 2480, text: "Which part of the proposal should we discuss next?" },
        ];
        const evidence = {
            segments: [{ startSec: 0, endSec: 2500, channel: "system" as const }],
            speaking: [
                { tSec: 1, speaking: ["Lake Example"], muted: ["Reed Example"] },
                { tSec: 602, speaking: ["Sky Example"] },
                { tSec: 603, speaking: [], speakingUnknown: true },
                { tSec: 2481, speaking: ["Lake Example"] },
            ],
            files: [],
        };
        spies.push(
            spyOn(opened, "suggestionPresence").mockResolvedValue(undefined),
            spyOn(opened, "evidence").mockResolvedValue(evidence)
        );
        const suggest = (current: MeetingRecord) =>
            runSuggest({ store, record: current, rules: ["speakers", "evidence"], attendance: "teams" });
        await suggest(record);
        const reopened = new MeetingStore(store.storage).read(record.id)!;
        expect(reopened.participants[2].stays).toEqual([
            { fromSec: 600, toSec: 2400, source: "platform-roster", leaveSource: "goodbye", confidence: 0.65 },
        ]);
        expect(
            reopened.participants
                .filter((person) => person.name !== "Sky Example")
                .every((person) => person.stays?.[0]?.toSec === undefined)
        ).toBe(true);
        expect(
            reopened.items.some(
                (item) =>
                    item.kind === "speaker-range" &&
                    item.rules.includes(MeetingRule.LeavePhrase) &&
                    item.label === "River Example" &&
                    item.fromSec === 2400 &&
                    item.speaker === "Sky Example"
            )
        ).toBe(true);

        // Two previously heard callers could have said the unnamed farewell.
        evidence.speaking.splice(3, 0, { tSec: 900, speaking: ["Reed Example"] });
        await suggest(reopened);
        expect(new MeetingStore(store.storage).read(record.id)!.participants[2].stays?.[0]?.toSec).toBeUndefined();
    });

    test("a corroborated named farewell closes raw presence and later speaker choices at the final goodbye", async () => {
        const leaver = "Sky Example";
        const open = OpenedMeeting.of;
        const { store, record, meeting, opened, config } = await runnerFixture({
            participants: [
                { name: "River Example", self: true, from: ["platform-roster"], firstSeenSec: 0 },
                { name: leaver, from: ["platform-roster"], firstSeenSec: 60 },
                { name: "Lake Example", from: ["platform-roster"], firstSeenSec: 0 },
                { name: "Reed Example", from: ["platform-roster"], firstSeenSec: 0 },
            ],
        });
        meeting.transcript = [
            { speaker: "Lake Example", startSec: 0, text: "Here are the plans." },
            { speaker: leaver, startSec: 65, text: "Where are we in the agenda?" },
            { speaker: leaver, startSec: 300, text: "I need to leave." },
            { speaker: "River Example", startSec: 301, text: "Okay." },
            { speaker: leaver, startSec: 303, text: "Díky, čau." },
            { speaker: "River Example", startSec: 304, text: "Čau." },
            { speaker: leaver, startSec: 320, text: "I will take the remaining questions on the proposal." },
            { speaker: "River Example", startSec: 330, text: "Thanks." },
        ];
        const evidence = {
            selfName: "River Example",
            segments: [{ startSec: 0, endSec: 340, channel: "system" as const }],
            speaking: [
                { tSec: 0, speaking: ["Lake Example"] },
                { tSec: 65, speaking: [leaver] },
                { tSec: 320, speaking: ["Reed Example"] },
            ],
            files: [],
        };
        spies.push(
            spyOn(opened, "evidence").mockResolvedValue(evidence),
            spyOn(opened, "suggestionPresence").mockResolvedValue(undefined)
        );
        const suggest = (current: MeetingRecord) =>
            runSuggest({ store, record: current, rules: ["speakers", "evidence"] });
        await suggest(record);
        const reopened = new MeetingStore(store.storage).read(record.id)!;
        expect(
            reopened.items.find(
                (item) =>
                    item.kind === "speaker-range" &&
                    item.fromSec === 303 &&
                    item.rules.includes(MeetingRule.LeavePhrase)
            )
        ).toMatchObject({ speaker: leaver, toSec: 303 });
        const later = reopened.items.filter(
            (item) => (item.kind === "speaker-range" || item.kind === "question") && item.toSec > 303
        );
        for (const item of later) {
            if (item.kind === "speaker-range") {
                expect(item.speaker).not.toBe(leaver);
                expect(item.candidates ?? []).not.toContain(leaver);
            } else if (item.kind === "question") {
                expect(item.choices ?? []).not.toContain(leaver);
            }
        }
        const reader = open(new MeetingStore(store.storage), reopened);
        spies.push(
            spyOn(reader, "meeting").mockResolvedValue(meeting),
            spyOn(reader, "evidence").mockResolvedValue(evidence),
            spyOn(reader, "energy").mockResolvedValue({}),
            spyOn(reader, "config").mockResolvedValue(config)
        );
        const presence = await reader.presence();
        expect(presence?.find((stay) => stay.name === leaver)?.toSec).toBe(303);
        const raw = rawMeeting({ record: reopened, meeting, evidence, presence, points: [] });
        expect(raw.people.find((person) => person.name === leaver)?.stays).toEqual([
            { fromSec: 60, toSec: 303, source: "platform-roster", leaveSource: "goodbye", confidence: 0.65 },
        ]);
        expect(raw.lines.find((line) => line.fromSec === 300)?.present).toContain(leaver);
        expect(raw.lines.filter((line) => line.fromSec > 303).map((line) => line.present.includes(leaver))).toEqual([
            false,
            false,
            false,
        ]);

        // A label recycled after departure is harmless. A good later observation of the same person is a veto.
        evidence.speaking.push({ tSec: 331, speaking: [leaver] });
        await suggest(reopened);
        expect(new MeetingStore(store.storage).read(record.id)!.participants[1].stays?.[0]?.toSec).toBeUndefined();
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

    test("R3 an agreeing channel rule joins the seat but an ineligible name cannot reopen the line", async () => {
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
        expect(ranges[0]?.speaker).toBe("Alice Example");
        expect(ranges[0]?.candidates ?? []).not.toContain("Bob Example");
        expect(questions).toHaveLength(0);
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

describe("voice support on seat lines", () => {
    const owner = "Alice Example";
    const project = "voice-support-fixture";
    let previousHome: string;

    beforeEach(() => {
        previousHome = env.tools.getHome();
        env.testing.set("GENESIS_TOOLS_HOME", mkdtempSync(join(tmpdir(), "voice-support-")));
    });
    afterEach(() => env.testing.set("GENESIS_TOOLS_HOME", previousHome));

    function readyChannel(options: { embedding: number[]; fromSec: number; toSec: number; audioPath: string }) {
        const channel: ChannelEmbedding = {
            quality: "ready",
            model: "fixture-model",
            embedding: options.embedding,
            fromSec: options.fromSec,
            toSec: options.toSec,
            channel: 0,
            track: "raw-mic",
            source: { audioPath: options.audioPath, size: 13, mtimeMs: 1 },
        };
        return channel;
    }

    /** Alice alone on the microphone seat, one saved sample of her voice, and one embedding per transcript line. */
    async function seatVoiceFixture(vectors: number[][]) {
        const fixture = await runnerFixture({
            project,
            participants: [{ name: owner, self: true, from: ["fixture"] }],
            seats: { room: [owner], remote: [] },
        });
        const { store, record, opened, meeting } = fixture;
        const audioPath = join(store.folder(record.id), "fixture.wav");
        writeFileSync(audioPath, "fixture audio");
        const endSec = vectors.length * 5 + 10;
        meeting.transcript = vectors.map((_, index) => ({
            speaker: "Speaker 1",
            startSec: index * 5,
            text: "A line.",
        }));
        spies.push(
            spyOn(opened, "evidence").mockResolvedValue({
                segments: [{ startSec: 0, endSec, channel: "mic" }],
                speaking: [],
                files: [],
            }),
            spyOn(opened, "presence").mockResolvedValue([{ name: owner, fromSec: 0, toSec: endSec }]),
            spyOn(opened, "sound").mockResolvedValue({
                tracks: [],
                slice: (request) => ({
                    track: "source-mic",
                    path: audioPath,
                    channel: 0,
                    clock: "source",
                    fileFromSec: request.fromSec,
                    fileToSec: request.toSec,
                }),
            }),
            spyOn(voiceEmbedding, "embedVoiceLines").mockImplementation(async (input) =>
                input.spans.map((span) => ({
                    index: span.index,
                    channels: [
                        readyChannel({
                            embedding: vectors[span.index]!,
                            fromSec: span.fromSec,
                            toSec: span.toSec,
                            audioPath,
                        }),
                    ],
                }))
            )
        );
        addVoicePrint(
            project,
            owner,
            {
                meeting: "training",
                sourceSha: "digest",
                seat: "mic",
                track: "source-mic",
                fromSec: 0,
                toSec: 5,
                embedding: [1, 0],
                confirmedAt: START,
            },
            "fixture-model"
        );
        return fixture;
    }

    function storedRanges(store: MeetingStore, id: string) {
        return new MeetingStore(store.storage).read(id)!.items.filter((item) => item.kind === "speaker-range");
    }

    test("merge keeps the seat label and attaches the voice's support only when it names the seat's person", () => {
        const owned: LineLabel = { labeler: "seat", index: 0, seat: "mic", person: owner, reason: "seat-of-one" };
        const support = { person: owner, score: 0.82, samples: 21 };
        const voiced: LineLabel = {
            labeler: "voice",
            index: 0,
            seat: "mic",
            person: owner,
            reason: "named",
            score: 0.8,
            voiceSupport: support,
        };
        expect(
            mergeLineLabels(
                new Map([
                    ["seat", [owned]],
                    ["voice", [voiced]],
                ])
            )
        ).toEqual([{ ...owned, voiceSupport: support }]);
        const elsewhere: LineLabel = { ...voiced, voiceSupport: { ...support, person: "Bob Example" } };
        expect(
            mergeLineLabels(
                new Map([
                    ["seat", [owned]],
                    ["voice", [elsewhere]],
                ])
            )
        ).toEqual([owned]);
        const veto: LineLabel = {
            labeler: "voice",
            index: 0,
            seat: "mic",
            reason: "not-the-seat-person",
            score: 0.1,
            next: { person: owner, score: 0.1 },
        };
        expect(
            mergeLineLabels(
                new Map([
                    ["seat", [owned]],
                    ["voice", [veto]],
                ])
            )
        ).toEqual([veto]);
    });

    test("a seat line whose voice matches the seat person carries voiceSupport and keeps confidence 0.95", async () => {
        const { store, record, opened, config } = await seatVoiceFixture([
            [1, 0],
            [0.96, 0.28],
        ]);
        const labels = await proposeSpeakerLabels(opened, config.global.speakerLabels);
        expect(labels.map(({ labeler, reason, person, score }) => [labeler, reason, person, score])).toEqual([
            ["seat", "seat-of-one", owner, undefined],
            ["seat", "seat-of-one", owner, undefined],
        ]);
        expect(labels[0]?.voiceSupport).toEqual({ person: owner, score: 1, samples: 1 });
        expect(labels[1]?.voiceSupport).toMatchObject({ person: owner, samples: 1 });
        expect(labels[1]?.voiceSupport?.score).toBeCloseTo(0.96, 6);

        await runSuggest({ store, record, rules: ["speakers"] });
        const ranges = storedRanges(store, record.id);
        expect(ranges.map((item) => [item.speaker, item.confidence, item.rules])).toEqual([
            [owner, 0.95, [MeetingRule.Attendance]],
            [owner, 0.95, [MeetingRule.Attendance]],
        ]);
        expect(ranges[0]?.evidence).toMatchObject({
            labeler: "seat",
            reason: "seat-of-one",
            voiceSupport: { person: owner, score: 1, samples: 1 },
        });
        expect(ranges[0]?.evidence?.score).toBeUndefined();
    });

    test("a stranger's line on the seat still gets not-the-seat-person while the owner's lines carry support", async () => {
        const { opened, config } = await seatVoiceFixture([
            [1, 0],
            [0, 1],
            [1, 0],
        ]);
        const labels = await proposeSpeakerLabels(opened, config.global.speakerLabels);
        expect(labels.map(({ labeler, reason, person }) => [labeler, reason, person])).toEqual([
            ["seat", "seat-of-one", owner],
            ["voice", "not-the-seat-person", undefined],
            ["seat", "seat-of-one", owner],
        ]);
        expect(labels[1]).toMatchObject({ score: 0, next: { person: owner, score: 0 } });
        expect(labels.map((label) => label.voiceSupport?.person)).toEqual([owner, undefined, owner]);
    });

    test("with supportOnSeatLines off the labels are today's: the same seats and vetoes, no support", async () => {
        expect(meetingsConfigSchema.parse({}).global.speakerLabels.voice.supportOnSeatLines).toBe(true);
        const { opened, config } = await seatVoiceFixture([
            [1, 0],
            [0, 1],
            [1, 0],
        ]);
        const on = await proposeSpeakerLabels(opened, config.global.speakerLabels);
        config.global.speakerLabels.voice.supportOnSeatLines = false;
        const off = await proposeSpeakerLabels(opened, config.global.speakerLabels);
        expect(on.filter((label) => label.voiceSupport)).toHaveLength(2);
        expect(off.filter((label) => label.voiceSupport)).toEqual([]);
        expect(on.map((label): LineLabel => ({ ...label, voiceSupport: undefined }))).toEqual(off);
    });

    test("a rerun adds the voice's support to the stored seat proposal and takes it away when the setting is off", async () => {
        const { store, record, config } = await seatVoiceFixture([
            [1, 0],
            [1, 0],
        ]);
        config.global.speakerLabels.voice.supportOnSeatLines = false;
        await runSuggest({ store, record, rules: ["speakers"] });
        const before = storedRanges(store, record.id);
        expect(before.map((item) => item.evidence?.voiceSupport)).toEqual([undefined, undefined]);

        config.global.speakerLabels.voice.supportOnSeatLines = true;
        const second = await runSuggest({ store, record: store.read(record.id)!, rules: ["speakers"] });
        expect(second.fresh).toEqual([]);
        const supported = storedRanges(store, record.id);
        expect(supported.map((item) => [item.id, item.status, item.confidence])).toEqual(
            before.map((item) => [item.id, "suggested", 0.95])
        );
        expect(supported.map((item) => item.evidence?.voiceSupport)).toEqual([
            { person: owner, score: 1, samples: 1 },
            { person: owner, score: 1, samples: 1 },
        ]);

        config.global.speakerLabels.voice.supportOnSeatLines = false;
        await runSuggest({ store, record: store.read(record.id)!, rules: ["speakers"] });
        expect(storedRanges(store, record.id)).toEqual(before);
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
