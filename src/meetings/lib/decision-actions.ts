import { correctionSchema } from "@genesiscz/utils/meetings/corrections";
import { meetingItemSchema, savedDecisionActorSchema } from "@genesiscz/utils/meetings/record";
import { z } from "zod";
import { sentCommentSchema } from "./comment-schema";
import { findingSchema } from "./findings";

/**
 * The decision journal's saved shapes: one action per decision, and one entry per line of `decisions.ndjson`. Kept
 * apart from decision-journal.ts, so the Meetings service's descriptor (service/api.ts, which every `tools meetings`
 * read imports) can name the actions without loading the journal's rules (about 25 ms).
 */

/** The file in a meeting's folder that keeps its decision journal: one entry per line, oldest first, append-only. */
export const JOURNAL_FILE = "decisions.ndjson";

const itemRef = z.string().min(1);

/** One decision a person, an agent or a rule makes on a meeting. Item references take an id (`i42`) or `Q12`. */
export const DECISION_ACTION_OPTIONS = [
    z.object({
        kind: z.literal("confirm"),
        items: z.array(itemRef),
        /** Every suggested item at or above this confidence instead of `items`. */
        minConfidence: z.number().optional(),
        /** Whose voice a speaker range is. */
        speaker: z.string().optional(),
        /** A term's right spelling, when the proposal is wrong. */
        proposed: z.string().optional(),
    }),
    z.object({ kind: z.literal("reject"), items: z.array(itemRef), minConfidence: z.number().optional() }),
    /** The item's value edited in place (a term's spelling, a range's speaker, a join's word): it is confirmed so. */
    z.object({ kind: z.literal("respell"), item: itemRef, text: z.string() }),
    z.object({ kind: z.literal("answer"), question: itemRef, answer: z.string(), comment: z.string().optional() }),
    z.object({ kind: z.literal("skip"), question: itemRef }),
    /** "Several voices": the question is cut into one question per line and voice. */
    z.object({ kind: z.literal("split"), question: itemRef }),
    /** A diarization label renamed for this meeting; the label's own name removes the rename. */
    z.object({ kind: z.literal("rename"), label: z.string().min(1), name: z.string() }),
    /** Items back to suggested, each to the state before its own last decision. */
    z.object({ kind: z.literal("reopen"), items: z.array(itemRef).min(1) }),
    /** Findings added as suggested items (`items add`): an agent's or a person's suggestions, kept with who made them. */
    z.object({ kind: z.literal("add"), findings: z.array(findingSchema).min(1) }),
    /**
     * The meeting's own fields (`set`): its project (a known name: the caller resolves it first), its title, labels
     * to add and labels to remove.
     */
    z.object({
        kind: z.literal("set"),
        project: z.string().min(1).optional(),
        title: z.string().min(1).optional(),
        labels: z.array(z.string().min(1)).optional(),
        unlabel: z.array(z.string().min(1)).optional(),
    }),
] as const;

export const decisionActionSchema = z.discriminatedUnion("kind", [...DECISION_ACTION_OPTIONS]);
export type DecisionAction = z.infer<typeof decisionActionSchema>;

/** The Undo of one entry (`items`: only these of its items; a question named brings back its whole answer). */
export const revertActionSchema = z.object({
    kind: z.literal("revert"),
    token: z.string().min(1),
    items: z.array(itemRef).optional(),
});

/**
 * Comments sent to the listening agent (`comment.send`, G63): history only, the record does not change, and a sent
 * comment cannot be taken back.
 */
export const commentActionSchema = z.object({
    kind: z.literal("comment"),
    comments: z.array(sentCommentSchema).min(1),
});
export type CommentAction = z.infer<typeof commentActionSchema>;

export const journalActionSchema = z.discriminatedUnion("kind", [
    ...DECISION_ACTION_OPTIONS,
    revertActionSchema,
    commentActionSchema,
]);
export type JournalAction = z.infer<typeof journalActionSchema>;

/** One item a decision changed: its state before (absent: the decision made it) and after (absent: it removed it). */
export const itemChangeSchema = z.object({
    id: z.string(),
    before: meetingItemSchema.optional(),
    after: meetingItemSchema.optional(),
});
export type ItemChange = z.infer<typeof itemChangeSchema>;

/** A speaker label's name before and after (absent: the source's own label). */
export const labelChangeSchema = z.object({
    label: z.string(),
    before: z.string().optional(),
    after: z.string().optional(),
});
export type LabelChange = z.infer<typeof labelChangeSchema>;

/** The meeting fields a `set` changes; each is one value of the record, put back whole by an Undo. */
export const MEETING_FIELDS = ["project", "title", "labels"] as const;

/** One meeting field a decision changed, before and after (absent: no value). */
export const fieldChangeSchema = z.object({
    field: z.enum(MEETING_FIELDS),
    before: z.union([z.string(), z.array(z.string())]).optional(),
    after: z.union([z.string(), z.array(z.string())]).optional(),
});
export type FieldChange = z.infer<typeof fieldChangeSchema>;

export const SKIP_NEEDS = ["speaker", "proposed", "listen", "nothing"] as const;

/**
 * An item a decision named and left, with the reason. `needs`: what decides it, a `speaker` or `proposed` value, or an
 * answer by ear (`listen`); `nothing` when it is decided that way already, which is no failure.
 */
export const skipSchema = z.object({ id: z.string(), reason: z.string(), needs: z.enum(SKIP_NEEDS).optional() });
export type DecisionSkip = z.infer<typeof skipSchema>;

/**
 * One line of the journal: who decided what on a meeting, when and why, and everything it changed, so its token
 * undoes exactly it. `decided`: the items it decided (their status or decision time changed); `settled`: the
 * look-alike questions an answer settled; `corrections`: the ledger lines it wrote; `fields`: the meeting's own fields
 * it changed (`set`).
 */
export const journalEntrySchema = z.object({
    token: z.string().min(1),
    at: z.string().min(1),
    meeting: z.string().min(1),
    /** An actor kind a newer build wrote reads as `unknown`, so its entry still reads and its token still reverts. */
    actor: savedDecisionActorSchema,
    reason: z.string().optional(),
    action: journalActionSchema,
    /** The question it decided (an answer, a skip, a split) or gave back (the Undo of one). */
    question: z.string().optional(),
    decided: z.array(z.string()).default([]),
    settled: z.array(z.string()).default([]),
    skipped: z.array(skipSchema).default([]),
    changes: z.array(itemChangeSchema).default([]),
    labels: z.array(labelChangeSchema).default([]),
    fields: z.array(fieldChangeSchema).optional(),
    corrections: z.array(correctionSchema).default([]),
});
export type JournalEntry = z.infer<typeof journalEntrySchema>;

/** An entry as `read` lists it: `revertedBy` names the later entry that gave back every item it decided. */
export type JournalReadEntry = JournalEntry & { revertedBy?: string };

/** What a decision did: its saved entry, or none when it changed nothing; and what it left, with the reason. */
export interface Decided {
    entry?: JournalEntry;
    skipped: DecisionSkip[];
    /** Notes the action wrote besides its skips (an added finding's transcript anchor that did not match). */
    warnings?: string[];
}
