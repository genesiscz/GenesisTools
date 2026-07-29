import { type AnswerOverVideosOpts, type AnswerOverVideosResult, answerOverVideos } from "@app/youtube/lib/ask-answer";
import { type AskScopeInput, resolveAskScope } from "@app/youtube/lib/ask-scope";
import { resolveCollectionVideoIds } from "@app/youtube/lib/collection-rules";
import type { AskSessionMessageRecord, AskSessionRecord } from "@app/youtube/lib/db.types";
import type { AskHistoryTurn } from "@app/youtube/lib/qa.types";
import type { VideoId } from "@app/youtube/lib/video.types";
import type { Youtube } from "@app/youtube/lib/youtube";
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
    const existing = opts.yt.db.getAskSessionByTitle(opts.userId, opts.name);

    if (existing) {
        return { session: existing, created: false };
    }

    const scope = await resolveAskScope(opts.yt, opts.scope);
    // Re-read after the await: resolving a scope imports a directory or lists a
    // channel, and two concurrent asks for the same name would otherwise both have
    // passed the check above and created a duplicate. Nothing awaits between this
    // read and the insert, and Bun's SQLite calls are synchronous, so the second
    // caller here always sees the first one's row.
    const raced = opts.yt.db.getAskSessionByTitle(opts.userId, opts.name);

    if (raced) {
        return { session: raced, created: false };
    }

    const session = opts.yt.db.createAskSession({
        userId: opts.userId,
        title: opts.name,
        scopeKind: scope.kind,
        scopeValue: scope.value,
        videoIds: scope.videoIds,
        providerSpec: opts.providerSpec ?? null,
    });
    logger.info(
        { session: session.title, userId: opts.userId, kind: session.scopeKind, videos: scope.videoIds.length },
        "youtube ask session created"
    );

    return { session, created: true };
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
    const videoIds = await resolveSessionVideoIds(opts.yt, opts.session);
    // Read BEFORE appending this turn: the current question already goes to the model
    // as the question, and repeating it as history would duplicate it in the prompt.
    const history = sessionHistory(opts.yt, opts.session.id);
    // Answer FIRST, then write both turns together. `answerOverVideos` throws on a
    // scope with no transcripts, on an aborted signal and on any provider error —
    // persisting the user turn up front left an orphan question behind, which the
    // next ask replayed as history with no reply, once more per retry.
    const result = await answerOverVideos({ ...opts, videoIds, history });
    opts.yt.db.transaction(() => {
        opts.yt.db.appendAskSessionMessage({
            sessionId: opts.session.id,
            role: "user",
            content: opts.question,
        });
        opts.yt.db.appendAskSessionMessage({
            sessionId: opts.session.id,
            role: "assistant",
            content: result.answer,
            citationsJson: SafeJSON.stringify(result.citations, { strict: true }),
        });
    });
    opts.yt.db.touchAskSession(opts.session.id);
    const turn = opts.yt.db.listAskSessionMessages(opts.session.id).length;

    return { ...result, sessionId: opts.session.id, turn };
}

/**
 * Prior turns for the prompt. `tool` rows are replay bookkeeping, not conversation,
 * so only the user/assistant exchange is replayed back to the model.
 */
function sessionHistory(yt: Youtube, sessionId: number): AskHistoryTurn[] {
    const turns: AskHistoryTurn[] = [];

    for (const message of yt.db.listAskSessionMessages(sessionId)) {
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
