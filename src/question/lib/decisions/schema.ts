import { z } from "zod";

/**
 * The one shape of every decision payload. The store validates with it before the first append,
 * so a malformed row never becomes durable, and the MCP server publishes it inside the
 * `question_post` and `question_update` input schemas, so a client sees the contract the store enforces.
 */

export const DECISION_STATES = [
    "open",
    "drafted",
    "answered",
    "sent",
    "acknowledged",
    "implemented",
    "dismissed",
] as const;

/** The stored item kinds. A `question` item never reaches this store: it is a pending form. */
export const DECISION_KINDS = ["decision", "todo"] as const;

const refSchema = z.object({
    path: z.string().min(1).describe("File the decision points at; the first ref's lines become the excerpt."),
    line: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    sha: z.string().optional(),
});

export const postedDecisionSchema = z.object({
    type: z
        .enum(DECISION_KINDS)
        .optional()
        .describe("decision (default): a numbered ❓ DECISION N. todo: a numbered TODO N, options optional."),
    prompt: z.string().min(1).describe("The question, self-contained."),
    options: z.array(z.string()).default([]).describe("The answer options in order: a), b), c)."),
    excerpt: z.string().optional().describe("Context text. Defaults to up to 40 lines of the first ref."),
    title: z.string().optional(),
    proposal: z.string().optional().describe("The option you would pick."),
    recommended: z.string().optional().describe('The recommended option letter, e.g. "b".'),
    reasoning: z.string().optional(),
    confidence: z.enum(["high", "medium", "low"]).optional(),
    refs: z.array(refSchema).optional(),
    blocking: z.boolean().optional().describe("True when work cannot continue without the answer."),
    for: z.string().optional().describe('Who acts on it: "human", "agent", or a harness or model name like "fable".'),
    reevaluateWhen: z.string().optional().describe('A condition that should reopen it, e.g. "after the PR merges".'),
});

export const postDecisionsInputSchema = z.object({
    sessionId: z.string().optional().describe("Kept only outside a harness; a live harness owns the session."),
    provider: z.string().optional(),
    cwd: z.string().optional(),
    title: z.string().optional().describe("Session title shown beside the decisions."),
    cmuxSurface: z.string().optional(),
    decisions: z.array(postedDecisionSchema).min(1),
});

export const decisionPatchSchema = z.object({
    state: z.enum(DECISION_STATES).optional().describe("The next state; only forward moves are accepted."),
    answer: z.string().optional().describe("The answer text, or a copy of an answer the user gave in chat."),
    option: z
        .string()
        .regex(/^[a-z]+$/)
        .optional()
        .describe('The chosen option letters, e.g. "b", or "ac" when two apply.'),
    draft: z.string().optional().describe("The user's unsent note; an empty string clears it."),
    draftOption: z
        .string()
        .regex(/^[a-z]*$/)
        .optional()
        .describe('The user\'s unsent pick, e.g. "b" or "ac"; an empty string clears it.'),
    commitRefs: z.array(z.string()).optional(),
    verdict: z.string().optional().describe("The outcome, e.g. what was implemented."),
    comment: z.string().optional().describe("Appended to the item's comments."),
});

export const decisionUpdateInputSchema = decisionPatchSchema.extend({
    id: z.string().min(1).describe("Decision or todo id, e.g. d_3_<session> or t_1_<session>."),
});

export const decisionBatchUpdateSchema = z.object({
    updates: z.array(decisionUpdateInputSchema).min(1),
});

/**
 * The fields every reader of a STORED row relies on (the state machine, the sort, the grouping).
 * Other fields pass through untouched. A row without them is skipped on read like a torn line.
 */
export const storedDecisionSchema = z.looseObject({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    type: z.enum(DECISION_KINDS).optional(),
    number: z.number().int(),
    prompt: z.string(),
    options: z.array(z.string()),
    state: z.enum(DECISION_STATES),
    updatedTs: z.string(),
});

export type PostDecisionsInput = z.infer<typeof postDecisionsInputSchema>;
export type DecisionPatch = z.infer<typeof decisionPatchSchema>;
export type DecisionUpdate = z.infer<typeof decisionUpdateInputSchema>;

/** Parses or throws one readable error that names every bad field. */
export function parseDecisionInput<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
    const result = schema.safeParse(value);

    if (!result.success) {
        throw new Error(`invalid ${label}:\n${z.prettifyError(result.error)}`);
    }

    return result.data;
}
