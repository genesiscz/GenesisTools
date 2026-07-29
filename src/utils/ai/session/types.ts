/**
 * A durable conversation, independent of where it is stored.
 *
 * Three tools had grown their own version of "remember this chat": youtube's
 * `ask_sessions` tables, ask's JSONL files under ~/.genesis-tools/ai-chat, and
 * `AiProxySession`'s in-memory message array. They agree on the shape of the
 * problem (get-or-create by name, append a user turn, compute a reply over the
 * history, append the assistant turn, bump the timestamp) and disagree on
 * everything else, which is what this module normalises.
 *
 * The backend owns storage and id allocation ONLY. Ordering, the busy guard and
 * the turn protocol live in `store.ts`, so a new backend is a data-mapping
 * exercise rather than a re-implementation of the semantics.
 */

/**
 * Always a string here, even where the backend uses integers.
 *
 * youtube's `ask_sessions.id` is an INTEGER PRIMARY KEY and its db methods are
 * typed `(userId: number, id: number)`; the sqlite backend casts at both
 * boundaries rather than leaking a union type through every store call.
 */
export type SessionId = string;

/**
 * Wider than the three roles youtube stores, because ask's on-disk history
 * carries `config` and `context` entries that would otherwise be lost on a
 * round-trip through this layer.
 */
export type MessageRole = "user" | "assistant" | "system" | "config" | "context" | "tool";

export interface NewSession {
    owner: string;
    title: string;
    meta?: Record<string, unknown>;
}

export interface SessionRecord {
    id: SessionId;
    owner: string;
    title: string;
    /** Epoch ms. Backends that store ISO text convert on read. */
    createdAt: number;
    updatedAt: number;
    meta?: Record<string, unknown>;
}

export interface NewMessage {
    sessionId: SessionId;
    role: MessageRole;
    content: string;
    meta?: Record<string, unknown>;
}

export interface MessageRecord extends NewMessage {
    id: string;
    /** Epoch ms. */
    at: number;
}

export interface SessionBackend {
    create(session: NewSession): Promise<SessionRecord>;
    byTitle(owner: string, title: string): Promise<SessionRecord | undefined>;
    byId(id: SessionId): Promise<SessionRecord | undefined>;
    list(owner: string): Promise<SessionRecord[]>;
    append(message: NewMessage): Promise<MessageRecord>;
    messages(id: SessionId): Promise<MessageRecord[]>;
    touch(id: SessionId): Promise<void>;
}

/**
 * A second `turn()` arrived while one was still in flight.
 *
 * Rejecting is the deliberate choice over queueing: the second caller's reply
 * would be computed against a history that is about to change under it, and
 * silently serialising would hide that from a caller who could have waited.
 * Steering an in-flight turn is `MiniAgent.interject`, not a second `turn`.
 */
export class SessionBusyError extends Error {
    constructor(readonly sessionId: SessionId) {
        super(`Session ${sessionId} already has a turn in flight`);
        this.name = "SessionBusyError";
    }
}

export interface TurnMeta {
    user?: Record<string, unknown>;
    assistant?: Record<string, unknown>;
}

/**
 * A reply, optionally with metadata the responder only learns while producing it.
 *
 * The bare-string form covers the simple case. The object form exists because
 * `TurnMeta.assistant` is fixed before `respond` runs, so it cannot carry
 * anything derived from the answer — youtube's citations, for one, which are a
 * product of the retrieval that happens inside `respond`.
 */
export type TurnReply = string | { text: string; meta?: Record<string, unknown> };

export interface SessionStore {
    getOrCreate(owner: string, title: string, meta?: Record<string, unknown>): Promise<SessionRecord>;
    /**
     * Append `userText`, compute a reply over the resulting history, append it,
     * and touch the session. Returns the assistant message.
     */
    turn(
        id: SessionId,
        userText: string,
        respond: (history: MessageRecord[]) => Promise<TurnReply>,
        meta?: TurnMeta
    ): Promise<MessageRecord>;
    history(id: SessionId): Promise<MessageRecord[]>;
    /** The backend underneath, for the storage-specific reads a tool still needs. */
    readonly backend: SessionBackend;
}
