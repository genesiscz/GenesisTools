import { closeQuestion, openQuestions, upsertQuestion } from "@genesiscz/utils/agents/dialogs/store";
import { type OpenQuestion, openQuestionKey } from "@genesiscz/utils/agents/dialogs/types";
import { questionCountOf, questionOptionsOf, questionTextOf } from "@genesiscz/utils/ai/transcripts/turn-state";
import type { HooksConfig } from "./config";
import { type HookPayload, normalizeEvent } from "./payload";
import { QUESTION_TOOL_KINDS } from "./questions-gate";

/** What one hook call does to the session's dialog records. */
export interface QuestionHookAction {
    /** A question to record; the same key again only updates it. */
    ask?: OpenQuestion;
    /** The tool call whose question was just answered (its PostToolUse or PostToolUseFailure). */
    answered?: string;
    /** Which other open records of the session close: its permission prompts, or every one of them. */
    closes: "none" | "permissions" | "all";
}

const PLAN_QUESTION = "Approve the plan?";
const PERMISSION_QUESTION = "Permission needed";

/**
 * The record change a hook payload asks for, or null when it says nothing about a question. Pure: the caller applies
 * it (`applyQuestionHookAction`).
 *
 * - PreToolUse on a question tool: an open `decision` (AskUserQuestion, Grok `ask_user_question`) or `plan`
 *   (ExitPlanMode, `exit_plan_mode`), keyed by the call's `tool_use_id`. A payload without one is left to the hub
 *   watcher, which keys the same question by the transcript's id, so the two never post it twice.
 * - Notification `permission_prompt`: an open `permission` keyed `permission:<ISO time>`, since the payload names no
 *   call.
 * - PostToolUse or PostToolUseFailure: the call's own question is answered, and every open permission prompt of the
 *   session closes, because the harness only runs a tool after its prompt was answered.
 * - UserPromptSubmit and SessionEnd: every open record closes; a session at its prompt shows no dialog.
 */
export function questionHookAction(payload: HookPayload, now: string): QuestionHookAction | null {
    if (!payload.sessionId) {
        return null;
    }

    const event = normalizeEvent(payload.event);
    const toolKind = QUESTION_TOOL_KINDS[payload.tool];

    if (event === "pretooluse") {
        if (!toolKind || !payload.toolUseId) {
            return null;
        }

        const options = toolKind === "decision" ? questionOptionsOf(payload.toolInput) : undefined;
        const questionCount = toolKind === "decision" ? questionCountOf(payload.toolInput) : undefined;

        return {
            ask: {
                provider: payload.harness,
                sessionId: payload.sessionId,
                toolCallId: payload.toolUseId,
                kind: toolKind,
                question: (toolKind === "plan" ? PLAN_QUESTION : questionTextOf(payload.toolInput)) ?? "",
                ...(options ? { options } : {}),
                ...(questionCount ? { questionCount } : {}),
                askedAt: now,
                source: "hook",
            },
            closes: "none",
        };
    }

    if (event === "notification") {
        if (payload.notificationType !== "permission_prompt") {
            return null;
        }

        return {
            ask: {
                provider: payload.harness,
                sessionId: payload.sessionId,
                toolCallId: `permission:${now}`,
                kind: "permission",
                question: payload.notificationMessage?.trim() || PERMISSION_QUESTION,
                askedAt: now,
                source: "hook",
            },
            closes: "none",
        };
    }

    if (event === "posttooluse" || event === "posttoolusefailure") {
        return {
            ...(toolKind && payload.toolUseId ? { answered: payload.toolUseId } : {}),
            closes: "permissions",
        };
    }

    if (event === "userpromptsubmit" || event === "sessionend") {
        return { closes: "all" };
    }

    return null;
}

/** What `applyQuestionHookAction` changed, for the hooks log. */
export interface QuestionHookResult {
    recorded: string | null;
    closed: string[];
}

/** Applies the action to the session's dialog records; `root` is the records root, for tests. */
export function applyQuestionHookAction(
    payload: HookPayload,
    action: QuestionHookAction,
    { now, root }: { now: string; root?: string }
): QuestionHookResult {
    const sessionId = payload.sessionId;

    if (!sessionId) {
        return { recorded: null, closed: [] };
    }

    if (action.ask) {
        upsertQuestion(action.ask, root);
    }

    // Only open records close: an answered one keeps the time it was answered at.
    const closing = openQuestions(payload.harness, sessionId, root)
        .filter(
            (open) =>
                open.toolCallId === action.answered ||
                action.closes === "all" ||
                (action.closes === "permissions" && open.kind === "permission")
        )
        .map((open) => open.toolCallId);
    const closed: string[] = [];

    for (const toolCallId of closing) {
        const done = closeQuestion({ provider: payload.harness, sessionId, toolCallId }, now, root);

        if (done) {
            closed.push(openQuestionKey(done));
        }
    }

    return { recorded: action.ask ? openQuestionKey(action.ask) : null, closed };
}

/** Whether the questions feature is on for the harness this payload came from. */
export function questionsOn(config: HooksConfig, payload: HookPayload): boolean {
    return config.questions.harnesses[payload.harness];
}
