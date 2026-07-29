import { logger } from "@genesiscz/utils/logger";
import { getAnonymousJson, getJson } from "./client";
import {
    type HighlightRef,
    InstagramError,
    type InstagramProfile,
    type PublicReelInfo,
    type SessionCredentials,
    type StoryItem,
    type StoryReel,
} from "./types";

const { log } = logger.scoped("instagram:api");

interface RawProfileResponse {
    data?: {
        user?: {
            id: string;
            username: string;
            full_name?: string;
            biography?: string;
            is_private: boolean;
            is_verified?: boolean;
            is_professional_account?: boolean;
            profile_pic_url_hd?: string;
            profile_pic_url?: string;
            highlight_reel_count?: number;
            edge_followed_by?: { count: number };
            edge_follow?: { count: number };
            edge_owner_to_timeline_media?: { count: number };
        };
    };
}

interface RawStoryItem {
    pk?: string | number;
    id?: string;
    taken_at?: number;
    expiring_at?: number;
    media_type?: number;
    image_versions2?: { candidates?: Array<{ url: string; width: number; height: number }> };
    video_versions?: Array<{ url: string; width: number; height: number }>;
}

interface RawReel {
    id?: string | number;
    title?: string;
    user?: { username?: string };
    items?: RawStoryItem[];
}

interface RawReelsResponse {
    reels?: Record<string, RawReel>;
}

interface RawPublicReelResponse {
    data?: {
        user?: {
            has_public_story?: boolean;
            is_live?: boolean;
            reel?: { expiring_at?: number };
            edge_highlight_reels?: {
                edges: Array<{
                    node: {
                        id: string | number;
                        title?: string;
                        cover_media?: { thumbnail_src?: string };
                        cover_media_cropped_thumbnail?: { url?: string };
                    };
                }>;
            };
        };
    };
}

interface RawHighlightsTray {
    tray?: Array<{
        id?: string;
        title?: string;
        cover_media?: { cropped_image_version?: { url?: string } };
    }>;
}

/**
 * Anonymous. Verified working without any cookie.
 *
 * Takes no `sessionId` parameter ON PURPOSE, and neither does `fetchPublicReelInfo`.
 * instagrapi's `inject_sessionid_to_public()` silently injects the account's real
 * session into a "public" call whenever an anonymous request fails and any
 * credential is in scope, which turns anonymous reads into identified ones without
 * the caller noticing. Keeping the parameter off the signature makes that class of
 * leak unrepresentable rather than merely avoided — and `getAnonymousJson` is what
 * holds the request layer to the same promise, since a plain `getJson` call would
 * accept a `sessionId` from a later refactor without complaint.
 */
export async function fetchProfile(username: string): Promise<InstagramProfile> {
    const { data } = await getAnonymousJson<RawProfileResponse>(
        `/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
        { label: `profile:${username}` }
    );

    const user = data.data?.user;
    if (!user) {
        throw new InstagramError("not-found", `No Instagram account found for @${username}`);
    }

    return {
        id: user.id,
        username: user.username,
        fullName: user.full_name ?? "",
        biography: user.biography ?? "",
        isPrivate: user.is_private,
        isVerified: user.is_verified ?? false,
        isProfessional: user.is_professional_account ?? false,
        followers: user.edge_followed_by?.count ?? 0,
        following: user.edge_follow?.count ?? 0,
        posts: user.edge_owner_to_timeline_media?.count ?? 0,
        highlightCount: user.highlight_reel_count ?? 0,
        profilePicUrl: user.profile_pic_url_hd ?? user.profile_pic_url ?? "",
    };
}

/**
 * Fetch story or highlight reels.
 *
 * 🛑 The critical branch. Instagram answers an unauthenticated story request with
 * HTTP 200 and `{"reels":{}}` — never a 401 — so an empty map means "you are not
 * authorised" far more often than it means "there are no stories". Without a
 * session we therefore refuse rather than reporting an empty result, because
 * silently returning "no stories" for a gated response is the single most
 * misleading thing this tool could do.
 */
async function fetchReels(
    reelIds: string[],
    session: SessionCredentials | undefined,
    label: string
): Promise<StoryReel[]> {
    if (!session) {
        throw new InstagramError(
            "session-required",
            "Story and highlight media require a logged-in Instagram session. " +
                "Instagram returns an empty result rather than an error to anonymous callers, " +
                "so this cannot be distinguished from 'no stories' without one."
        );
    }

    const query = reelIds.map((id) => `reel_ids=${encodeURIComponent(id)}`).join("&");
    const { data } = await getJson<RawReelsResponse>(`/api/v1/feed/reels_media/?${query}`, {
        sessionId: session.sessionId,
        csrfToken: session.csrfToken,
        label,
    });
    const reels = data.reels ?? {};

    if (Object.keys(reels).length === 0) {
        // We DID send a cookie and still got the anonymous-shaped answer, so the
        // cookie is dead. Reporting this as "no stories" is how every downstream
        // tool ends up lying to its user about an expired session.
        log.warn({ reelIds, label }, "empty reels map despite an attached session — treating the session as expired");
        throw new InstagramError(
            "session-invalid",
            "Instagram returned no reels despite an attached session. The session cookie is most likely expired."
        );
    }

    return Object.entries(reels).map(([reelId, reel]) => ({
        reelId,
        ownerUsername: reel.user?.username,
        title: reel.title,
        items: (reel.items ?? []).map(toStoryItem).filter((item): item is StoryItem => item !== undefined),
    }));
}

function toStoryItem(raw: RawStoryItem): StoryItem | undefined {
    const image = raw.image_versions2?.candidates?.[0];
    const video = raw.video_versions?.[0];

    if (!image && !video) {
        log.debug({ id: raw.pk ?? raw.id }, "skipping story item with no media candidates");
        return undefined;
    }

    const isVideo = Boolean(video);
    const primary = video ?? image;

    return {
        id: String(raw.pk ?? raw.id ?? ""),
        takenAt: new Date((raw.taken_at ?? 0) * 1000),
        expiresAt: raw.expiring_at ? new Date(raw.expiring_at * 1000) : undefined,
        isVideo,
        mediaUrl: primary?.url ?? "",
        imageUrl: image?.url ?? "",
        width: primary?.width ?? 0,
        height: primary?.height ?? 0,
    };
}

export async function fetchStories(userId: string, session: SessionCredentials | undefined): Promise<StoryReel[]> {
    return fetchReels([userId], session, `stories:${userId}`);
}

export async function fetchHighlightMedia(
    highlightIds: string[],
    session: SessionCredentials | undefined
): Promise<StoryReel[]> {
    return fetchReels(
        highlightIds.map((id) => (id.startsWith("highlight:") ? id : `highlight:${id}`)),
        session,
        `highlights:${highlightIds.length}`
    );
}

/**
 * Highlight tray via the private API. Needs a session; `fetchPublicReelInfo`
 * returns the same ids and titles anonymously, so this is only worth calling
 * when a session already exists.
 */
export async function fetchHighlightTray(
    userId: string,
    session: SessionCredentials | undefined
): Promise<HighlightRef[]> {
    if (!session) {
        throw new InstagramError("session-required", "The highlights tray endpoint requires a session.");
    }

    const { data } = await getJson<RawHighlightsTray>(`/api/v1/highlights/${userId}/highlights_tray/`, {
        sessionId: session.sessionId,
        csrfToken: session.csrfToken,
        label: `highlights-tray:${userId}`,
    });

    return (data.tray ?? []).map((entry) => ({
        id: String(entry.id ?? "").replace(/^highlight:/, ""),
        title: entry.title ?? "(untitled)",
        coverUrl: entry.cover_media?.cropped_image_version?.url,
    }));
}

/**
 * Legacy `query_id` reel endpoint. It survives because `include_logged_out_extras`
 * exists to serve exactly this case, and it is the one anonymous surface that
 * still reports story *existence* and the full highlight tray with titles.
 *
 * Verified anonymously with plain curl on 2026-07-27 (no cookie, no browser):
 * returns `has_public_story`, the reel's `expiring_at`, and every highlight id +
 * title + cover. It does NOT return story or highlight *items* — that stays gated.
 */
const PUBLIC_REEL_QUERY_ID = "9957820854288654";

export async function fetchPublicReelInfo(userId: string): Promise<PublicReelInfo> {
    const params = new URLSearchParams({
        query_id: PUBLIC_REEL_QUERY_ID,
        user_id: userId,
        include_chaining: "false",
        include_reel: "true",
        include_suggested_users: "false",
        include_logged_out_extras: "true",
        include_live_status: "true",
        include_highlight_reels: "true",
    });

    const { data } = await getAnonymousJson<RawPublicReelResponse>(`/graphql/query/?${params.toString()}`, {
        label: `public-reel:${userId}`,
    });

    const user = data.data?.user;
    if (!user) {
        throw new InstagramError("not-found", `No public reel info for user ${userId}`);
    }

    const expiringAt = user.reel?.expiring_at;
    const highlights = (user.edge_highlight_reels?.edges ?? []).map((edge) => ({
        id: String(edge.node.id),
        title: edge.node.title ?? "(untitled)",
        coverUrl: edge.node.cover_media_cropped_thumbnail?.url ?? edge.node.cover_media?.thumbnail_src,
    }));

    log.debug(
        { userId, hasPublicStory: user.has_public_story, highlights: highlights.length },
        "fetched public reel info anonymously"
    );

    return {
        hasPublicStory: Boolean(user.has_public_story),
        isLive: Boolean(user.is_live),
        storyExpiresAt: expiringAt ? new Date(expiringAt * 1000) : undefined,
        highlights,
    };
}
