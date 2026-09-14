import {
    type AskDeps,
    answerAskForm,
    cancelAskForm,
    getAskForm,
    listPendingForms,
    pollAskForms,
    postAskForm,
    waitForAskForm,
} from "@app/question/lib/pending/ask";
import { summarizeForm } from "@app/question/lib/pending/render";
import type { AskAnswer, AskChoice, AskForm, CreateAskItemInput } from "@app/question/lib/pending/types";
import { DEFAULT_WAIT_BUDGET_MS } from "@app/question/lib/pending/types";
import { SafeJSON } from "@genesiscz/utils/json";

export interface QuestionPostArgs {
    projectPath?: string;
    question?: string;
    choices?: Array<string | AskChoice>;
    allowMultiple?: boolean;
    allowFreeText?: boolean;
    allowFileTags?: boolean;
    allowImagePaste?: boolean;
    required?: boolean;
    items?: CreateAskItemInput[];
    timeoutMs?: number;
    source?: string;
    sessionHint?: string;
    wait?: boolean;
    waitTimeoutMs?: number;
}

export interface QuestionWaitArgs {
    id: string;
    timeoutMs?: number;
}

export interface QuestionPollArgs {
    ids?: string[];
}

export interface QuestionRespondArgs {
    id: string;
    answers: AskAnswer[];
}

export interface QuestionCancelArgs {
    id: string;
}

function itemsFrom(args: QuestionPostArgs): CreateAskItemInput[] {
    if (args.items?.length) {
        return args.items;
    }

    if (!args.question?.trim()) {
        throw new Error("question_post needs either `question` or a non-empty `items` array");
    }

    return [
        {
            promptMarkdown: args.question,
            choices: args.choices,
            allowMultiple: args.allowMultiple,
            allowFreeText: args.allowFreeText,
            allowFileTags: args.allowFileTags,
            allowImagePaste: args.allowImagePaste,
            required: args.required,
        },
    ];
}

function describe(form: AskForm): string {
    return `${form.id} [${form.status}] ${summarizeForm(form)}`;
}

export async function handleQuestionPost(args: QuestionPostArgs, deps: AskDeps = {}): Promise<string> {
    const form = await postAskForm(
        {
            projectPath: args.projectPath ?? process.cwd(),
            items: itemsFrom(args),
            timeoutMs: args.timeoutMs,
            source: args.source ?? "mcp",
            sessionHint: args.sessionHint,
        },
        deps
    );

    if (args.wait !== true) {
        return (
            `Posted ${describe(form)}\n` +
            "It is waiting on the dashboard /qa Pending section. Collect the answer later with " +
            "question_wait or question_poll — do not assume an answer you have not read."
        );
    }

    const result = await waitForAskForm(form.id, args.waitTimeoutMs ?? DEFAULT_WAIT_BUDGET_MS, deps);

    return `waiter: ${result.waiter}\n${SafeJSON.stringify(result.form, null, 2)}`;
}

export async function handleQuestionWait(args: QuestionWaitArgs, deps: AskDeps = {}): Promise<string> {
    const result = await waitForAskForm(args.id, args.timeoutMs ?? DEFAULT_WAIT_BUDGET_MS, deps);

    if (!result.form) {
        return `unknown form: ${args.id}`;
    }

    return `waiter: ${result.waiter}\n${SafeJSON.stringify(result.form, null, 2)}`;
}

export function handleQuestionPoll(args: QuestionPollArgs, deps: AskDeps = {}): string {
    if (!args.ids?.length) {
        const forms = listPendingForms(deps);

        if (forms.length === 0) {
            return "No pending ask forms.";
        }

        return forms.map(describe).join("\n");
    }

    const map = pollAskForms(args.ids, deps);

    return Object.entries(map)
        .map(([id, form]) => (form ? describe(form) : `${id} [unknown]`))
        .join("\n");
}

export async function handleQuestionRespond(args: QuestionRespondArgs, deps: AskDeps = {}): Promise<string> {
    const outcome = await answerAskForm(args.id, args.answers ?? [], deps);

    if (!outcome.ok) {
        return `${outcome.code}: ${outcome.error}${outcome.missing?.length ? ` (missing: ${outcome.missing.join(", ")})` : ""}`;
    }

    return `Answered ${outcome.form.id}; logged to the Q→A history as ${outcome.entryId}.`;
}

export function handleQuestionCancel(args: QuestionCancelArgs, deps: AskDeps = {}): string {
    const form = cancelAskForm(args.id, deps);

    if (!form) {
        const existing = getAskForm(args.id, deps);

        return existing ? `form ${args.id} is already ${existing.status}` : `unknown form: ${args.id}`;
    }

    return `Cancelled ${form.id}. Any blocked waiter is released as cancelled.`;
}

const ITEM_SCHEMA = {
    type: "object",
    properties: {
        id: { type: "string", description: "stable item id; auto-assigned q1, q2, … when omitted" },
        promptMarkdown: { type: "string", description: "the question, markdown ok" },
        choices: {
            type: "array",
            description: "plain labels, or {id,label} objects",
            items: {
                anyOf: [
                    { type: "string" },
                    {
                        type: "object",
                        properties: { id: { type: "string" }, label: { type: "string" } },
                        required: ["id", "label"],
                    },
                ],
            },
        },
        allowMultiple: { type: "boolean", description: "more than one choice may be picked (default false)" },
        allowFreeText: { type: "boolean", description: "offer a free-text box (default true)" },
        allowFileTags: { type: "boolean", description: "allow @file tags relative to the form cwd (default false)" },
        allowImagePaste: { type: "boolean", description: "allow pasted images (default false)" },
        required: { type: "boolean", description: "must be answered before the form can be submitted (default true)" },
    },
    required: ["promptMarkdown"],
} as const;

export const QUESTION_POST_INPUT_SCHEMA = {
    type: "object",
    properties: {
        question: { type: "string", description: "single-question shortcut; use `items` for a multi-question form" },
        choices: ITEM_SCHEMA.properties.choices,
        allowMultiple: { type: "boolean" },
        allowFreeText: { type: "boolean" },
        allowFileTags: { type: "boolean" },
        allowImagePaste: { type: "boolean" },
        required: { type: "boolean" },
        items: { type: "array", description: "multi-question form", items: ITEM_SCHEMA },
        projectPath: { type: "string", description: "project the question is about; defaults to the server cwd" },
        timeoutMs: { type: "number", description: "auto-retire the form after this long" },
        source: { type: "string", description: "who is asking, e.g. your agent or skill name" },
        sessionHint: { type: "string", description: "your session id, so the answer links back to this session" },
        wait: {
            type: "boolean",
            description:
                "block until answered. Default FALSE — a blocking-by-default ask hangs agent loops. " +
                "Set true only when you genuinely cannot continue without the answer.",
        },
        waitTimeoutMs: { type: "number", description: "how long `wait` blocks before giving up (default 120000)" },
    },
} as const;

export const QUESTION_WAIT_INPUT_SCHEMA = {
    type: "object",
    properties: {
        id: { type: "string", description: "the form id question_post returned" },
        timeoutMs: { type: "number", description: "how long to block before giving up (default 120000)" },
    },
    required: ["id"],
} as const;

export const QUESTION_POLL_INPUT_SCHEMA = {
    type: "object",
    properties: {
        ids: {
            type: "array",
            description: "form ids to check; omit to list everything still pending",
            items: { type: "string" },
        },
    },
} as const;

export const QUESTION_RESPOND_INPUT_SCHEMA = {
    type: "object",
    properties: {
        id: { type: "string", description: "the form id" },
        answers: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    itemId: { type: "string" },
                    freeText: { type: "string" },
                    selectedChoices: { type: "array", items: { type: "string" } },
                    fileTags: { type: "array", items: { type: "string" } },
                },
                required: ["itemId"],
            },
        },
    },
    required: ["id", "answers"],
} as const;

export const QUESTION_CANCEL_INPUT_SCHEMA = {
    type: "object",
    properties: { id: { type: "string", description: "the form id to withdraw" } },
    required: ["id"],
} as const;

export const QUESTION_POST_DESCRIPTION =
    "ASK the user a question and leave it PENDING until they answer it. Use this when you need a decision " +
    "before you can continue — a choice between approaches, a go/no-go, a missing value only they know. The " +
    "form appears on the dev-dashboard /qa Pending section and raises a notification. Default is " +
    "NON-BLOCKING: you get a form id back immediately, and you collect the answer with question_wait or " +
    "question_poll. Pass wait: true only when you truly cannot proceed without it. This is the opposite of " +
    "question_answer, which LOGS a question you have already answered yourself.";

export const QUESTION_WAIT_DESCRIPTION =
    "Block until a pending form posted by question_post is answered, cancelled or times out. Returns " +
    "`waiter`: answered | timeout | cancelled | budget_exhausted. `budget_exhausted` means YOUR wait ran out " +
    "while the form is still pending — the form is alive and you may wait again.";

export const QUESTION_POLL_DESCRIPTION =
    "Check pending ask forms without blocking. With `ids` it reports those forms (unknown ids included); " +
    "with no arguments it lists everything still waiting for the user.";

export const QUESTION_RESPOND_DESCRIPTION =
    "Submit an answer to a pending form. The user normally does this on the dashboard — reach for it only " +
    "for automation, or when you are relaying an answer they gave you elsewhere. Answering also writes the " +
    "Q→A into the history that /qa shows. Never invent an answer the user did not give.";

export const QUESTION_CANCEL_DESCRIPTION =
    "Withdraw a pending form you no longer need answered; any blocked waiter is released as `cancelled`.";
