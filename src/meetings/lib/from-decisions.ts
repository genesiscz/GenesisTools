import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import { seatSpan } from "@genesiscz/utils/meetings/seats";
import { sameName } from "@genesiscz/utils/transcribe/speakers";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { z } from "zod";
import { type Finding, PLAIN_WORDS } from "./findings";
import { personInitials } from "./person-initials";
import { hasCodeWord } from "./reason-words";

/** The speaker a decision gives a line whose label tracks no one person there. */
export const UNSURE_SPEAKER = "?";

/**
 * The speaker a reader decided for one transcript line: a person of the meeting by name (in any case) or by the
 * initial a legend prints, or `"?"` for nobody in particular.
 */
export interface LineDecision {
    /** The line's index in the source transcript, as `evidence` numbers it. */
    idx: number;
    speaker: string | typeof UNSURE_SPEAKER;
    confidence: number;
    /** Why, in plain words for the person who reviews the meeting, as an item's reason. */
    reason: string;
}

const text = z.string().trim().min(1);

export const lineDecisionSchema = z.object({
    idx: z.number().int().min(0),
    speaker: text,
    confidence: z.number().min(0).max(1),
    reason: text.refine((reason) => !hasCodeWord(reason), PLAIN_WORDS),
});

/** A decisions file: an array of line decisions, or `{ decisions: [...] }`. */
export const decisionsFileSchema = z.union([
    z.array(lineDecisionSchema),
    z.object({ decisions: z.array(lineDecisionSchema) }).transform((file) => file.decisions),
]);

/** The meeting decisions are read against: the record names its people and each label's, `idx` counts its transcript. */
export interface DecisionMeeting {
    record: Pick<MeetingRecord, "speakers" | "participants" | "seats">;
    transcript: readonly TranscriptEntry[];
}

/** The people a decision may name: the meeting's participants, the names its labels were given and its seats. */
export function decisionPeople(record: DecisionMeeting["record"]): string[] {
    const names = [
        ...record.participants.map((person) => person.name),
        ...Object.values(record.speakers.labels),
        ...(record.seats?.room ?? []).map((row) => seatSpan(row).name),
        ...(record.seats?.remote ?? []).map((row) => row.name),
    ];
    return names.filter(
        (name, index) => names.findIndex((other) => other.toLowerCase() === name.toLowerCase()) === index
    );
}

/** The person a decision's speaker names (their name in any case, or their initial), `"?"`, or nothing. */
function speakerResolver(people: readonly string[]): (speaker: string) => string | undefined {
    const byKey = new Map(people.map((name) => [name.toLowerCase(), name]));

    for (const [name, initial] of personInitials(people)) {
        if (!byKey.has(initial.toLowerCase())) {
            byKey.set(initial.toLowerCase(), name);
        }
    }

    return (speaker) => (speaker === UNSURE_SPEAKER ? UNSURE_SPEAKER : byKey.get(speaker.toLowerCase()));
}

function knownPeopleText(people: readonly string[]): string {
    const initials = personInitials(people);
    return people.length > 0
        ? `known people: ${people.map((name) => `${name} (${initials.get(name)})`).join(", ")}; "?" names nobody in particular`
        : 'the meeting knows no people yet (no participants, seats or named labels); "?" names nobody in particular';
}

/** Lines of one label that one finding covers. */
interface Group {
    label: string;
    speaker: string;
    reason: string;
    /** The line shares its start second with another line, so its finding names it by index and takes no other line. */
    alone: boolean;
    lines: number[];
    decisions: LineDecision[];
}

/**
 * Why these decisions cannot be read against the meeting, one line per decision, and the people it knows when one
 * names someone else; empty when they can.
 */
export function decisionProblems(meeting: DecisionMeeting, decisions: readonly LineDecision[]): string[] {
    const seen = new Set<number>();
    const people = decisionPeople(meeting.record);
    const resolve = speakerResolver(people);
    let unknown = false;

    const problems = decisions.flatMap((decision, index) => {
        const where = `#${index + 1} (line ${decision.idx})`;
        const entry = meeting.transcript[decision.idx];

        if (!entry) {
            return [`${where} is past the last transcript line, ${meeting.transcript.length - 1}`];
        }

        if (entry.startSec === undefined) {
            return [`${where} has no start time, so no finding can name it`];
        }

        if (seen.has(decision.idx)) {
            return [`${where} is decided twice`];
        }

        seen.add(decision.idx);

        if (resolve(decision.speaker) === undefined) {
            unknown = true;
            return [`${where} names "${decision.speaker}", whom the meeting does not know`];
        }

        return [];
    });
    return unknown ? [...problems, knownPeopleText(people)] : problems;
}

/**
 * The findings that give each decided line its speaker. A line decided to its label's own person adds nothing. The
 * next lines of one label (lines of other labels between them do not count) with one decided speaker and one reason
 * become one speaker range from the first line's start to the last line's start, at the lowest confidence. A line
 * that shares its start second with another line gets a finding of its own that names it by `line`. `"?"` lines group
 * the same way into a label finding with `meaningless`. A speaker is named by the person's full name, so a name and
 * an initial of one person group together. A decision the meeting cannot place throws.
 */
export function findingsFromDecisions(meeting: DecisionMeeting, decisions: readonly LineDecision[]): Finding[] {
    const problems = decisionProblems(meeting, decisions);

    if (problems.length > 0) {
        throw new Error(problems.join("; "));
    }

    const { transcript } = meeting;
    const resolve = speakerResolver(decisionPeople(meeting.record));
    const decided = new Map(decisions.map((decision) => [decision.idx, decision]));
    const linesPerSecond = new Map<number, number>();

    for (const entry of transcript) {
        if (entry.startSec !== undefined) {
            const second = Math.floor(entry.startSec);
            linesPerSecond.set(second, (linesPerSecond.get(second) ?? 0) + 1);
        }
    }

    const groups: Group[] = [];
    // Per label, the group its next line can still join.
    const open = new Map<string, Group>();

    transcript.forEach((entry, index) => {
        const label = entry.speaker;
        const decision = decided.get(index);
        const speaker = decision ? resolve(decision.speaker)! : undefined;
        const person = meeting.record.speakers.labels[label] ?? label;

        if (!decision || !speaker || (speaker !== UNSURE_SPEAKER && sameName(speaker, person))) {
            open.delete(label);
            return;
        }

        const alone = (linesPerSecond.get(Math.floor(entry.startSec!)) ?? 0) > 1;
        const current = open.get(label);

        if (current && !alone && !current.alone && current.speaker === speaker && current.reason === decision.reason) {
            current.lines.push(index);
            current.decisions.push(decision);
            return;
        }

        const group: Group = {
            label,
            speaker,
            reason: decision.reason,
            alone,
            lines: [index],
            decisions: [decision],
        };
        groups.push(group);
        open.set(label, group);
    });

    return groups
        .flatMap((group) => exactGroups(group, transcript))
        .sort((a, b) => a.lines[0]! - b.lines[0]!)
        .map((group) => findingOf(group, transcript));
}

/**
 * A range reaches every line of its label that starts in it. When lines out of time order would put another line of
 * the label inside a group's range, the group splits into one finding per line.
 */
function exactGroups(group: Group, transcript: readonly TranscriptEntry[]): Group[] {
    if (group.lines.length === 1) {
        return [group];
    }

    const { from, to } = span(group, transcript);
    const reached = transcript.filter(
        (entry) =>
            entry.speaker === group.label &&
            entry.startSec !== undefined &&
            entry.startSec >= from &&
            entry.startSec <= to
    ).length;

    if (reached === group.lines.length) {
        return [group];
    }

    return group.lines.map((line, index) => ({ ...group, lines: [line], decisions: [group.decisions[index]!] }));
}

function span(group: Group, transcript: readonly TranscriptEntry[]): { from: number; to: number } {
    const starts = group.lines.map((line) => transcript[line]!.startSec!);
    return { from: Math.min(...starts), to: Math.max(...starts) };
}

function findingOf(group: Group, transcript: readonly TranscriptEntry[]): Finding {
    const { from, to } = span(group, transcript);
    const confidence = Math.min(...group.decisions.map((decision) => decision.confidence));

    if (group.speaker === UNSURE_SPEAKER) {
        return { kind: "label", from, to, label: group.label, meaningless: true, confidence, reason: group.reason };
    }

    return {
        kind: "speaker-range",
        from,
        to,
        label: group.label,
        speaker: group.speaker,
        ...(group.alone ? { line: group.lines[0] } : {}),
        confidence,
        reason: group.reason,
    };
}
