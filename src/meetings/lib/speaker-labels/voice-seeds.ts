import type { MeetingItem } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import type { MeetingEvidence, SourceMeeting } from "@genesiscz/utils/meetings/sources";
import { lineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { type Presence, sameName } from "@genesiscz/utils/transcribe/speakers";
import { DecisionJournal } from "../decision-journal";
import type { OpenedMeeting } from "../opened-meeting";
import { evidenceItems } from "../suggest";
import { ATTENDANCE_CONFIDENCE } from "./seat";
import type { LabelContext, LineLabel } from "./types";

const human = (kind?: string) => kind === "listen" || kind === "window" || kind === "cli";

/** A current human choice outranks the independent rules. A split or a disagreement supplies no training audio. */
export function meetingVoiceSeeds(options: {
    opened: OpenedMeeting;
    context: LabelContext;
    meeting: SourceMeeting;
    evidence: MeetingEvidence | null | undefined;
    presence?: Presence[];
    energy: Parameters<typeof lineEvidence>[3];
    seats: LineLabel[];
    applyAbove: number;
}): Pick<LabelContext, "certain" | "seatOnlySeeds"> {
    const { opened, context, meeting, evidence, presence, applyAbove } = options;
    const record = opened.record;
    const indicators = new Map<number, string>();
    if (evidence?.speaking.length) {
        evidenceItems({
            meeting,
            evidence,
            record,
            presence,
            energyMicShare: options.energy,
            lines: lineEvidence(meeting.transcript, evidence, presence, options.energy),
            onIndicator: (index, person, confidence) => {
                if (confidence >= applyAbove) {
                    indicators.set(index, person);
                }
            },
        });
    }
    const seats = new Map(
        options.seats
            .filter((row) => row.person && (row.score ?? ATTENDANCE_CONFIDENCE) >= applyAbove)
            .map((row) => [row.index, row.person!])
    );
    const assignments = [...(record.speakers.assignments ?? [])].sort((a, b) => b.at.localeCompare(a.at));
    const ranges = record.items.filter((item) => item.kind === "speaker-range");
    const questions = record.items.filter(
        (item): item is Extract<MeetingItem, { kind: "question" }> =>
            item.kind === "question" && item.about === "speaker" && item.status === "confirmed"
    );
    const journal =
        assignments.length || questions.length || ranges.some((range) => range.status === "confirmed")
            ? new DecisionJournal({ store: opened.store }).read(record.id).filter((entry) => !entry.revertedBy)
            : [];
    const byToken = new Map(journal.map((entry) => [entry.token, entry]));
    const targets = new Map(questions.map((q) => [q.id, new Set([q.id, ...q.decides])]));
    const assignedByPerson = new Set(
        journal.flatMap((entry) =>
            entry.action.kind === "assign" && human(entry.actor.kind)
                ? (entry.assignments ?? []).flatMap(({ after }) => (after ? [`${after.id}|${after.at}`] : []))
                : []
        )
    );
    const direct = (item: MeetingItem) => {
        const decision = item.decision;
        const entry = decision && byToken.get(decision.token);
        if (!human(entry?.actor.kind ?? decision?.actor?.kind)) {
            return false;
        }
        if (!entry) {
            const stamped = decision?.entry;
            return stamped?.action === "answer" && !!stamped.question && targets.get(stamped.question)?.has(item.id);
        }
        if (entry.action.kind === "confirm") {
            return entry.action.minConfidence === undefined && entry.decided.includes(item.id);
        }
        return (
            entry.action.kind === "answer" &&
            !entry.action.knownAnswer &&
            !!entry.question &&
            targets.get(entry.question)?.has(item.id)
        );
    };
    const decidedIds = new Set(
        ranges.filter((range) => range.status === "confirmed" && direct(range)).map((range) => range.id)
    );
    const standaloneAnswers = questions.filter((q) => q.decides.length === 0 && q.answer && direct(q));
    const certain = new Map<number, string>();
    const seatOnlySeeds = new Set<number>();
    for (const line of context.lines) {
        const label = meeting.transcript[line.index]?.speaker;
        const covers = (range: { fromSec: number; toSec: number; label: string }) =>
            range.label === label && range.fromSec <= line.fromSec && range.toSec >= line.fromSec;
        const assignment = assignments.find(covers);
        if (assignment) {
            if (assignedByPerson.has(`${assignment.id}|${assignment.at}`)) {
                certain.set(line.index, assignment.person);
            }
            continue;
        }
        const covering = ranges.filter(
            (range) =>
                covers(range) &&
                (range.evidence?.transcriptLine === undefined || range.evidence.transcriptLine === line.index)
        );
        const confirmed = covering.filter((range) => range.status === "confirmed");
        if (confirmed.some((range) => range.voices?.length || range.segments?.length || !decidedIds.has(range.id))) {
            continue;
        }
        const answers = standaloneAnswers.flatMap((q) =>
            q.fromSec <= line.fromSec &&
            (typeof q.evidence?.endSec === "number" ? Math.max(q.toSec, q.evidence.endSec) : q.toSec) >= line.toSec &&
            q.answer
                ? [q.answer]
                : []
        );
        const decided = [...answers, ...confirmed.flatMap((range) => (range.speaker ? [range.speaker] : []))];
        const independent = [
            seats.get(line.index),
            indicators.get(line.index),
            ...covering.flatMap((range) =>
                range.status === "suggested" &&
                range.speaker &&
                (range.confidence ?? 0) >= applyAbove &&
                range.rules.includes(MeetingRule.SpeakingIndicator) &&
                !range.rules.includes(MeetingRule.VoiceEmbedding) &&
                !range.rules.includes(MeetingRule.Voice) &&
                !range.evidence?.listen &&
                !range.voices?.length &&
                !range.segments?.length
                    ? [range.speaker]
                    : []
            ),
        ].filter((name): name is string => !!name);
        const names = decided.length ? decided : independent;
        const first = names[0];
        if (
            first &&
            names.every((name) => sameName(first, name)) &&
            !covering.some((range) => range.status === "rejected" && range.speaker && sameName(range.speaker, first))
        ) {
            certain.set(line.index, first);
            if (!decided.length && independent.length === 1 && seats.has(line.index)) {
                seatOnlySeeds.add(line.index);
            }
        }
    }
    return { certain, seatOnlySeeds };
}
