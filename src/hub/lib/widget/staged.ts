import { loadHooksConfig } from "@app/agents/lib/hooks/config";
import type { DeliverDeps } from "@app/question/lib/decisions/deliver";
import { decisionFiles } from "@app/question/lib/decisions/read";
import { sendAnsweredDecisions } from "@app/question/lib/decisions/send";
import {
    awaitsDelivery,
    type DecisionRecord,
    kindOf,
    readDecisions,
    updateDecisions,
} from "@app/question/lib/decisions/store";
import { answerInboxDecisions, type InboxAnswerResult } from "@app/question/lib/inbox/answer";
import { waitingBlock } from "@app/question/lib/inbox/load";
import { logger } from "@genesiscz/utils/logger";

/** Where a session's answers go: the widget's target for it (the decision row alone has no source home). */
export interface StagedTarget {
    provider?: string;
    sourceHome?: string;
    cwd?: string;
}

export interface StagedSendResult {
    /**
     * One entry per session, in the order the sessions first appear in `ids`. `deliversLater`: answers no receiver
     * took still reach the session by themselves (the decisions hook injects queued answers at its next prompt, or a
     * session-queue entry was saved); false means only a later send delivers them.
     */
    sessions: Array<{
        session: string;
        numbers: number[];
        result?: InboxAnswerResult;
        error?: string;
        deliversLater?: boolean;
    }>;
    /** Answers a receiver took. */
    sent: number;
    /** Answers stored and waiting for the session's next prompt: no receiver took them. */
    queued: number;
    failed: number;
}

/**
 * Whether an answer no receiver took reaches its session by itself: a saved session-queue entry is consumed by the
 * session, and the decisions hook (`decisions.injectAnswers`) puts queued answers into its next prompt. Without
 * either, only a later send delivers it, and the widget must not say "it waits for the next prompt".
 */
function deliversLater(queueId: string | undefined): boolean {
    return queueId !== undefined || loadHooksConfig().decisions.injectAnswers === true;
}

/**
 * A staged decision: the user picked an option or wrote a note in an inbox and has not sent it. It is the decision
 * log's own unsent state (`drafted` with `draftOption` or `draft`), so the hub, the widget and the CLI see one list.
 */
export function isStaged(row: DecisionRecord): boolean {
    return kindOf(row) === "decision" && row.state === "drafted" && Boolean(row.draftOption || row.draft?.trim());
}

/**
 * Sends the staged decisions `ids` as their answers: one message per session, through `answerInboxDecisions`, the
 * path the inbox and the hub's Decisions pane send with. A session that fails keeps its decisions staged and is
 * reported; the other sessions still go. An id that is not staged (sent meanwhile, unstaged) is skipped.
 */
export async function sendStagedDecisions({
    ids,
    targets = {},
    files = decisionFiles(),
    deliver = {},
}: {
    ids: readonly string[];
    targets?: Record<string, StagedTarget>;
    files?: { file: string; events: string };
    deliver?: DeliverDeps;
}): Promise<StagedSendResult> {
    const wanted = new Set(ids);
    const staged = readDecisions(files.file).filter((row) => wanted.has(row.id) && isStaged(row));
    const bySession = new Map<string, DecisionRecord[]>();

    for (const id of ids) {
        const row = staged.find((entry) => entry.id === id);

        if (!row) {
            // Sent, discarded or answered meanwhile: nothing to send for it, and the reply must not read as a send.
            logger.warn({ id }, "widget send-staged: decision is no longer staged");
            continue;
        }

        bySession.set(row.sessionId, [...(bySession.get(row.sessionId) ?? []), row]);
    }

    const result: StagedSendResult = { sessions: [], sent: 0, queued: 0, failed: 0 };

    for (const [session, rows] of bySession) {
        const target = targets[session] ?? {};
        const numbers = rows.map((row) => row.number);
        const provider = target.provider ?? rows[0]?.provider;
        const cwd = target.cwd ?? rows[0]?.cwd;

        try {
            const sent = await answerInboxDecisions(
                {
                    session,
                    ...(provider ? { provider } : {}),
                    ...(target.sourceHome ? { sourceHome: target.sourceHome } : {}),
                    ...(cwd ? { cwd } : {}),
                    answers: rows.map((row) => ({
                        number: row.number,
                        expectedRevision: row.revision ?? 1,
                        ...(row.draftOption ? { option: row.draftOption } : {}),
                        ...(row.draft?.trim() ? { text: row.draft.trim() } : {}),
                    })),
                },
                { ...files, block: waitingBlock, deliver }
            );
            result.sessions.push({
                session,
                numbers,
                result: sent,
                ...(sent.delivered ? {} : { deliversLater: deliversLater(sent.queueId) }),
            });
            logger.info(
                { session, numbers, delivered: sent.delivered, provider },
                sent.delivered ? "widget send-staged: delivered" : "widget send-staged: queued for the next prompt"
            );
            if (sent.delivered) {
                result.sent += rows.length;
            } else {
                result.queued += rows.length;
            }
        } catch (error) {
            logger.warn({ session, numbers, error }, "widget send-staged: failed");
            result.sessions.push({ session, numbers, error: error instanceof Error ? error.message : String(error) });
            result.failed += rows.length;
        }
    }

    return result;
}

/**
 * Sends again the answered decisions `ids` that no receiver took (the widget's Send again): one message per session,
 * through `sendAnsweredDecisions`. An answer already reserved by a session queue stays queued; its next prompt takes it.
 */
export async function resendAnsweredDecisions({
    ids,
    targets = {},
    files = decisionFiles(),
    deliver = {},
}: {
    ids: readonly string[];
    targets?: Record<string, StagedTarget>;
    files?: { file: string; events: string };
    deliver?: DeliverDeps;
}): Promise<StagedSendResult> {
    const wanted = new Set(ids);
    const bySession = new Map<string, DecisionRecord[]>();

    for (const row of readDecisions(files.file)) {
        // Only an answer that waits to go out: a chat answer an agent recorded as `answered` is never sent back.
        if (wanted.has(row.id) && awaitsDelivery(row)) {
            bySession.set(row.sessionId, [...(bySession.get(row.sessionId) ?? []), row]);
        }
    }

    const result: StagedSendResult = { sessions: [], sent: 0, queued: 0, failed: 0 };

    for (const [session, rows] of bySession) {
        const target = targets[session] ?? {};
        const numbers = rows.map((row) => row.number);
        const free = rows.filter((row) => !row.delivery?.queueId);

        if (free.length === 0) {
            const detail = "They are in the session's queue already.";
            result.sessions.push({
                session,
                numbers,
                result: { session, text: "", channel: "queued", delivered: false, detail },
                deliversLater: true,
            });
            result.queued += rows.length;
            continue;
        }

        result.queued += rows.length - free.length;

        try {
            const sent = await sendAnsweredDecisions({
                session,
                ids: free.map((row) => row.id),
                ...(target.provider ? { provider: target.provider } : {}),
                ...(target.sourceHome ? { sourceHome: target.sourceHome } : {}),
                files,
                deps: deliver,
            });
            const delivered = sent.delivered === true;
            const detail = sent.target ?? sent.error;
            result.sessions.push({
                session,
                numbers,
                result: {
                    session,
                    text: sent.text,
                    channel: sent.channel ?? "queued",
                    delivered,
                    ...(detail ? { detail } : {}),
                    ...(sent.target ? { target: sent.target } : {}),
                    ...(sent.error ? { error: sent.error } : {}),
                },
                ...(delivered ? {} : { deliversLater: deliversLater(sent.queueId) }),
            });

            if (delivered) {
                result.sent += free.length;
            } else {
                result.queued += free.length;
            }
        } catch (error) {
            result.sessions.push({ session, numbers, error: error instanceof Error ? error.message : String(error) });
            result.failed += free.length;
        }
    }

    return result;
}

/** Discards the unsent pick and note of each staged decision in `ids`; the decision still waits for an answer. */
export async function unstageDecisions({
    ids,
    files = decisionFiles(),
}: {
    ids: readonly string[];
    files?: { file: string; events: string };
}): Promise<number> {
    const wanted = new Set(ids);
    const updates = readDecisions(files.file)
        .filter((row) => wanted.has(row.id) && isStaged(row))
        .map((row) => ({ id: row.id, draft: "", draftOption: "" }));

    if (updates.length > 0) {
        await updateDecisions(files.file, files.events, { updates });
    }

    return updates.length;
}
