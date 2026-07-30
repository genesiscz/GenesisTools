import { logger } from "@genesiscz/utils/logger";
import type {
    MessageRecord,
    SessionBackend,
    SessionId,
    SessionRecord,
    SessionStore,
    TurnMeta,
    TurnReply,
} from "./types";
import { SessionBusyError } from "./types";

/**
 * The turn protocol, in one place.
 *
 * youtube's `askInSession` spelled it out inline (answer, write both turns in one
 * transaction, touch, count) and `AiProxySession` spelled a different half of it
 * (push user, complete, push assistant). Both were correct; neither could be
 * reused. The only thing added here is the busy guard, which both lacked.
 */
export function createSessionStore(backend: SessionBackend): SessionStore {
    const { log } = logger.scoped("ai-session");
    const inFlight = new Set<SessionId>();

    async function getOrCreate(owner: string, title: string, meta?: Record<string, unknown>): Promise<SessionRecord> {
        const existing = await backend.byTitle(owner, title);

        if (existing) {
            return existing;
        }

        // A backend that enforces one title per owner surfaces the cross-process
        // race here, and losing it must return the winner's row rather than throw:
        // the caller asked for "this session", not "a session I created".
        try {
            const created = await backend.create({ owner, title, meta });
            log.debug({ session: created.id, owner, title }, "session created");

            return created;
        } catch (error) {
            const winner = await backend.byTitle(owner, title);

            if (!winner) {
                throw error;
            }

            log.debug({ session: winner.id, owner, title, err: error }, "lost the create race, using the existing row");

            return winner;
        }
    }

    async function turn(
        id: SessionId,
        userText: string,
        respond: (history: MessageRecord[]) => Promise<TurnReply>,
        meta?: TurnMeta
    ): Promise<MessageRecord> {
        if (inFlight.has(id)) {
            throw new SessionBusyError(id);
        }

        inFlight.add(id);

        try {
            // Read BEFORE this turn exists: `respond` already holds `userText`, and
            // replaying it as history would duplicate the question in the prompt.
            const history = await backend.messages(id);
            // Answer FIRST, persist after. A responder that throws (no transcripts,
            // aborted signal, provider error) must leave nothing behind, or the next
            // turn replays an unanswered question, once more per retry.
            const reply = await respond(history);
            const text = typeof reply === "string" ? reply : reply.text;
            const replyMeta = typeof reply === "string" ? undefined : reply.meta;
            const assistant = await backend.appendPair(
                { sessionId: id, role: "user", content: userText, meta: meta?.user },
                {
                    sessionId: id,
                    role: "assistant",
                    content: text,
                    meta: mergeMeta(meta?.assistant, replyMeta),
                }
            );
            await backend.touch(id);
            log.debug({ session: id, historyBefore: history.length, chars: text.length }, "turn appended");

            return assistant;
        } finally {
            inFlight.delete(id);
        }
    }

    return {
        backend,
        getOrCreate,
        turn,
        history: (id) => backend.messages(id),
    };
}

function mergeMeta(
    fixed: Record<string, unknown> | undefined,
    derived: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
    if (!fixed) {
        return derived;
    }

    if (!derived) {
        return fixed;
    }

    return { ...fixed, ...derived };
}
