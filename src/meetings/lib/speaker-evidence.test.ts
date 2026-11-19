import { describe, expect, test } from "bun:test";
import { meetingRecordSchema } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import { type LineEvidence, SELF } from "@genesiscz/utils/transcribe/evidence";
import { type EvidenceInput, evidenceItems, independentIndicatorLines, speakerEvidence } from "./speaker-evidence";

const dana = "Dana Example";
const eli = "Eli Example";
const start = "2026-11-01T12:00:00Z";
const applyAbove = 0.8;

function callLine(index: number, startSec: number): LineEvidence {
    return {
        index,
        startSec,
        endSec: startSec + 8,
        label: dana,
        text: "The call is open.",
        micShare: 0,
        energyMic: 0.1,
        winner: eli,
        speaking: { [eli]: 1 },
        liveName: eli,
    };
}

function scene(lines: LineEvidence[]): EvidenceInput {
    return {
        lines,
        record: meetingRecordSchema.parse({
            id: "speaker-evidence",
            title: "Planning",
            start,
            createdAt: start,
            createdBy: "new",
            participants: [{ name: dana, self: true }, { name: eli }],
        }),
        meeting: {
            sourceMeetingId: "planning",
            title: "Planning",
            start,
            participants: [],
            speakers: [{ name: eli, origin: "platform", speakerId: 1 }],
            folders: [],
            transcript: lines.map((line) => ({ startSec: line.startSec, speaker: line.label, text: line.text })),
        },
        evidence: { selfName: dana, segments: [], speaking: [], files: [] },
    };
}

function evaluate(input: EvidenceInput, threshold = applyAbove) {
    const evidence = speakerEvidence(input);
    return { evidence, items: evidenceItems(input).items, seeds: independentIndicatorLines(evidence, threshold) };
}

describe("per-line speaker evidence", () => {
    test("an indicator and live name on a call line seed at the apply threshold", () => {
        const { evidence, items, seeds } = evaluate(scene([callLine(7, 0)]));
        expect(evidence.labels[0]?.outcomes[0]).toMatchObject({
            kind: "finding",
            finding: {
                speaker: eli,
                confidence: applyAbove,
                rules: [MeetingRule.Channel, MeetingRule.SpeakingIndicator, MeetingRule.LiveName],
            },
        });
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ speaker: eli, evidence: { channel: "system", lines: 1 } });
        expect([...seeds]).toEqual([[7, eli]]);
    });

    test("the same indicator line with both channels needs a listen and cannot seed", () => {
        const { evidence, items, seeds } = evaluate(scene([{ ...callLine(7, 0), micShare: 0.2 }]));
        expect(evidence.labels[0]?.outcomes[0]).toMatchObject({
            kind: "finding",
            finding: { speaker: eli, listen: true, confidence: applyAbove },
        });
        expect(items[0]).toMatchObject({ evidence: { listen: true } });
        expect(seeds.size).toBe(0);
    });

    test("a microphone echo is counted in the range and cannot seed", () => {
        const line = { ...callLine(0, 0), label: eli, micShare: 1, energyMic: 1, winner: SELF, echo: 0.8 };
        const { evidence, items, seeds } = evaluate(scene([line]), 0);
        expect(evidence.labels[0]?.outcomes[0]).toMatchObject({ kind: "finding", finding: { echo: true } });
        expect(items[0]).toMatchObject({ evidence: { echoLines: 1 } });
        expect(seeds.size).toBe(0);
    });

    test("a named indicator line below the apply threshold cannot seed", () => {
        const { evidence, seeds } = evaluate(scene([callLine(0, 0)]), 0.81);
        expect(evidence.labels[0]?.outcomes[0]).toMatchObject({
            kind: "finding",
            finding: { speaker: eli, confidence: 0.8 },
        });
        expect(seeds.size).toBe(0);
    });

    test("an indicator name rejected by full-line attendance cannot seed or make a range", () => {
        const input = scene([callLine(0, 0)]);
        input.presence = [{ name: eli, fromSec: 0, toSec: 3 }];
        const { evidence, items, seeds } = evaluate(input);
        expect(evidence.labels[0]?.outcomes[0]).toMatchObject({ kind: "none", reason: "ineligible-speaker" });
        expect(items).toEqual([]);
        expect(seeds.size).toBe(0);
    });

    test("a swap produces items first and no second finding for its lines", () => {
        // Two swapped windows bridge an empty window after a normal one. One line contradicts its swapped label.
        const lines = Array.from({ length: 90 }, (_, index) => {
            const selfLabel = index % 2 === 0;
            const mic = selfLabel === index < 30 ? 1 : 0;
            return {
                ...callLine(index, index * 10 + (index >= 60 ? 300 : 0)),
                label: selfLabel ? dana : eli,
                micShare: index === 36 ? 1 : mic,
                energyMic: mic,
                winner: mic ? SELF : eli,
                speaking: {},
                liveName: undefined,
            };
        });
        const { evidence, items, seeds } = evaluate(scene(lines));
        expect(evidence.swaps).toHaveLength(1);
        expect(evidence.swaps[0]).toMatchObject({ fromSec: 300, toSec: 1190, skipped: [360] });
        const swapped = evidence.labels.flatMap(({ outcomes }) => outcomes.filter(({ line }) => line.startSec >= 300));
        expect(swapped).toHaveLength(60);
        for (const outcome of swapped) {
            expect(outcome).toMatchObject({
                kind: "none",
                reason: outcome.line.index === 36 ? "swap-skipped" : "in-swap",
            });
        }
        expect(evidence.swapItems).toHaveLength(59);
        expect(items.slice(0, 59)).toEqual(evidence.swapItems);
        expect(seeds.size).toBe(0);

        const timed = scene(lines);
        timed.record.seats = {
            room: [
                { name: dana, fromSec: 0, toSec: 305 },
                { name: "Finch Example", fromSec: 305 },
            ],
            remote: [{ name: eli, fromSec: 0, toSec: 305 }],
        };
        const bounded = evaluate(timed).evidence;
        expect(bounded.swaps).toHaveLength(1);
        expect(bounded.swapItems.some((item) => item.kind === "speaker-range" && item.fromSec === 300)).toBe(false);
        expect(bounded.swapItems.some((item) => item.kind === "speaker-range" && item.fromSec === 310)).toBe(false);
    });

    test("equal adjacent findings group, and a 200 second gap starts another range", () => {
        const { items, seeds } = evaluate(scene([callLine(0, 0), callLine(1, 10), callLine(2, 210)]));
        expect(items).toHaveLength(2);
        expect(items[0]).toMatchObject({ speaker: eli, fromSec: 0, toSec: 10, evidence: { lines: 2, endSec: 18 } });
        expect(items[1]).toMatchObject({ speaker: eli, fromSec: 210, toSec: 210, evidence: { lines: 1, endSec: 218 } });
        expect([...seeds]).toEqual([
            [0, eli],
            [1, eli],
            [2, eli],
        ]);
    });

    test("a direct voice item and a line with no finding each close the preceding range", () => {
        const input = scene([
            callLine(0, 0),
            callLine(1, 10),
            callLine(2, 20),
            { ...callLine(3, 30), winner: undefined },
            callLine(4, 40),
        ]);
        input.voiceMatches = {
            "1": { person: eli, quality: "matched", reason: "matched", model: "fixture", candidates: [] },
        };
        const { evidence, items, seeds } = evaluate(input);
        expect(evidence.labels[0]?.outcomes.map(({ kind }) => kind)).toEqual([
            "finding",
            "direct",
            "finding",
            "none",
            "finding",
        ]);
        expect(
            items.filter((item) => item.kind === "speaker-range").map(({ fromSec, toSec }) => [fromSec, toSec])
        ).toEqual([
            [0, 0],
            [10, 10],
            [20, 20],
            [40, 40],
        ]);
        expect(items[1]).toMatchObject({ rules: [MeetingRule.VoiceEmbedding] });
        expect([...seeds.keys()]).toEqual([0, 2, 4]);

        const confirmed = {
            id: "i1",
            kind: "speaker-range",
            label: "Overlapping label",
            status: "confirmed",
            fromSec: 0,
            toSec: 20,
            speaker: eli,
            rules: [],
            suggestedAt: start,
        } as const;
        input.items = [{ ...confirmed, rules: [] }];
        expect(evaluate(input).evidence.labels[0]?.outcomes[1]?.kind).toBe("direct");
        input.items = [{ ...confirmed, rules: [], label: dana }];
        expect(evaluate(input).evidence.labels[0]?.outcomes[1]?.kind).not.toBe("direct");
    });
});
