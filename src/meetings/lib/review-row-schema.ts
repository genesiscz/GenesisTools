import { ITEM_STATUSES, savedDecisionActorSchema } from "@genesiscz/utils/meetings/record";
import { z } from "zod";
import { momentTargetSchema } from "./moment-schema";

/**
 * The shapes of a review row (review-rows.ts): what the window, `tools meetings rows` and the REPL show of one item.
 * Kept apart so the Meetings service's descriptor (service/api.ts, which every `tools meetings` read imports) names
 * them without loading the row builder.
 */

/** A time as a row shows it: the second on the transcript clock and the text the terminal prints for it ("05:09"). */
export const clockTimeSchema = z.object({ sec: z.number(), text: z.string() });
export type ClockTime = z.infer<typeof clockTimeSchema>;

/**
 * A piece of a row's text: plain words, or words that name something a click opens. `target`: a time or a range the
 * text names (R17, R38); `commit`, `workItem`, `document`, `url`: a reference in an item's reason (G19).
 */
export const textPieceSchema = z.object({
    text: z.string(),
    target: momentTargetSchema.optional(),
    commit: z.string().optional(),
    workItem: z.string().optional(),
    document: z.object({ path: z.string(), line: z.number().int().optional() }).optional(),
    url: z.string().optional(),
});
export type TextPiece = z.infer<typeof textPieceSchema>;

const heardContextSchema = z.object({
    before: z.string().optional(),
    lead: z.string(),
    heard: z.string(),
    rest: z.string(),
    after: z.string().optional(),
});

/**
 * One part of a row's question, so it reads as points (R12, R17): who speaks, what was said, when, what the question
 * asks, what its answer settles (with the item ids, G12), and why the engine or an agent suggested it.
 */
export const rowPartSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("who"), text: z.string() }),
    z.object({
        kind: z.literal("said"),
        text: z.string(),
        speaker: z.string().optional(),
        /** A word question's line, with the heard words apart and the lines around it. */
        context: heardContextSchema.optional(),
    }),
    z.object({
        kind: z.literal("when"),
        from: clockTimeSchema,
        to: clockTimeSchema.optional(),
        target: momentTargetSchema,
    }),
    z.object({ kind: z.literal("asks"), pieces: z.array(textPieceSchema) }),
    z.object({ kind: z.literal("settles"), text: z.string(), items: z.array(z.string()) }),
    z.object({ kind: z.literal("reason"), pieces: z.array(textPieceSchema) }),
]);
export type RowPart = z.infer<typeof rowPartSchema>;

/**
 * What a choice is (G1, G2). `suggested`: the engine's proposal; `presumed`: the best candidate that is not the
 * suggested one (GLOSSARY.md); `candidate`: another name or word the engine offers; `heard`: the words as said;
 * `earlier`: the answer of an earlier question about the same words; `none`: none of these; `split`: several voices;
 * `skip`: leave it open.
 */
export const CHOICE_ROLES = [
    "earlier",
    "suggested",
    "presumed",
    "candidate",
    "heard",
    "none",
    "split",
    "skip",
] as const;
export type ChoiceRole = (typeof CHOICE_ROLES)[number];

/** The decision a choice makes on its row's item, as `decision.apply` takes it without the item reference. */
export const choiceActionSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("confirm"), speaker: z.string().optional() }),
    z.object({ kind: z.literal("reject") }),
    z.object({ kind: z.literal("respell"), text: z.string() }),
    z.object({ kind: z.literal("answer"), answer: z.string() }),
    z.object({ kind: z.literal("split") }),
    z.object({ kind: z.literal("skip") }),
]);
export type ChoiceAction = z.infer<typeof choiceActionSchema>;

export const rowChoiceSchema = z.object({
    value: z.string(),
    label: z.string(),
    role: z.enum(CHOICE_ROLES),
    action: choiceActionSchema,
    /** 0 to 1: the item's own for the suggested choice, a candidate's score for the others; absent when none exists. */
    confidence: z.number().min(0).max(1).optional(),
    hint: z.string().optional(),
});
export type RowChoice = z.infer<typeof rowChoiceSchema>;

/** Where a row's evidence comes from (G-SRC-1, G19): a transcript line, a document line, a commit, a work item, a URL. */
export const rowSourceSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("line"),
        at: clockTimeSchema,
        line: z.number().int().optional(),
        text: z.string().optional(),
    }),
    z.object({ kind: z.literal("document"), path: z.string(), line: z.number().int().optional() }),
    z.object({ kind: z.literal("commit"), sha: z.string() }),
    z.object({ kind: z.literal("workItem"), id: z.string() }),
    z.object({ kind: z.literal("url"), url: z.string() }),
]);
export type RowSource = z.infer<typeof rowSourceSchema>;

/** What a row's edit opens (G8): a spelling field, the person picker, the typed answer, or nothing. */
export const ROW_EDITS = ["spelling", "person", "answer", "none"] as const;

/** What a row's item waits for: a speaker, a spelling, or an answer by ear. */
export const ROW_NEEDS = ["speaker", "proposed", "listen"] as const;

export const reviewRowSchema = z.object({
    id: z.string(),
    /** `Q12` for a question (the label `listen` shows, G14), else the item id. */
    label: z.string(),
    kind: z.string(),
    status: z.enum(ITEM_STATUSES),
    confidence: z.number().optional(),
    priority: z.number().optional(),
    /** The one-line text `items` prints. */
    what: z.string(),
    parts: z.array(rowPartSchema),
    choices: z.array(rowChoiceSchema),
    edit: z.enum(ROW_EDITS),
    needs: z.enum(ROW_NEEDS).optional(),
    sources: z.array(rowSourceSchema),
    /** The row's Moment: what its play button plays. */
    target: momentTargetSchema,
    /** The last decision on the item (R35): its journal token, who made it (and in words), its action and reason. */
    decision: z
        .object({
            token: z.string(),
            actor: savedDecisionActorSchema,
            by: z.string(),
            action: z.string(),
            reason: z.string().optional(),
            question: z.string().optional(),
            at: z.string().optional(),
        })
        .optional(),
    /**
     * What a decided row was decided as: a question's answer, a confirmed word's spelling, a confirmed range's
     * speaker. `what` ends in it, but a one-line reader cuts `what` before its end.
     */
    answer: z.string().optional(),
});
export type ReviewRow = z.infer<typeof reviewRowSchema>;

export const reviewRowsSchema = z.object({
    meeting: z.string(),
    rows: z.array(reviewRowSchema),
    /** Open questions under `playback.listen.minPriority` that are left out, as `listen` leaves them (G13). */
    hidden: z.object({ lowPriority: z.number().int(), minPriority: z.number() }),
});
export type ReviewRows = z.infer<typeof reviewRowsSchema>;

/** Changed rows of one locked decision. Before values let a window preserve later concurrent changes. */
export const reviewRowsPatchSchema = z.object({
    meeting: z.string(),
    changes: z.array(
        z.object({ id: z.string(), before: reviewRowSchema.optional(), after: reviewRowSchema.optional() })
    ),
    order: z.array(z.string()),
    hidden: z.object({ before: reviewRowsSchema.shape.hidden, after: reviewRowsSchema.shape.hidden }),
    fields: z.object({
        before: z.object({
            title: z.string(),
            project: z.string().optional(),
            labels: z.array(z.string()),
            speakerLabels: z.record(z.string(), z.string()),
        }),
        after: z.object({
            title: z.string(),
            project: z.string().optional(),
            labels: z.array(z.string()),
            speakerLabels: z.record(z.string(), z.string()),
        }),
    }),
});
export type ReviewRowsPatch = z.infer<typeof reviewRowsPatchSchema>;
