/**
 * The post and poll verbs behind every question door (the CLI `tools question ask|poll`, the MCP `question_post` and
 * `question_poll`). A door parses its own input, calls one verb with the full payload and renders the result; the
 * order of a post (split, check both halves, write, then wait) lives here once.
 */
import type { SourceMessage } from "@genesiscz/utils/agent/source-anchor";
import type { TranscludeOptions } from "@genesiscz/utils/transclude";
import {
    checkDecisionItems,
    type DecisionSessionHint,
    isDecisionId,
    type PostedItems,
    postDecisionItems,
    type QuestionItemInput,
    splitItems,
} from "./decisions/items";
import { currentHarnessSession, decisionFiles, sessionAnswers } from "./decisions/read";
import { type DecisionRecord, type PostDecisionDeps, readDecisions } from "./decisions/store";
import {
    type AskDeps,
    listPendingForms,
    pollAskForms,
    postAskForm,
    type WaitResult,
    waitForAskForm,
} from "./pending/ask";
import { type AskForm, DEFAULT_WAIT_BUDGET_MS } from "./pending/types";
import { prepareQuestionItems, type TranscludedItems, transclusionReport } from "./transclude";

/** The decision log a post or poll reads and writes. Tests point it at a scratch directory. */
export interface DecisionLogDeps {
    decisionLog?: { file: string; events: string; deps?: PostDecisionDeps; session?: string | null };
}

/** The stores and seams of both verbs: the pending-form store, the decision log and inline-token resolution. */
export type QuestionVerbDeps = AskDeps &
    DecisionLogDeps & {
        /** Inline-token options (a fake runner, fetch or asset folder in tests; `callerReports` from the CLI). */
        transclude?: Partial<Omit<TranscludeOptions, "cwd" | "label">>;
    };

/** One post, as both doors receive it. `items` are already validated by the door. */
export interface PostQuestionPayload {
    items: QuestionItemInput[];
    projectPath?: string;
    /** Who is asking. Each door supplies its own default (`cli`, `mcp`). */
    source?: string;
    sessionHint?: string;
    sourceMessage?: SourceMessage;
    /** Auto-retire the form after this long. */
    timeoutMs?: number;
    /** How long a `wait` blocks; DEFAULT_WAIT_BUDGET_MS when unset. */
    waitTimeoutMs?: number;
    /** false stores {{…}} tokens as written; the default resolves them at save time. */
    transclude?: boolean;
}

export interface PostQuestionResult {
    /** The pending form of the question items, or null when the post held only decisions and todos. */
    form: AskForm | null;
    /** The decision and todo items, numbered by the store, with their chat markdown. */
    posted: PostedItems;
    tokens: TranscludedItems["tokens"];
    /** One line per failed token, then the summary; empty when nothing was transcluded. */
    report: string[];
    /** Set when `wait` was asked and a form was posted. */
    wait?: WaitResult;
}

function decisionLog(deps: QuestionVerbDeps): { file: string; events: string } {
    return deps.decisionLog ?? decisionFiles();
}

/**
 * Posts one payload: questions become one pending form, decisions and todos go to the decision log.
 *
 * A mixed post checks the decision half first, then posts the form (which throws before its insert on a bad item),
 * then stores the decisions, so a failed half never leaves the other one durable for a retry to store again under
 * new numbers. With `wait`, it then blocks on the form.
 */
export async function postQuestion(
    payload: PostQuestionPayload,
    options: { wait?: boolean } = {},
    deps: QuestionVerbDeps = {}
): Promise<PostQuestionResult> {
    const transcluded = await prepareQuestionItems({
        items: payload.items,
        cwd: payload.projectPath,
        transclude: payload.transclude !== false,
        options: deps.transclude,
    });
    const report = transclusionReport(transcluded.tokens);
    const { questions, decisions } = splitItems(transcluded.items);
    const hint: DecisionSessionHint = {
        sessionId: payload.sessionHint,
        cwd: payload.projectPath,
        sourceMessage: payload.sourceMessage,
    };
    const { file, events } = decisionLog(deps);
    const storeDecisions = () =>
        postDecisionItems({ file, events, items: decisions, hint, deps: deps.decisionLog?.deps, notify: deps.notify });

    if (questions.length === 0) {
        return { form: null, posted: await storeDecisions(), tokens: transcluded.tokens, report };
    }

    checkDecisionItems(decisions, hint);
    const form = await postAskForm(
        {
            projectPath: payload.projectPath,
            items: questions,
            timeoutMs: payload.timeoutMs,
            source: payload.source,
            sessionHint: payload.sessionHint,
            sourceMessage: payload.sourceMessage,
        },
        deps
    );
    const posted = await storeDecisions();
    const result: PostQuestionResult = { form, posted, tokens: transcluded.tokens, report };

    if (options.wait !== true) {
        return result;
    }

    return { ...result, wait: await waitForAskForm(form.id, payload.waitTimeoutMs ?? DEFAULT_WAIT_BUDGET_MS, deps) };
}

export interface PollQuestionsInput {
    /** Form ids and decision or todo ids; empty or unset lists everything still pending. */
    ids?: string[];
}

export type PollQuestionsResult =
    | {
          kind: "pending";
          forms: AskForm[];
          /** This session's answered decisions the agent has not acknowledged yet. */
          answered: DecisionRecord[];
      }
    | {
          kind: "ids";
          /** Each named form id, null when unknown. */
          forms: Record<string, AskForm | null>;
          /** Each named decision or todo id in the order asked, row null when unknown. */
          decisions: Array<{ id: string; row: DecisionRecord | null }>;
      };

/** Answered decisions of this session the agent has not acknowledged yet. Read-only. */
function unacknowledged(rows: DecisionRecord[], session: string): DecisionRecord[] {
    return sessionAnswers(rows, session).filter((row) => row.state === "answered" || row.state === "sent");
}

/** Reads pending forms and decisions together, without blocking. Read-only. */
export function pollQuestions(input: PollQuestionsInput, deps: QuestionVerbDeps = {}): PollQuestionsResult {
    if (!input.ids?.length) {
        const forms = listPendingForms(deps);
        const session = deps.decisionLog?.session ?? currentHarnessSession();
        const answered = session ? unacknowledged(readDecisions(decisionLog(deps).file), session) : [];
        return { kind: "pending", forms, answered };
    }

    const decisionIds = input.ids.filter(isDecisionId);
    const formIds = input.ids.filter((id) => !isDecisionId(id));
    const rows = decisionIds.length > 0 ? readDecisions(decisionLog(deps).file) : [];

    return {
        kind: "ids",
        forms: formIds.length > 0 ? pollAskForms(formIds, deps) : {},
        decisions: decisionIds.map((id) => ({ id, row: rows.find((item) => item.id === id) ?? null })),
    };
}
