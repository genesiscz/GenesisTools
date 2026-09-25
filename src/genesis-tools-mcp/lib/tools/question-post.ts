import {
    checkDecisionItems,
    isDecisionId,
    postDecisionItems,
    type QuestionItemInput,
    splitItems,
} from "@app/question/lib/decisions/items";
import { currentHarnessSession, decisionFiles, sessionAnswers } from "@app/question/lib/decisions/read";
import { type DecisionRecord, type PostDecisionDeps, readDecisions } from "@app/question/lib/decisions/store";
import {
    type AskDeps,
    answerAskForm,
    cancelAskForm,
    explainCancelRefusal,
    listPendingForms,
    pollAskForms,
    postAskForm,
    waitForAskForm,
} from "@app/question/lib/pending/ask";
import { summarizeForm } from "@app/question/lib/pending/render";
import type { AskAnswer, AskChoice, AskForm } from "@app/question/lib/pending/types";
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
    items?: QuestionItemInput[];
    timeoutMs?: number;
    source?: string;
    sessionHint?: string;
    wait?: boolean;
    waitTimeoutMs?: number;
}

/** The decision log a post or poll reads and writes. Tests point it at a scratch directory. */
export interface DecisionLogDeps {
    decisionLog?: { file: string; events: string; deps?: PostDecisionDeps; session?: string | null };
}

export type QuestionDeps = AskDeps & DecisionLogDeps;

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

function itemsFrom(args: QuestionPostArgs): QuestionItemInput[] {
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

function decisionLog(deps: QuestionDeps): { file: string; events: string } {
    return deps.decisionLog ?? decisionFiles();
}

/** The decision and todo half of a post: stored, numbered by the store, and rendered for the chat. */
async function postDecisionHalf(args: QuestionPostArgs, items: QuestionItemInput[], deps: QuestionDeps) {
    const { file, events } = decisionLog(deps);

    return postDecisionItems({
        file,
        events,
        items,
        hint: { sessionId: args.sessionHint, cwd: args.projectPath },
        deps: deps.decisionLog?.deps,
    });
}

function describeDecisions(decisions: DecisionRecord[], markdown: string): string {
    return (
        `Posted ${decisions.map((row) => row.id).join(", ")}. Paste this section into your reply as it is ` +
        "(the numbers come from the store, never renumber them). Answers arrive in your next prompt or through " +
        "question_poll; mark them with question_update.\n\n" +
        markdown
    );
}

export async function handleQuestionPost(args: QuestionPostArgs, deps: QuestionDeps = {}): Promise<string> {
    const { questions, decisions } = splitItems(itemsFrom(args));

    if (questions.length === 0) {
        const posted = await postDecisionHalf(args, decisions, deps);
        return describeDecisions(posted.decisions, posted.markdown);
    }

    // Both halves are checked before either is written; see `checkDecisionItems`.
    checkDecisionItems(decisions, { sessionId: args.sessionHint, cwd: args.projectPath });
    const form = await postAskForm(
        {
            projectPath: args.projectPath,
            items: questions,
            timeoutMs: args.timeoutMs,
            source: args.source ?? "mcp",
            sessionHint: args.sessionHint,
        },
        deps
    );
    const posted = decisions.length > 0 ? await postDecisionHalf(args, decisions, deps) : null;
    const suffix = posted ? `\n\n${describeDecisions(posted.decisions, posted.markdown)}` : "";

    if (args.wait !== true) {
        return (
            `Posted ${describe(form)}\n` +
            "It is waiting on the dashboard /qa Pending section. Collect the answer later with " +
            `question_wait or question_poll — do not assume an answer you have not read.${suffix}`
        );
    }

    const result = await waitForAskForm(form.id, args.waitTimeoutMs ?? DEFAULT_WAIT_BUDGET_MS, deps);

    return `waiter: ${result.waiter}\n${SafeJSON.stringify(result.form, null, 2)}${suffix}`;
}

/** Answered decisions of this session the agent has not acknowledged yet. Read-only. */
function unacknowledged(rows: DecisionRecord[], session: string): DecisionRecord[] {
    return sessionAnswers(rows, session).filter((row) => row.state === "answered" || row.state === "sent");
}

export async function handleQuestionWait(args: QuestionWaitArgs, deps: AskDeps = {}): Promise<string> {
    const result = await waitForAskForm(args.id, args.timeoutMs ?? DEFAULT_WAIT_BUDGET_MS, deps);

    if (!result.form) {
        // The status line comes first either way: the tool description promises `waiter`, and
        // an agent that parses it must not have to special-case the one outcome that omits it.
        return `waiter: ${result.waiter}\nunknown form: ${args.id}`;
    }

    return `waiter: ${result.waiter}\n${SafeJSON.stringify(result.form, null, 2)}`;
}

export function handleQuestionPoll(args: QuestionPollArgs, deps: QuestionDeps = {}): string {
    // The MCP dispatch layer does not validate `arguments` against the registered inputSchema
    // before calling this handler, so a malformed call can hand `ids` a bare string here, or an
    // array whose members are not strings. A string is iterable, and `getForms` would otherwise
    // poll one form per CHARACTER; a non-string member would otherwise reach the store lookup
    // and coerce into a bogus key like `[object Object]`.
    if (args.ids !== undefined && (!Array.isArray(args.ids) || args.ids.some((id) => typeof id !== "string"))) {
        throw new Error("question_poll: `ids` must be an array of form ids");
    }

    if (!args.ids?.length) {
        const forms = listPendingForms(deps);
        const session = deps.decisionLog?.session ?? currentHarnessSession();
        const answered = session ? unacknowledged(readDecisions(decisionLog(deps).file), session) : [];
        const formText = forms.length === 0 ? "No pending ask forms." : forms.map(describe).join("\n");

        if (answered.length === 0) {
            return formText;
        }

        return (
            `${formText}\n\nAnswered decisions not yet acknowledged (mark them with question_update):\n` +
            SafeJSON.stringify(answered, null, 2)
        );
    }

    const decisionIds = args.ids.filter(isDecisionId);
    const formIds = args.ids.filter((id) => !isDecisionId(id));
    const rows = decisionIds.length > 0 ? readDecisions(decisionLog(deps).file) : [];
    const decisionParts = decisionIds.map((id) => {
        const row = rows.find((item) => item.id === id);
        return row ? `${id} [${row.state}]\n${SafeJSON.stringify(row, null, 2)}` : `${id} [unknown]`;
    });
    const map = formIds.length > 0 ? pollAskForms(formIds, deps) : {};

    // Named ids mean "I am collecting an answer", and `describe` carries only the status line.
    // Serialize the whole form so `answers` and `entryId` are actually reachable through poll,
    // which is what the tool description tells an agent to do.
    return [
        ...Object.entries(map).map(([id, form]) =>
            form ? `${describe(form)}\n${SafeJSON.stringify(form, null, 2)}` : `${id} [unknown]`
        ),
        ...decisionParts,
    ].join("\n\n");
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
        return explainCancelRefusal(args.id, deps).message;
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
        type: {
            type: "string",
            enum: ["question", "decision", "todo"],
            description:
                "question (default): a pending form the user answers on /qa. decision: a numbered ❓ DECISION N " +
                "(choices are its a) b) c) options). todo: a numbered TODO N. Decisions and todos are stored in " +
                "the session's decision log, never in the form.",
        },
        for: {
            type: "string",
            description: 'decision/todo: who acts on it, "human", "agent", or a harness or model name like "fable"',
        },
        reevaluateWhen: {
            type: "string",
            description: 'decision/todo: a condition that should reopen it, e.g. "after the PR merges"',
        },
        title: { type: "string", description: "decision/todo: short title shown after the number" },
        proposal: { type: "string", description: "decision: what you would do" },
        recommended: { type: "string", description: 'decision: the recommended option letter, e.g. "b"' },
        reasoning: { type: "string", description: "decision: markdown reasoning" },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        refs: {
            type: "array",
            description: "decision: code refs. The FIRST ref's lines are read from disk as the excerpt; never type it.",
            items: {
                type: "object",
                properties: {
                    path: { type: "string" },
                    line: { type: "integer" },
                    endLine: { type: "integer" },
                    sha: { type: "string" },
                },
                required: ["path"],
            },
        },
        blocking: { type: "boolean", description: "decision: true when you cannot continue without the answer" },
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
        projectPath: {
            type: "string",
            description:
                "project the question is about; defaults to the calling harness's cwd (the directory a handoff would stamp), which may differ from the MCP server's own cwd",
        },
        timeoutMs: { type: "number", description: "auto-retire the form after this long" },
        source: { type: "string", description: "who is asking, e.g. your agent or skill name" },
        sessionHint: {
            type: "string",
            description:
                "Optional. Ignored while a harness is running: the poster is gathered the same way as a handoff. Pass it only from a process that is not inside Claude, Codex, or Grok.",
        },
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
    "question_answer, which LOGS a question you have already answered yourself.\n" +
    'Items with type "decision" or "todo" are NOT a form: they are numbered in this session\'s decision log ' +
    "(numbers are session-wide and never reused) and the result is the markdown ❓ DECISION / TODO section to " +
    "paste into your reply. Post every ❓ DECISION you ask this way, several per call. The user answers them in " +
    "the GenesisTools hub; answers reach you in a later prompt or through question_poll, and you record " +
    "progress with question_update.";

export const QUESTION_WAIT_DESCRIPTION =
    "Block until a pending form posted by question_post is answered, cancelled or times out. Returns " +
    "`waiter`: answered | timeout | cancelled | budget_exhausted | not_found. `budget_exhausted` means YOUR " +
    "wait ran out while the form is still pending, so the form is alive and you may wait again. `not_found` " +
    "means no form carries that id, and waiting again will not help.";

export const QUESTION_POLL_DESCRIPTION =
    "Check pending ask forms without blocking. With `ids` it reports those forms (unknown ids included); " +
    "with no arguments it lists everything still waiting for the user, plus this session's answered decisions " +
    "you have not acknowledged yet. Decision and todo ids (d_N_<session>, t_N_<session>) are accepted in `ids` too.";

export const QUESTION_RESPOND_DESCRIPTION =
    "Submit an answer to a pending form. The user normally does this on the dashboard — reach for it only " +
    "for automation, or when you are relaying an answer they gave you elsewhere. Answering also writes the " +
    "Q→A into the history that /qa shows. Never invent an answer the user did not give.";

export const QUESTION_CANCEL_DESCRIPTION =
    "Withdraw a pending form you no longer need answered; any blocked waiter is released as `cancelled`.";
