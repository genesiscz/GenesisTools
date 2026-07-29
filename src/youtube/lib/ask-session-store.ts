import type { AskSessionRecord, AskSessionScopeKind } from "@app/youtube/lib/db.types";
import type { VideoId } from "@app/youtube/lib/video.types";
import type { Youtube } from "@app/youtube/lib/youtube";
import type { SessionRecord, SessionStore } from "@genesiscz/utils/ai/session";
import { createSessionStore, createSqliteSessionBackend } from "@genesiscz/utils/ai/session";

/**
 * youtube's `ask_sessions` / `ask_session_messages` seen as a generic session store.
 *
 * The tables are NOT recreated or migrated here — `db.ts`'s `add-ask-sessions`
 * migration still owns them. What this adds is the column map that lets the
 * shared backend drive them: an INTEGER `user_id` where the store says `owner`,
 * ISO-text timestamps where it says epoch ms, and five domain columns exposed as
 * `meta` keys. `citations_json` is the one that matters most — sessions written
 * before this phase keep their citations only because `meta.citations` lands
 * back in that same column instead of a new blob.
 */
export function askSessionStore(yt: Youtube): SessionStore {
    return createSessionStore(
        createSqliteSessionBackend({
            db: yt.db.getDb(),
            sessionsTable: "ask_sessions",
            messagesTable: "ask_session_messages",
            manageSchema: false,
            timestamps: "iso",
            ownerType: "integer",
            columns: { session: { owner: "user_id" } },
            metaColumns: {
                session: [
                    { column: "collection_id", key: "collectionId", encoding: "integer" },
                    { column: "scope_kind", key: "scopeKind" },
                    { column: "scope_value", key: "scopeValue" },
                    { column: "video_ids_json", key: "videoIds" },
                    { column: "provider_spec", key: "providerSpec" },
                ],
                message: [
                    { column: "tool_name", key: "toolName" },
                    { column: "tool_args_json", key: "toolArgs" },
                    { column: "citations_json", key: "citations" },
                ],
            },
        })
    );
}

const SCOPE_KINDS: AskSessionScopeKind[] = ["collection", "channel", "videos", "dir"];

/** The store's generic record back in the shape youtube's db layer hands out. */
export function toAskSessionRecord(record: SessionRecord): AskSessionRecord {
    const meta = record.meta ?? {};

    return {
        id: Number(record.id),
        userId: Number(record.owner),
        collectionId: typeof meta.collectionId === "number" ? meta.collectionId : null,
        scopeKind: SCOPE_KINDS.find((kind) => kind === meta.scopeKind) ?? "collection",
        scopeValue: typeof meta.scopeValue === "string" ? meta.scopeValue : "",
        videoIds: Array.isArray(meta.videoIds) ? meta.videoIds.filter(isVideoId) : [],
        providerSpec: typeof meta.providerSpec === "string" ? meta.providerSpec : null,
        title: record.title,
        createdAt: new Date(record.createdAt).toISOString(),
        updatedAt: new Date(record.updatedAt).toISOString(),
    };
}

function isVideoId(value: unknown): value is VideoId {
    return typeof value === "string";
}
