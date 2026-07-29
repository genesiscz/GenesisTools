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
 * youtube's `askInSession` spelled it out inline (append user, answer, append
 * assistant, touch, count) and `AiProxySession` spelled a different half of it
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

        const created = await backend.create({ owner, title, meta });
        log.debug({ session: created.id, owner, title }, "session created");

        return created;
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
            await backend.append({ sessionId: id, role: "user", content: userText, meta: meta?.user });
            const history = await backend.messages(id);
            const reply = await respond(history);
            const text = typeof reply === "string" ? reply : reply.text;
            const replyMeta = typeof reply === "string" ? undefined : reply.meta;
            const assistant = await backend.append({
                sessionId: id,
                role: "assistant",
                content: text,
                meta: mergeMeta(meta?.assistant, replyMeta),
            });
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
