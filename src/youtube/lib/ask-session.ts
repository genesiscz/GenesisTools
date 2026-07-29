import { type AnswerOverVideosOpts, type AnswerOverVideosResult, answerOverVideos } from "@app/youtube/lib/ask-answer";
import { type AskScopeInput, resolveAskScope } from "@app/youtube/lib/ask-scope";
import { askSessionStore, toAskSessionRecord } from "@app/youtube/lib/ask-session-store";
import { resolveCollectionVideoIds } from "@app/youtube/lib/collection-rules";
import type { AskSessionMessageRecord, AskSessionRecord } from "@app/youtube/lib/db.types";
import type { AskHistoryTurn } from "@app/youtube/lib/qa.types";
import type { VideoId } from "@app/youtube/lib/video.types";
import type { Youtube } from "@app/youtube/lib/youtube";
import type { MessageRecord } from "@genesiscz/utils/ai/session";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

export interface EnsureAskSessionOpts {
    yt: Youtube;
    /** Owner of the session. CLI/MCP pass the console service user. */
    userId: number;
    /** Session name, stored as the row's `title` and unique per owner by convention. */
    name: string;
    scope: AskScopeInput;
    /** "provider" / "provider/model" pinned onto the session at creation. */
    providerSpec?: string | null;
}

export interface EnsureAskSessionResult {
    session: AskSessionRecord;
    created: boolean;
}

/** Returns this owner's session of that name, or creates it from `scope`. */
export async function ensureAskSession(opts: EnsureAskSessionOpts): Promise<EnsureAskSessionResult> {
    const store = askSessionStore(opts.yt);
    const owner = String(opts.userId);
    const existing = await store.backend.byTitle(owner, opts.name);

    if (existing) {
        return { session: toAskSessionRecord(existing), created: false };
    }

    const scope = await resolveAskScope(opts.yt, opts.scope);
    // `getOrCreate` re-reads by title before inserting, which closes the in-process
    // race that resolving a scope opens (importing a directory or listing a channel
    // is a long await, and two concurrent asks for the same name would otherwise
    // both have passed the check above). The unique index
    // (`idx_ask_sessions_user_title`) closes the cross-process one, and `getOrCreate`
    // answers a lost race with the winner's row rather than the constraint error.
    const session = await store.getOrCreate(owner, opts.name, {
        scopeKind: scope.kind,
        scopeValue: scope.value,
        videoIds: scope.videoIds,
        providerSpec: opts.providerSpec ?? null,
    });
    logger.info(
        { session: session.title, userId: opts.userId, kind: scope.kind, videos: scope.videoIds.length },
        "youtube ask session created"
    );

    return { session: toAskSessionRecord(session), created: true };
}

/**
 * A `channel` session re-resolves its members on every ask so new uploads join
 * automatically. `videos` and `dir` sessions keep the id list they were created
 * with (re-import the directory explicitly to refresh it). A `collection`
 * session defers to the collection's own membership rules.
 */
export async function resolveSessionVideoIds(yt: Youtube, session: AskSessionRecord): Promise<VideoId[]> {
    // Rows migrated from `ask_threads` are collection-backed and carry the default
    // `video_ids_json = '[]'`, so returning the stored list here would ask over
    // nothing. Membership for those lives in the collection's own rules.
    if (session.scopeKind === "collection") {
        return resolveCollectionSessionVideoIds(yt, session);
    }

    if (session.scopeKind !== "channel") {
        return session.videoIds as VideoId[];
    }

    const scope = await resolveAskScope(yt, { channel: session.scopeValue });
    // Compare membership, not just the count: a channel that loses one video and
    // gains another between asks keeps the same length, and a count-only check
    // would leave every stored reader (session listings, the extension) on the
    // old list forever.
    const changed =
        scope.videoIds.length !== session.videoIds.length ||
        scope.videoIds.some((id, index) => id !== session.videoIds[index]);

    if (changed) {
        yt.db.setAskSessionVideoIds(session.id, scope.videoIds);
    }

    return scope.videoIds;
}

function resolveCollectionSessionVideoIds(yt: Youtube, session: AskSessionRecord): VideoId[] {
    if (session.collectionId === null) {
        logger.warn({ session: session.id }, "youtube ask session: collection scope without a collection id");

        return session.videoIds as VideoId[];
    }

    const collection = yt.db.getCollection(session.userId, session.collectionId);

    if (!collection) {
        logger.warn(
            { session: session.id, collectionId: session.collectionId },
            "youtube ask session: collection is gone"
        );

        return [];
    }

    return resolveCollectionVideoIds(yt.db, collection) as VideoId[];
}

export type AskInSessionOpts = Omit<AnswerOverVideosOpts, "videoIds"> & {
    session: AskSessionRecord;
};

export interface AskInSessionResult extends AnswerOverVideosResult {
    sessionId: number;
    turn: number;
}

export async function askInSession(opts: AskInSessionOpts): Promise<AskInSessionResult> {
    const store = askSessionStore(opts.yt);
    const id = String(opts.session.id);
    const videoIds = await resolveSessionVideoIds(opts.yt, opts.session);
    let result: AnswerOverVideosResult | undefined;

    // `store.turn` answers FIRST and writes the question and the answer together, so
    // a scope with no transcripts, an aborted signal or any provider error leaves no
    // orphan question for the next ask to replay as history with no reply. Its
    // `history` argument is the exchange BEFORE this one, which is exactly what the
    // prompt wants: repeating the current question would duplicate it.
    await store.turn(id, opts.question, async (history) => {
        result = await answerOverVideos({ ...opts, videoIds, history: sessionHistory(history) });

        return { text: result.answer, meta: { citations: result.citations } };
    });

    if (!result) {
        throw new Error("askInSession: the turn produced no answer");
    }

    const turn = (await store.history(id)).length;

    return { ...result, sessionId: opts.session.id, turn };
}

/**
 * Prior turns for the prompt. `tool` rows are replay bookkeeping, not conversation,
 * so only the user/assistant exchange is replayed back to the model.
 */
function sessionHistory(messages: MessageRecord[]): AskHistoryTurn[] {
    const turns: AskHistoryTurn[] = [];

    for (const message of messages) {
        if (message.role === "user" || message.role === "assistant") {
            turns.push({ role: message.role, content: message.content });
        }
    }

    return turns;
}

/** Assistant turns carry their citations as JSON; decode defensively for display. */
export function parseSessionCitations(message: AskSessionMessageRecord): unknown[] {
    if (!message.citationsJson) {
        return [];
    }

    try {
        const parsed = SafeJSON.parse(message.citationsJson, { unbox: true });

        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        logger.warn({ messageId: message.id, err: error }, "youtube ask session: citations JSON unreadable");

        return [];
    }
}
