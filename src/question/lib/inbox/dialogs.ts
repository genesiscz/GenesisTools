import type { QuestionsConfig } from "@app/agents/lib/hooks/config";
import type { AgentSessionRow } from "@app/ai/lib/sessions/agent-session-rows";
import { openQuestions } from "@genesiscz/utils/agents/dialogs/store";
import { type OpenQuestion, openQuestionKey } from "@genesiscz/utils/agents/dialogs/types";
import { DialogWatcher, type WatchedSession } from "@genesiscz/utils/agents/dialogs/watcher";
import { logger } from "@genesiscz/utils/logger";
import { dispatchNotification } from "@genesiscz/utils/notifications";
import { decisionNotificationId } from "../decisions/banners";
import { hubItemClickCommand } from "../hub-link";

const { log } = logger.scoped("question-inbox");

/** The watcher reads only a session that wrote its transcript within this window: an older one asks nobody now. */
export const DIALOG_WATCH_WINDOW_MS = 24 * 60 * 60 * 1000;

const MESSAGE_MAX = 220;

/** One per process, so the hub server re-reads only the sessions whose files changed since its last pass. */
const watcher = new DialogWatcher();

/** The listed sessions the hub watcher reads: their harness has the questions feature on, and they are recent. */
export function watchedSessions(
    rows: readonly AgentSessionRow[],
    questions: QuestionsConfig,
    now: number
): WatchedSession[] {
    return rows.flatMap((row) =>
        questions.harnesses[row.provider] && row.filePath && now - row.mtime <= DIALOG_WATCH_WINDOW_MS
            ? [{ provider: row.provider, sessionId: row.sessionId, transcriptPath: row.filePath }]
            : []
    );
}

/**
 * The hub-side watcher's pass, then every open dialog record of the listed sessions. The records come from the
 * harness hooks and from this watcher alike, keyed `provider:sessionId:toolCallId`, so one question is one item.
 */
export function listedDialogs({
    rows,
    questions,
    now = Date.now(),
    root,
}: {
    rows: readonly AgentSessionRow[];
    questions: QuestionsConfig;
    now?: number;
    root?: string;
}): OpenQuestion[] {
    watcher.sync(watchedSessions(rows, questions, now), { now, root });

    return rows.flatMap((row) => {
        try {
            return openQuestions(row.provider, row.sessionId, root);
        } catch (error) {
            log.debug({ error, session: row.sessionId }, "inbox: could not read a session's dialog records");
            return [];
        }
    });
}

/** The open questions whose key is not in `notified`: each raises one banner, once. */
export function unnotified(open: readonly OpenQuestion[], notified: ReadonlySet<string>): OpenQuestion[] {
    return open.filter((question) => !notified.has(openQuestionKey(question)));
}

function clip(text: string): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > MESSAGE_MAX ? `${flat.slice(0, MESSAGE_MAX - 1)}…` : flat;
}

const LABELS: Record<OpenQuestion["kind"], string> = {
    decision: "asks you",
    plan: "waits for plan approval",
    permission: "waits for a permission",
};

/**
 * One banner for newly open questions, through the decision banner's route: the same click (the hub's Inbox at the
 * item), the same id scheme, so the decision banner sweep can remove it. Never throws.
 */
export async function notifyOpenQuestions(
    questions: readonly OpenQuestion[],
    rows: readonly AgentSessionRow[],
    bundle?: string
): Promise<boolean> {
    const [first] = questions;

    if (!first) {
        return false;
    }

    const id = openQuestionKey(first);
    const click = hubItemClickCommand("decision", id, bundle);

    if (!click) {
        log.debug({ id }, "GenesisTools.app is not installed; no question banner");
        return false;
    }

    const row = rows.find((candidate) => candidate.sessionId === first.sessionId);

    try {
        await dispatchNotification({
            app: "question",
            title:
                questions.length === 1
                    ? `${first.provider} ${LABELS[first.kind]}`
                    : `${questions.length} agents wait for you`,
            subtitle: row?.project ?? row?.title ?? first.sessionId,
            message: clip(first.question || LABELS[first.kind]),
            id: decisionNotificationId({ id }),
            execute: click,
            actions: [{ id: "open-hub", title: "Open in hub", execute: click }],
        });
        log.info({ ids: questions.map(openQuestionKey) }, "question banner sent");
        return true;
    } catch (err) {
        log.warn({ err, id }, "could not notify about open questions");
        return false;
    }
}
