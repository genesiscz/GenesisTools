import type { AskChoice, CreateAskItemInput } from "../pending/types";
import { decisionsMarkdown } from "./read";
import { parseDecisionInput, postDecisionsInputSchema } from "./schema";
import { type DecisionRecord, type DecisionRef, type PostDecisionDeps, postDecisions } from "./store";

/** What an item is. `question` (the default) is a pending form the user answers on /qa. */
export type QuestionItemType = "question" | "decision" | "todo";

/**
 * One `question_post` item. A `question` uses the pending-form fields; a `decision` or `todo`
 * uses the same `promptMarkdown` and `choices` plus the decision fields, and is stored in the
 * numbered decision log instead of the form store.
 */
export interface QuestionItemInput extends CreateAskItemInput {
    type?: QuestionItemType;
    for?: string;
    reevaluateWhen?: string;
    title?: string;
    proposal?: string;
    recommended?: string;
    reasoning?: string;
    confidence?: "high" | "medium" | "low";
    refs?: DecisionRef[];
    blocking?: boolean;
}

/** Where the decisions of one post belong. A live harness overrides every field it knows. */
export interface DecisionSessionHint {
    sessionId?: string;
    cwd?: string;
}

/** `d_<n>_<session>` or `t_<n>_<session>`: a decision-log id, never a pending form's `ask_…`. */
export function isDecisionId(id: string): boolean {
    return /^[dt]_\d+_/.test(id);
}

function isStored(item: QuestionItemInput): boolean {
    return item.type === "decision" || item.type === "todo";
}

function label(choice: string | AskChoice): string {
    return typeof choice === "string" ? choice : choice.label;
}

/** Splits a mixed batch: questions become one pending form, decisions and todos go to the decision log. */
export function splitItems(items: QuestionItemInput[]): {
    questions: CreateAskItemInput[];
    decisions: QuestionItemInput[];
} {
    const questions: CreateAskItemInput[] = [];
    const decisions: QuestionItemInput[] = [];

    for (const item of items) {
        if (isStored(item)) {
            decisions.push(item);
            continue;
        }

        const { type: _type, ...question } = item;
        questions.push(question);
    }

    return { questions, decisions };
}

/** The decision-log payload for the stored items of a post, in the store's own field names. */
export function decisionPayload(items: QuestionItemInput[], hint: DecisionSessionHint): Record<string, unknown> {
    return {
        ...(hint.sessionId ? { sessionId: hint.sessionId } : {}),
        ...(hint.cwd ? { cwd: hint.cwd } : {}),
        decisions: items.map((item) => ({
            type: item.type,
            prompt: item.promptMarkdown,
            options: (item.choices ?? []).map(label),
            ...(item.title ? { title: item.title } : {}),
            ...(item.proposal ? { proposal: item.proposal } : {}),
            ...(item.recommended ? { recommended: item.recommended } : {}),
            ...(item.reasoning ? { reasoning: item.reasoning } : {}),
            ...(item.confidence ? { confidence: item.confidence } : {}),
            ...(item.refs ? { refs: item.refs } : {}),
            ...(item.blocking === undefined ? {} : { blocking: item.blocking }),
            ...(item.for ? { for: item.for } : {}),
            ...(item.reevaluateWhen ? { reevaluateWhen: item.reevaluateWhen } : {}),
        })),
    };
}

export interface PostedItems {
    decisions: DecisionRecord[];
    /** The ❓ DECISION / TODO section to paste into the chat, numbered by the store. */
    markdown: string;
}

/**
 * Throws the store's own validation error for the decision and todo items of a post, writing nothing.
 * A post that also carries questions calls this before the form: the form is posted next (it throws
 * before its insert on a bad item), and the decisions are stored last, so a failed half never leaves
 * the other one durable for a retry to store again under new numbers.
 */
export function checkDecisionItems(items: QuestionItemInput[], hint: DecisionSessionHint): void {
    if (items.length > 0) {
        parseDecisionInput(postDecisionsInputSchema, decisionPayload(items, hint), "decision post");
    }
}

/** Stores the decision and todo items of a post. Numbers come from the store, never from the caller. */
export async function postDecisionItems({
    file,
    events,
    items,
    hint,
    deps,
}: {
    file: string;
    events: string;
    items: QuestionItemInput[];
    hint: DecisionSessionHint;
    deps?: PostDecisionDeps;
}): Promise<PostedItems> {
    if (items.length === 0) {
        return { decisions: [], markdown: "" };
    }

    const decisions = await postDecisions(file, events, decisionPayload(items, hint), deps);
    return { decisions, markdown: decisionsMarkdown(decisions) };
}
