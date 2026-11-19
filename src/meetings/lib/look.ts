import type { MeetingItem, MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import type { VoiceMatch } from "@genesiscz/utils/meetings/voice";
import { type LineEvidence, lineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { LINE_AT_TOLERANCE_SEC, TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import { z } from "zod";
import { CallTimeline } from "./call-timeline";
import { itemWhat } from "./item-text";
import { screenTextChanges } from "./look-screen";
import { itemMomentSpot } from "./moment";
import { meetingTimeRangeSchema } from "./moment-schema";
import { OpenedMeeting } from "./opened-meeting";
import { inStretch, unlabeledStretches } from "./unlabeled";

// A pairing finding carries its call line in evidence.transcriptLine and its measured microphone partner here.
const echoPair = z.looseObject({ micLineIndex: z.number().int().nonnegative(), lagMs: z.number().nonnegative() });

type SpeakerRange = Extract<MeetingItem, { kind: "speaker-range" }>;

function voicePrediction(match: VoiceMatch | undefined, covering: SpeakerRange[]) {
    if (match) {
        const best = match.person ? match.candidates.find((one) => one.person === match.person) : match.candidates[0];
        return {
            person: match.person ?? null,
            candidate: best?.person ?? null,
            score: best?.score ?? null,
            quality: match.quality,
        };
    }

    const proposal = covering.findLast(
        (item) =>
            (item.status === "suggested" || item.decision?.previous.speaker !== undefined) &&
            item.rules.includes(MeetingRule.VoiceEmbedding) &&
            item.evidence?.reason !== "exclusion" &&
            typeof item.evidence?.score === "number"
    );
    if (!proposal || typeof proposal.evidence?.score !== "number") {
        return null;
    }

    const person =
        proposal.status === "confirmed"
            ? proposal.decision?.previous.speaker
            : (proposal.speaker ?? (proposal.evidence.labelConflict ? proposal.candidates?.[0] : undefined));
    return { person: person ?? null, candidate: person ?? null, score: proposal.evidence.score, quality: "suggested" };
}

function lineNames(record: MeetingRecord, window: { fromSec: number; toSec: number }) {
    const ranges = record.items.filter(
        (item): item is SpeakerRange =>
            item.kind === "speaker-range" &&
            item.status !== "rejected" &&
            item.toSec >= window.fromSec &&
            item.fromSec <= window.toSec
    );
    const unlabeled = unlabeledStretches(record.items).filter((item) => item.status === "confirmed");
    const assignments = [...(record.speakers.assignments ?? [])].sort((a, b) => a.at.localeCompare(b.at));
    const pairs = new Map<number, z.output<typeof echoPair>>();
    for (const item of record.items) {
        const index = item.evidence?.transcriptLine;
        if (item.status !== "rejected" && typeof index === "number" && item.evidence?.echoPair) {
            const pair = echoPair.safeParse(item.evidence.echoPair);
            if (pair.success) {
                pairs.set(index, pair.data);
            }
        }
    }

    return (line: LineEvidence) => {
        const covering = ranges.filter(
            (item) =>
                item.label === line.label &&
                item.fromSec <= line.startSec &&
                line.startSec <= item.toSec &&
                (item.fromSec !== item.toSec ||
                    typeof item.evidence?.transcriptLine !== "number" ||
                    item.evidence.transcriptLine === line.index)
        );
        const suggested = covering.findLast((item) => item.status === "suggested" && item.speaker);
        const confirmed = covering.findLast((item) => item.status === "confirmed");
        const assigned = assignments.findLast(
            (assignment) =>
                assignment.label === line.label &&
                line.startSec >= assignment.fromSec - LINE_AT_TOLERANCE_SEC &&
                line.startSec <= assignment.toSec + LINE_AT_TOLERANCE_SEC
        );
        const multiple = confirmed?.voices?.length || confirmed?.segments?.length;
        const globalName = inStretch(unlabeled, line.label, line.startSec) ? null : record.speakers.labels[line.label];
        const found = line.voice ?? record.evidence?.voice?.lines[String(line.index)];
        return {
            suggestedName: suggested?.speaker ?? null,
            confirmedName: assigned?.person ?? (multiple ? null : (confirmed?.speaker ?? globalName ?? null)),
            ...(multiple && !assigned
                ? { confirmedVoices: confirmed?.voices ?? confirmed?.segments?.map((part) => part.speaker) }
                : {}),
            voice: voicePrediction(found, covering),
            echoPair: pairs.get(line.index) ?? null,
        };
    };
}

async function rangeSources(opened: OpenedMeeting) {
    if (!opened.sourceRef) {
        const timeline = CallTimeline.stored(opened.record);
        return { entries: [], evidence: null, energy: undefined, presence: timeline.storedStays(), timeline };
    }

    const [source, evidence, energy, presence, timeline] = await Promise.all([
        opened.meeting(),
        opened.evidence(),
        opened.energy(),
        opened.presence(),
        opened.timeline(),
    ]);
    return { entries: source.transcript, evidence, energy, presence, timeline };
}

/** Read the stored decisions and evidence. Only transcript starts and item spots inside the closed window are returned. */
export async function lookMeeting(store: MeetingStore, input: z.input<typeof meetingTimeRangeSchema>) {
    const { meeting, from: fromSec, to: toSec } = meetingTimeRangeSchema.parse(input);
    const record = store.resolve(meeting);
    if (!record) {
        throw new Error(`No meeting "${meeting}"`);
    }

    const { entries, evidence, energy, presence, timeline } = await rangeSources(OpenedMeeting.of(store, record));
    const window = { fromSec, toSec };
    const layout = energy?.calibration?.layout ?? record.evidence?.channels?.layout ?? "unknown";
    const names = lineNames(record, window);
    const lines = lineEvidence(entries, evidence ?? { segments: [], speaking: [] }, undefined, energy?.share, {
        window,
    }).map((line) => ({
        index: line.index,
        fromSec: line.startSec,
        toSec: line.endSec,
        label: line.label,
        text: line.text,
        ...names(line),
        micShare:
            layout === "unknown" ? "layout unknown" : (line.energyMic ?? line.energyMicRaw ?? line.micShare ?? null),
    }));
    const transcript = new TranscriptLines(entries);
    // A heard word may fall inside even if its source line began before the window.
    const firstAnchor =
        transcript.entries.reduce(
            (first, entry, index) =>
                entry.startSec !== undefined && (transcript.end(index) ?? -Infinity) >= fromSec
                    ? Math.min(first, entry.startSec)
                    : first,
            fromSec
        ) - LINE_AT_TOLERANCE_SEC;
    const items = record.items.flatMap((item) => {
        const start = "fromSec" in item ? item.fromSec : item.atSec;
        const end = "toSec" in item ? item.toSec : start;
        if (start === undefined || end === undefined || start > toSec + LINE_AT_TOLERANCE_SEC || end < firstAnchor) {
            return [];
        }

        const spot = itemMomentSpot({ record, item, lines: transcript });
        return spot !== undefined && spot >= fromSec && spot <= toSec
            ? [{ id: item.id, kind: item.kind, status: item.status, atSec: spot, what: itemWhat(item) }]
            : [];
    });
    const attendance =
        presence
            ?.filter((stay) => stay.fromSec <= toSec && stay.toSec > fromSec && stay.toSec > stay.fromSec)
            .map((stay) => ({
                name: stay.name,
                fromSec: Math.max(fromSec, stay.fromSec),
                toSec: Math.min(toSec, stay.toSec),
            })) ?? null;
    return {
        meeting: record.id,
        ...window,
        lines,
        attendance,
        items,
        questions: items.filter((item) => item.kind === "question" && item.status === "suggested"),
        screen: await screenTextChanges({ folder: store.folder(record.id), timeline, ...window }),
    };
}
