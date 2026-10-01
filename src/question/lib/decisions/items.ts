import { loadConfig } from "../config";
import type { AskChoice, CreateAskItemInput } from "../pending/types";
import { notifyPostedDecisions } from "./notify";
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

/** Every key a `question_post` item may carry; anything else is a typo or the decision store's names. */
const ITEM_KEYS = new Set([
    "id",
    "promptMarkdown",
    "choices",
    "allowMultiple",
    "allowFreeText",
    "allowFileTags",
    "allowImagePaste",
    "required",
    "type",
    "for",
    "reevaluateWhen",
    "title",
    "proposal",
    "recommended",
    "reasoning",
    "confidence",
    "refs",
    "blocking",
]);

/** The names agents reach for instead: the decision store's own fields, and the single-question shortcut. */
const KEY_HINTS: Record<string, string> = {
    prompt: "promptMarkdown",
    question: "promptMarkdown",
    text: "promptMarkdown",
    options: "choices",
};

const ITEM_TYPES = new Set(["question", "decision", "todo"]);

/**
 * Checks the items of a post before anything is stored, with an error that names the item, the bad key
 * and the likely intended name. Without it a `prompt`/`options` item reached the decision store as
 * `prompt: undefined` and failed with "expected string at decisions[0].prompt", naming a field the
 * caller never wrote. `help` says where the item shape is documented.
 */
export function validateQuestionItems(value: unknown, help: string): QuestionItemInput[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error(`items must be a non-empty array. ${help}`);
    }

    const problems: string[] = [];

    value.forEach((item, index) => {
        const at = `item ${index + 1}`;

        if (typeof item !== "object" || item === null || Array.isArray(item)) {
            problems.push(`${at} is not an object`);
            return;
        }

        const record = item as Record<string, unknown>;

        for (const key of Object.keys(record)) {
            if (!ITEM_KEYS.has(key)) {
                const hint = KEY_HINTS[key];
                problems.push(`${at}: unknown key "${key}"${hint ? ` (did you mean ${hint}?)` : ""}`);
            }
        }

        if (typeof record.promptMarkdown !== "string" || !record.promptMarkdown.trim()) {
            problems.push(`${at}: promptMarkdown must be a non-empty string`);
        }

        if (record.type !== undefined && !ITEM_TYPES.has(String(record.type))) {
            problems.push(`${at}: type must be question, decision or todo, not "${String(record.type)}"`);
        }

        if (record.choices !== undefined && !Array.isArray(record.choices)) {
            problems.push(`${at}: choices must be an array of labels`);
        }
    });

    if (problems.length > 0) {
        throw new Error(`invalid question items: ${problems.join("; ")}. ${help}`);
    }

    return value as QuestionItemInput[];
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

/**
 * Stores the decision and todo items of a post. Numbers come from the store, never from the caller.
 *
 * The rows that wait for the human raise one banner that opens the hub at the first of them
 * ({@link notifyPostedDecisions}). Like a pending form's banner it is opt-OUT: `notify` defaults to
 * the question config's `notifyPending`, and a caller that must stay silent passes `notify: false`.
 */
export async function postDecisionItems({
    file,
    events,
    items,
    hint,
    deps,
    notify,
}: {
    file: string;
    events: string;
    items: QuestionItemInput[];
    hint: DecisionSessionHint;
    deps?: PostDecisionDeps;
    notify?: boolean;
}): Promise<PostedItems> {
    if (items.length === 0) {
        return { decisions: [], markdown: "" };
    }

    const decisions = await postDecisions(file, events, decisionPayload(items, hint), deps);

    if (notify ?? loadConfig().sinks.notifyPending !== false) {
        await notifyPostedDecisions(decisions);
    }

    return { decisions, markdown: decisionsMarkdown(decisions) };
}
