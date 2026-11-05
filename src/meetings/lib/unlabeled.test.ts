import { describe, expect, test } from "bun:test";
import { meetingItemSchema } from "@genesiscz/utils/meetings/record";
import type { SourceMeeting } from "@genesiscz/utils/meetings/sources";
import { findingItems, findingsFileSchema } from "./findings";
import { unlabeledStretches, unlabeledView } from "./unlabeled";

const meeting: SourceMeeting = {
    sourceMeetingId: "abc",
    title: "Planning",
    start: "2026-11-02T15:00:00.000Z",
    participants: [],
    speakers: [{ name: "Petr Novák", origin: "platform" }],
    transcript: [
        { speaker: "Petr Novák", startSec: 0, text: "Začneme." },
        { speaker: "Petr Novák", startSec: 10, text: "Já jsem to upravil." },
        { speaker: "Alice Example", startSec: 15, text: "Dobře." },
        { speaker: "Petr Novák", startSec: 90, text: "Ještě jedna věc." },
    ],
    folders: [],
};
const now = "2026-11-02T15:00:00.000Z";

describe("a label that tracks no one person", () => {
    const [label] = findingItems(
        findingsFileSchema.parse([
            {
                kind: "label",
                label: "Petr Novák",
                from: "0:00",
                to: 30,
                meaningless: true,
                reason: "two voices in the room show as one tile",
            },
        ]),
        [],
        now
    );

    test("items add stores it as a label item with its reason", () => {
        expect(label).toMatchObject({
            id: "i1",
            kind: "label",
            label: "Petr Novák",
            fromSec: 0,
            toSec: 30,
            meaningless: true,
            status: "suggested",
            evidence: { reason: "two voices in the room show as one tile" },
        });
    });

    test("the rules see its lines in the stretch under a label that names nobody, and items found there get the label back", () => {
        const stretches = unlabeledStretches([label!]);
        const view = unlabeledView(meeting, stretches);

        expect(view.meeting.transcript.map((entry) => entry.speaker)).toEqual([
            "Unlabeled 1",
            "Unlabeled 1",
            "Alice Example",
            "Petr Novák",
        ]);

        const range = meetingItemSchema.parse({
            id: "i2",
            kind: "speaker-range",
            status: "suggested",
            label: "Unlabeled 1",
            fromSec: 10,
            toSec: 10,
            speaker: "Alice Example",
            suggestedAt: now,
        });
        expect(view.restore(range)).toMatchObject({ label: "Petr Novák", fromSec: 10 });
    });

    test("a rejected one leaves the transcript as it is", () => {
        const rejected = meetingItemSchema.parse({ ...label, status: "rejected" });

        expect(unlabeledView(meeting, unlabeledStretches([rejected])).meeting).toBe(meeting);
    });
});

test("speaker suggestions never persist a synthetic join voice", async () => {
    const { suggestItems } = await import("./suggest");
    const { meetingRecordSchema } = await import("@genesiscz/utils/meetings/record");
    const label = meetingItemSchema.parse({
        id: "i1",
        kind: "label",
        status: "confirmed",
        suggestedAt: now,
        rules: [],
        label: "Room",
        fromSec: 0,
        toSec: 30,
        meaningless: true,
    });
    const record = meetingRecordSchema.parse({
        id: "fixture",
        title: "Fixture",
        start: now,
        createdAt: now,
        createdBy: "new",
        items: [label],
    });
    const found = suggestItems({
        record,
        meeting: {
            ...meeting,
            speakers: [],
            transcript: [
                { speaker: "Cut", startSec: 10, text: "dot" },
                { speaker: "Room", startSec: 11, text: "áhnu to do konce." },
            ],
        },
        rules: ["speakers"],
        dictionary: { abbrExpansion: "every", entries: [] },
        sourceWords: [],
        now,
    });
    const joins = found.filter((item) => item.kind === "join");
    expect(joins.length).toBeGreaterThan(0);
    expect(joins.some((item) => item.speaker?.startsWith("Unlabeled "))).toBe(false);
});
