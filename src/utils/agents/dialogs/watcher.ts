import { existsSync, statSync } from "node:fs";
import { readTurnState, type TurnSnapshot, turnStateSources } from "@genesiscz/utils/ai/transcripts/turn-state";
import { logger } from "@genesiscz/utils/logger";
import { closeQuestions, readSessionQuestions, upsertQuestion } from "./store";
import { type DialogProvider, type OpenQuestion, openQuestionKey } from "./types";

const log = logger.child({ component: "agents:dialogs-watcher" });

/** The turn reader's stall limit; a turn that ended on a question waits for the user, whatever its silence. */
const WATCH_STALL_TIMEOUT_MS = 90_000;

/** A live session the watcher reads: its provider, id and native transcript. */
export interface WatchedSession {
    provider: DialogProvider;
    sessionId: string;
    transcriptPath: string;
}

/** What one pass changed in a session's dialog records. */
export interface WatchResult {
    /** Questions recorded for the first time by this pass. */
    opened: OpenQuestion[];
    /** Keys of the watcher's own records this pass closed. */
    closed: string[];
}

/**
 * The record a turn snapshot proves, or null: a question, plan or permission prompt the session waits on, named by
 * the call that asked (`TurnSnapshot.questionCall`). A closed transcript (a compressed Codex rollout) waits on nobody.
 */
export function questionFromSnapshot(
    session: Pick<WatchedSession, "provider" | "sessionId">,
    snapshot: TurnSnapshot | null,
    now: number
): OpenQuestion | null {
    const call = snapshot?.asksQuestion && snapshot.state !== "FINISHED" ? snapshot.questionCall : undefined;

    if (!call) {
        return null;
    }

    return {
        provider: session.provider,
        sessionId: session.sessionId,
        toolCallId: call.callId,
        kind: call.kind,
        question: snapshot?.question ?? "",
        ...(call.options ? { options: call.options } : {}),
        ...(call.questionCount ? { questionCount: call.questionCount } : {}),
        askedAt: new Date(snapshot?.lastEventAt ?? now).toISOString(),
        source: "watcher",
    };
}

/**
 * Brings one session's dialog records in line with its transcript: a question the turn state shows and no record
 * holds is recorded with `source: "watcher"`, and a watcher record the transcript no longer shows is closed. A
 * record a hook wrote is never rewritten or closed here: the key `provider:sessionId:toolCallId` makes the hook's and
 * the watcher's records of one question the same record, and the hook closes its own. An unreadable transcript
 * changes nothing.
 */
export async function syncSessionDialogs(
    session: WatchedSession,
    { now = Date.now(), root, snapshot }: { now?: number; root?: string; snapshot?: TurnSnapshot | null } = {}
): Promise<WatchResult> {
    const state =
        snapshot === undefined
            ? readTurnState(session.provider, session.transcriptPath, { now, stallTimeoutMs: WATCH_STALL_TIMEOUT_MS })
            : snapshot;

    if (state === null) {
        return { opened: [], closed: [] };
    }

    const waiting = questionFromSnapshot(session, state, now);
    const records = readSessionQuestions(session.provider, session.sessionId, root);
    const opened: OpenQuestion[] = [];

    if (waiting && !records.some((record) => openQuestionKey(record) === openQuestionKey(waiting))) {
        await upsertQuestion(waiting, root);
        opened.push(waiting);
    }

    const closed = (
        await closeQuestions({
            provider: session.provider,
            sessionId: session.sessionId,
            closedAt: new Date(now).toISOString(),
            root,
            which: (record) =>
                record.source === "watcher" &&
                record.closedAt === undefined &&
                record.toolCallId !== waiting?.toolCallId,
        })
    ).map(openQuestionKey);

    if (opened.length > 0 || closed.length > 0) {
        log.info(
            { session: session.sessionId, provider: session.provider, opened: opened.map(openQuestionKey), closed },
            "dialog watcher updated the session's question records"
        );
    }

    return { opened, closed };
}

/**
 * The hub-side watcher's memory between passes: each session's source files as `size:mtime`, so a pass re-reads
 * only a session whose transcript or event log changed. One per long-running process (the hub server).
 */
export class DialogWatcher {
    private readonly seen = new Map<string, string>();
    private pending: Promise<void> = Promise.resolve();

    /** One pass over the sessions; an unchanged session costs one `stat` per source file. */
    sync(sessions: readonly WatchedSession[], options: { now?: number; root?: string } = {}): Promise<WatchResult> {
        const pass = this.pending.then(() => this.syncNow(sessions, options));
        this.pending = pass.then(
            () => undefined,
            () => undefined
        );
        return pass;
    }

    private async syncNow(
        sessions: readonly WatchedSession[],
        options: { now?: number; root?: string }
    ): Promise<WatchResult> {
        const result: WatchResult = { opened: [], closed: [] };

        for (const session of sessions) {
            const stamp = sourcesStamp(session);
            const key = `${session.provider}:${session.sessionId}`;

            if (stamp === null || this.seen.get(key) === stamp) {
                continue;
            }

            try {
                const pass = await syncSessionDialogs(session, options);
                result.opened.push(...pass.opened);
                result.closed.push(...pass.closed);
                this.seen.set(key, stamp);
            } catch (error) {
                log.warn({ error, session: session.sessionId }, "dialog watcher could not sync a session");
            }
        }

        return result;
    }
}

function sourcesStamp(session: WatchedSession): string | null {
    const parts: string[] = [];

    for (const path of turnStateSources(session.provider, session.transcriptPath)) {
        // A missing event log is a state of its own (Grok writes it lazily), not a failure.
        if (!existsSync(path)) {
            parts.push("-");
            continue;
        }

        try {
            const info = statSync(path);
            parts.push(`${info.size}:${info.mtimeMs}`);
        } catch (error) {
            log.debug({ error, path }, "dialog watcher could not stat a session source");
            parts.push("-");
        }
    }

    return parts[0] === "-" ? null : parts.join("|");
}
