import type { MeetingStore } from "@genesiscz/utils/meetings/record";
import { CommentError, type MeetingComment, MeetingComments } from "../comments";
import { DecisionJournal } from "../decision-journal";
import type { MeetingsParsedParams, MeetingsResult } from "./api";
import { actorOfCall } from "./decision-handlers";
import { type MeetingsCallContext, type MeetingsHandlerDeps, recordOf, refusal } from "./handlers";

/**
 * The Meetings service's comment methods (`comment.stage`, `comment.list`, `comment.unstage`, `comment.send`): comments
 * for the agent that listens to a meeting (R43), kept in its comments.ndjson. Loaded by handlers.ts only when a call
 * comments.
 */

function commentsOf(store: MeetingStore, meeting: string, deps: MeetingsHandlerDeps): MeetingComments {
    return MeetingComments.of(store, meeting, {
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.listenerAlive ? { alive: deps.listenerAlive } : {}),
    });
}

/** A comment step the file refuses, as the service's refusal of the same code. */
function refusing<T>(step: () => T): T {
    try {
        return step();
    } catch (error) {
        if (error instanceof CommentError) {
            throw refusal(error.code, error.message);
        }

        throw error;
    }
}

export function stageComment(
    params: MeetingsParsedParams<"comment.stage">,
    context: MeetingsCallContext,
    store: MeetingStore,
    deps: MeetingsHandlerDeps
): MeetingsResult<"comment.stage"> {
    const record = recordOf(store, params.meeting);
    const comment = commentsOf(store, record.id, deps).stage({
        target: params.target,
        text: params.text,
        ...(params.quote ? { quote: params.quote } : {}),
        actor: actorOfCall(context),
    });
    context.emit?.("comment.changed", { meeting: record.id, comment });
    return comment;
}

export function listComments(
    params: MeetingsParsedParams<"comment.list">,
    store: MeetingStore,
    deps: MeetingsHandlerDeps
): MeetingsResult<"comment.list"> {
    const record = recordOf(store, params.meeting);
    const comments = commentsOf(store, record.id, deps);
    return { meeting: record.id, comments: comments.list(), listeners: comments.listeners() };
}

export function unstageComment(
    params: MeetingsParsedParams<"comment.unstage">,
    context: MeetingsCallContext,
    store: MeetingStore,
    deps: MeetingsHandlerDeps
): MeetingsResult<"comment.unstage"> {
    const record = recordOf(store, params.meeting);
    const comment = refusing(() => commentsOf(store, record.id, deps).unstage(params.id, actorOfCall(context)));
    context.emit?.("comment.changed", { meeting: record.id, comment });
    return comment;
}

export function acknowledgeComment(
    params: MeetingsParsedParams<"comment.read">,
    context: MeetingsCallContext,
    store: MeetingStore,
    deps: MeetingsHandlerDeps
): MeetingsResult<"comment.read"> {
    const record = recordOf(store, params.meeting);
    const comment = refusing(() => commentsOf(store, record.id, deps).acknowledge(params.id, actorOfCall(context)));
    context.emit?.("comment.changed", { meeting: record.id, comment });
    return comment;
}

export function withdrawComment(
    params: MeetingsParsedParams<"comment.withdraw">,
    context: MeetingsCallContext,
    store: MeetingStore,
    deps: MeetingsHandlerDeps
): MeetingsResult<"comment.withdraw"> {
    const record = recordOf(store, params.meeting);
    const comment = refusing(() => commentsOf(store, record.id, deps).withdraw(params.id, actorOfCall(context)));
    context.emit?.("comment.changed", { meeting: record.id, comment });
    return comment;
}

/**
 * Sends the staged comments: the journal entry first (its token names the send), then the file's `sent` line that each
 * listener prints, then `comment.sent` to the subscribers. Nothing staged sends nothing and writes nothing.
 */
export function sendComments(
    params: MeetingsParsedParams<"comment.send">,
    context: MeetingsCallContext,
    store: MeetingStore,
    deps: MeetingsHandlerDeps
): MeetingsResult<"comment.send"> {
    const record = recordOf(store, params.meeting);
    const comments = commentsOf(store, record.id, deps);
    return comments.transaction(() => {
        const staged: MeetingComment[] = refusing(() => comments.staged(params.ids));
        const listeners = comments.listeners();

        if (staged.length === 0 || (params.requireListener && listeners.length === 0)) {
            return { sent: [], listeners };
        }

        const actor = actorOfCall(context);
        const entry = new DecisionJournal({ store, ...(deps.now ? { now: deps.now } : {}) }).note({
            meeting: record.id,
            action: {
                kind: "comment",
                comments: staged.map((comment) => ({
                    id: comment.id,
                    target: comment.target,
                    text: comment.text,
                    ...(comment.quote ? { quote: comment.quote } : {}),
                })),
            },
            actor,
            ...(params.reason ? { reason: params.reason } : {}),
        });
        const sent = comments.markSent(staged, { token: entry.token, at: entry.at, actor });
        context.emit?.("comment.sent", { meeting: record.id, token: entry.token, comments: sent, listeners });
        return { sent, listeners, entry };
    });
}
