import { isDeepStrictEqual } from "node:util";
import { MeetingsConflictError } from "@genesiscz/utils/meetings/conflict";
import { type MeetingRecord, nextId, type SpeakerAssignment } from "@genesiscz/utils/meetings/record";
import { LINE_AT_TOLERANCE_SEC, TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import { formatClock } from "@genesiscz/utils/transcribe/render";
import type { SpeakerHint } from "@genesiscz/utils/transcribe/speakers";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import type { AssignmentChange, DecisionAction, DecisionSkip } from "./decision-actions";

/**
 * The decision journal's `assign` (G-SPK-2, R21, R44): lines given to a person for one meeting. The record keeps one
 * `speakers.assignments` entry per source label and stretch, and the corrected transcript applies each as a range of
 * that label (after the items' ranges, so a person's own act wins). No meeting other than this one changes.
 */

type AssignAction = Extract<DecisionAction, { kind: "assign" }>;
type Assigned = Omit<SpeakerAssignment, "id" | "at">;

/** A stretch as a person reads it: `Speaker 3 0:12–0:30`. */
export function assignmentText(assignment: Pick<SpeakerAssignment, "label" | "fromSec" | "toSec">): string {
    const span =
        assignment.fromSec === assignment.toSec
            ? formatClock(assignment.fromSec)
            : `${formatClock(assignment.fromSec)}–${formatClock(assignment.toSec)}`;
    return `${assignment.label} ${span}`;
}

/** Whether an action needs the transcript: a stretch of every label, or a line named by its start. */
export function assignNeedsTranscript(action: AssignAction): boolean {
    return (action.lines?.length ?? 0) > 0 || (action.stretches ?? []).some((stretch) => !stretch.label);
}

/** The labels with a line that starts inside the stretch (the line tolerance at both ends). */
function labelsIn(transcript: readonly TranscriptEntry[], fromSec: number, toSec: number, label?: string): string[] {
    const labels = transcript.flatMap((line) =>
        line.startSec !== undefined &&
        line.text.trim() &&
        line.startSec >= fromSec - LINE_AT_TOLERANCE_SEC &&
        line.startSec <= toSec + LINE_AT_TOLERANCE_SEC &&
        (label === undefined || line.speaker === label)
            ? [line.speaker]
            : []
    );
    return [...new Set(labels)];
}

/**
 * What an `assign` gives the person: one assignment per label and stretch, each line its own one-line stretch. A
 * stretch with no line of its label, or a line that is not there, is skipped with the reason.
 */
export function assignmentsOf(
    action: AssignAction,
    transcript: readonly TranscriptEntry[] | undefined
): { assigned: Assigned[]; skipped: DecisionSkip[] } {
    const person = action.person.trim();
    const email = action.email?.trim() ? { email: action.email.trim() } : {};
    const assigned: Assigned[] = [];
    const skipped: DecisionSkip[] = [];
    const add = (label: string, fromSec: number, toSec: number) => {
        if (!assigned.some((one) => one.label === label && one.fromSec === fromSec && one.toSec === toSec)) {
            assigned.push({ label, fromSec, toSec, person, ...email });
        }
    };

    for (const stretch of action.stretches ?? []) {
        const where = assignmentText({ label: stretch.label ?? "every voice", ...stretch });

        if (stretch.toSec < stretch.fromSec) {
            skipped.push({ id: where, reason: "the stretch ends before it starts", needs: "nothing" });
            continue;
        }

        if (!transcript) {
            // Only a stretch with its label gets here (`assignNeedsTranscript`): it is kept as given.
            if (stretch.label) {
                add(stretch.label, stretch.fromSec, stretch.toSec);
            }

            continue;
        }

        const labels = labelsIn(transcript, stretch.fromSec, stretch.toSec, stretch.label);

        if (labels.length === 0) {
            skipped.push({ id: where, reason: "no line starts in the stretch", needs: "nothing" });
            continue;
        }

        for (const label of labels) {
            add(label, stretch.fromSec, stretch.toSec);
        }
    }

    const lines = transcript ? new TranscriptLines([...transcript]) : undefined;

    for (const point of action.lines ?? []) {
        const found = lines?.resolve(point);
        const line = found?.kind === "found" ? transcript?.[found.index] : undefined;

        if (!line || line.startSec === undefined) {
            const reason =
                found?.kind === "ambiguous"
                    ? `${found.indexes.length} lines start at ${formatClock(point.atSec)}`
                    : `no line starts at ${formatClock(point.atSec)}`;
            skipped.push({ id: `line ${formatClock(point.atSec)}`, reason, needs: "nothing" });
            continue;
        }

        add(line.speaker, line.startSec, line.startSec);
    }

    return { assigned, skipped };
}

/**
 * Puts the assignments into the record: the same label and stretch given again replaces the earlier one (to the same
 * person it changes nothing), anything else is a new `a<n>` entry.
 */
export function putAssignments(record: MeetingRecord, assigned: Assigned[], now: string): void {
    if (assigned.length === 0) {
        return;
    }

    const next = [...(record.speakers.assignments ?? [])];

    for (const one of assigned) {
        const index = next.findIndex(
            (known) => known.label === one.label && known.fromSec === one.fromSec && known.toSec === one.toSec
        );
        const known = index >= 0 ? next[index] : undefined;

        if (known && known.person === one.person && known.email === one.email) {
            continue;
        }

        const saved: SpeakerAssignment = { id: known?.id ?? nextId("a", next), ...one, at: now };

        if (index >= 0) {
            next[index] = saved;
        } else {
            next.push(saved);
        }
    }

    record.speakers.assignments = next;
}

/** The assignments a decision changed, by id: added (no before), changed, or removed (no after). */
export function assignmentChanges(before: SpeakerAssignment[], after: SpeakerAssignment[]): AssignmentChange[] {
    const ids = [...new Set([...before.map((one) => one.id), ...after.map((one) => one.id)])];
    return ids.flatMap((id): AssignmentChange[] => {
        const was = before.find((one) => one.id === id);
        const now = after.find((one) => one.id === id);

        if (isDeepStrictEqual(was, now)) {
            return [];
        }

        return [{ id, ...(was ? { before: was } : {}), ...(now ? { after: now } : {}) }];
    });
}

/**
 * The Undo of an entry's assignment changes: each goes back to its before. One already back needs nothing; one changed
 * again since refuses the Undo with `item-changed`, as an item does.
 */
export function revertAssignments(record: MeetingRecord, changes: AssignmentChange[]): void {
    const current = (id: string) => record.speakers.assignments?.find((one) => one.id === id);
    const pending = changes.filter((change) => !isDeepStrictEqual(current(change.id), change.before));
    const since = pending.filter((change) => !isDeepStrictEqual(current(change.id), change.after));

    if (since.length > 0) {
        throw new MeetingsConflictError(
            "item-changed",
            `the speaker assignment ${since.map((change) => change.id).join(", ")} of ${record.id} changed again after the decision this Undo names; nothing was undone`
        );
    }

    if (pending.length === 0) {
        return;
    }

    let next = [...(record.speakers.assignments ?? [])];

    for (const change of pending) {
        next = next.filter((one) => one.id !== change.id);

        if (change.before) {
            next.push(change.before);
        }
    }

    next.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));

    if (next.length > 0) {
        record.speakers.assignments = next;
    } else {
        delete record.speakers.assignments;
    }
}

/** Why the plan offers a stretch besides the assigned ones (G-SPK-5): never "sounds the same". */
export const ASSIGN_REACH_REASONS = ["hint-range", "present-set"] as const;

/** A stretch an assignment may also reach: the same label's lines there, which a person can play and pick. */
export interface AssignReachStretch {
    label: string;
    fromSec: number;
    toSec: number;
    /** The label's lines in it that the assignment does not cover yet. */
    lines: number;
    why: (typeof ASSIGN_REACH_REASONS)[number];
}

/**
 * What an assignment may also reach (R22 "This also affects", G-SPK-5): the same label inside the attendance hint
 * range that holds the assigned stretch (the engine's own evidence that those lines are one voice), and the same
 * label in the other sections with the same people present. Each with the lines it would move.
 */
export function assignmentReach(options: {
    record: MeetingRecord;
    transcript: readonly TranscriptEntry[];
    hints: readonly SpeakerHint[];
    assigned: readonly SpeakerAssignment[];
}): AssignReachStretch[] {
    const { record, transcript, assigned } = options;
    const covered = (line: TranscriptEntry) =>
        assigned.some(
            (one) =>
                one.label === line.speaker &&
                line.startSec !== undefined &&
                line.startSec >= one.fromSec - LINE_AT_TOLERANCE_SEC &&
                line.startSec <= one.toSec + LINE_AT_TOLERANCE_SEC
        );
    const linesOf = (label: string, fromSec: number, toSec: number) =>
        transcript.filter(
            (line) =>
                line.speaker === label &&
                line.text.trim() &&
                line.startSec !== undefined &&
                line.startSec >= fromSec &&
                line.startSec <= toSec &&
                !covered(line)
        ).length;
    const reach: AssignReachStretch[] = [];
    const offer = (stretch: AssignReachStretch) => {
        const known = reach.some(
            (one) => one.label === stretch.label && one.fromSec === stretch.fromSec && one.toSec === stretch.toSec
        );

        if (stretch.lines > 0 && !known) {
            reach.push(stretch);
        }
    };
    const sections = record.sections ?? [];
    const setOf = (present: string[]) => [...present].sort().join("\n");

    for (const one of assigned) {
        for (const hint of options.hints) {
            if (!("ranges" in hint) || hint.label !== one.label) {
                continue;
            }

            for (const range of hint.ranges) {
                if (range.fromSec <= one.toSec && one.fromSec <= range.toSec) {
                    const lines = linesOf(one.label, range.fromSec, range.toSec);
                    offer({ label: one.label, fromSec: range.fromSec, toSec: range.toSec, lines, why: "hint-range" });
                }
            }
        }

        const home = sections.find((section) => section.fromSec <= one.fromSec && one.fromSec <= section.toSec);

        if (!home) {
            continue;
        }

        for (const section of sections) {
            if (section === home || setOf(section.present) !== setOf(home.present)) {
                continue;
            }

            const lines = linesOf(one.label, section.fromSec, section.toSec);
            offer({ label: one.label, fromSec: section.fromSec, toSec: section.toSec, lines, why: "present-set" });
        }
    }

    return reach.sort((a, b) => a.fromSec - b.fromSec || a.label.localeCompare(b.label));
}

/**
 * G-PPL-4: a rename to a name another label holds already makes both labels one person. The words a plan shows, or
 * nothing.
 */
export function renameJoinsWarning(record: MeetingRecord, label: string, name: string): string | undefined {
    const key = name.trim().normalize("NFC").toLowerCase();
    const others = Object.entries(record.speakers.labels)
        .filter(([other, named]) => other !== label && named.trim().normalize("NFC").toLowerCase() === key)
        .map(([other]) => other);

    if (others.length === 0) {
        return undefined;
    }

    return `${others.join(", ")} ${others.length === 1 ? "is" : "are"} named ${name.trim()} already: ${label} and ${others.join(", ")} become one person`;
}
