import { expect, test } from "bun:test";
import type { MeetingItem } from "@genesiscz/utils/meetings/record";
import { MeetingStore, meetingRecordSchema } from "@genesiscz/utils/meetings/record";
import type { SourceMeeting } from "@genesiscz/utils/meetings/sources";
import { Storage } from "@genesiscz/utils/storage/storage";
import { groupSpeakerQuestions, refreshSpeakerQuestions } from "./questions";
import { LineSpeakers } from "./speaker-evidence";
import { applySuggestionChanges, planSuggestions, type SuggestInputs } from "./suggest";

test("a retired speaker range retires its question when no line choices can be rebuilt", () => {
    const meeting: SourceMeeting = {
        sourceMeetingId: "fixture",
        title: "Practice",
        start: "2026-11-01T09:00:00Z",
        participants: [],
        speakers: [],
        folders: [],
        transcript: [],
    };
    const record = meetingRecordSchema.parse({
        id: "fixture",
        title: meeting.title,
        start: meeting.start,
        createdAt: meeting.start,
        createdBy: "new",
        items: [
            {
                kind: "speaker-range",
                id: "i1",
                label: "Voice",
                status: "rejected",
                fromSec: 0,
                toSec: 8,
                evidence: { retired: "seat changed" },
                suggestedAt: meeting.start,
                rules: [],
            },
            {
                kind: "question",
                id: "i2",
                about: "speaker",
                status: "suggested",
                fromSec: 0,
                toSec: 8,
                choices: ["Finch Example"],
                decides: ["i1"],
                question: "Who spoke?",
                suggestedAt: meeting.start,
                rules: [],
            },
        ],
    });
    refreshSpeakerQuestions(record.items, {
        speakers: new LineSpeakers({ record, meeting, lines: [] }),
        listenBelow: 0.7,
        transcript: [],
        points: [],
    });
    expect(record.items[1]).toMatchObject({ status: "rejected", evidence: { retired: "speaker-eligibility" } });
});

test("a long imported stretch has one question with the full span", () => {
    const count = 150_000;
    const ranges: MeetingItem[] = Array.from({ length: count }, (_, index) => ({
        id: `i${index}`,
        kind: "speaker-range",
        status: "suggested",
        rules: [],
        label: "Voice",
        fromSec: count - index,
        toSec: count - index,
        suggestedAt: "2026-11-01T09:00:00Z",
        evidence: { strangerStretch: 1, endSec: count - index + 2 },
    }));
    const questions = groupSpeakerQuestions(ranges, new Set(), { listenBelow: 0.7, transcript: [], points: [] });
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ fromSec: 1, toSec: count + 2 });
    expect(questions[0]?.decides).toHaveLength(count);
});

function freeze(value: unknown) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        Object.values(value).forEach(freeze);
    }
}

test("R3 planning on frozen input preserves old range edits, choices and departures across reopen", async () => {
    const now = "2026-11-01T09:00:00Z";
    const owner = "Elm Example";
    const guest = "Wren Example";
    const store = new MeetingStore(new Storage("r3-suggestion-plan"));
    const record = await store.create(
        {
            start: now,
            createdBy: "new",
            title: "Planning",
            participants: [owner, guest, "Lake Example"].map((name) => ({
                name,
                self: name === owner,
                from: ["platform-roster"],
                firstSeenSec: 0,
            })),
            seats: { room: [owner], remote: [{ name: guest }, { name: "Lake Example" }] },
            items: [
                {
                    id: "i1",
                    kind: "speaker-range",
                    label: "Local",
                    speaker: owner,
                    fromSec: 0,
                    toSec: 10,
                    status: "suggested",
                    suggestedAt: now,
                    rules: [],
                    confidence: 0.95,
                },
                {
                    id: "i2",
                    kind: "speaker-range",
                    label: "Remote",
                    fromSec: 20,
                    toSec: 20,
                    status: "suggested",
                    suggestedAt: now,
                    rules: [],
                    confidence: 0.3,
                    candidates: [guest, "Lake Example"],
                },
            ],
        },
        { command: "new", change: "fixture" }
    );
    const meeting: SourceMeeting = {
        title: "Planning",
        sourceMeetingId: "r3",
        start: now,
        participants: [],
        speakers: [],
        folders: [],
        transcript: [
            { speaker: "Local", startSec: 0, text: "Yes." },
            { speaker: "Local", startSec: 10, text: "Thank you." },
            {
                speaker: "Remote",
                startSec: 20,
                text: "We agreed to send the full list of changes before the team meets again on Friday morning.",
            },
            { speaker: "Remote", startSec: 2400, text: "I have to go now." },
            { speaker: "Other", startSec: 2500, text: "We can continue." },
        ],
    };
    const inputs: SuggestInputs = {
        record,
        meeting,
        now,
        rules: ["speakers"],
        dictionary: { abbrExpansion: "every", entries: [] },
        sourceWords: [],
        leaveSilenceMinutes: 15,
        evidence: {
            segments: [
                { startSec: 0, endSec: 20, channel: "mic" },
                { startSec: 20, endSec: 2600, channel: "system" },
            ],
            speaking: [{ tSec: 20, speaking: [], validUntilSec: 2400 }],
            files: [],
        },
        labels: [
            {
                index: 0,
                labeler: "voice",
                seat: "mic",
                reason: "not-the-seat-person",
                next: { person: owner, score: 0.1 },
            },
            { index: 3, labeler: "voice", seat: "call", reason: "named", person: guest, score: 0.83 },
        ],
    };
    const before = structuredClone(record);
    freeze(inputs);
    const changes = planSuggestions(inputs);
    expect(record).toEqual(before);
    const stale = structuredClone(record);
    stale.items[1]!.status = "confirmed";
    const decided = structuredClone(stale);
    expect(() => applySuggestionChanges(stale, changes)).toThrow();
    expect(stale).toEqual(decided);
    await store.update(record.id, { command: "suggest", change: "fixture" }, (current) =>
        applySuggestionChanges(current, changes)
    );
    const reopened = new MeetingStore(store.storage).read(record.id)!;
    const replay = planSuggestions({ ...inputs, record: reopened });
    expect(reopened.participants.find((p) => p.name === guest)?.stays?.[0]).toMatchObject({
        toSec: 2400,
        leaveSource: "goodbye",
    });
    expect(reopened.items[0]).toMatchObject({ status: "rejected", evidence: { retired: "not-the-seat-person" } });
    expect(reopened.items[1]?.evidence).toMatchObject({
        signature: expect.any(String),
        choices: expect.arrayContaining([guest]),
    });
    expect(reopened.items).toContainEqual(
        expect.objectContaining({ label: "Local", fromSec: 10, toSec: 10, speaker: owner })
    );
    expect(replay.fresh).toEqual([]);
});
