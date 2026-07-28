export interface InstagramProfile {
    id: string;
    username: string;
    fullName: string;
    biography: string;
    isPrivate: boolean;
    isVerified: boolean;
    isProfessional: boolean;
    followers: number;
    following: number;
    posts: number;
    highlightCount: number;
    profilePicUrl: string;
}

export interface HighlightRef {
    id: string;
    title: string;
    coverUrl?: string;
}

/**
 * What the anonymous surface genuinely exposes about stories. Story existence and
 * the highlight tray ARE public via the legacy `query_id` reel endpoint; only the
 * media items behind them are gated.
 */
export interface PublicReelInfo {
    hasPublicStory: boolean;
    isLive: boolean;
    /** When the current story reel expires — present even with no session. */
    storyExpiresAt?: Date;
    highlights: HighlightRef[];
}

export interface StoryItem {
    id: string;
    takenAt: Date;
    expiresAt?: Date;
    isVideo: boolean;
    /** Highest-resolution URL for the item — video when `isVideo`, else the image. */
    mediaUrl: string;
    /** Always present; the poster frame for videos. */
    imageUrl: string;
    width: number;
    height: number;
}

export interface StoryReel {
    /** Numeric user id for a live-story reel, `highlight:<id>` for a highlight. */
    reelId: string;
    ownerUsername?: string;
    title?: string;
    items: StoryItem[];
}

/**
 * How a request was authenticated. The whole point of the tool is that these are
 * separate: profile/posts/highlight-ids resolve anonymously, story media does not.
 */
export type AuthMode = "anonymous" | "session";

export type InstagramErrorKind =
    /**
     * The gate this tool exists to report correctly. Instagram answers an
     * unauthenticated story request with HTTP 200 and `{"reels":{}}` rather than
     * 401, so an empty reel map is indistinguishable from "no stories" unless the
     * caller knows whether a session was attached. Verified 2026-07-27: the same
     * user id on `i.instagram.com/api/v1/feed/user/<id>/story/` returns 403
     * `login_required` for content the sibling endpoint reports as empty.
     */
    | "session-required"
    /** Session cookie was sent but Instagram rejected it (expired or invalidated). */
    | "session-invalid"
    /** Account-level block, clearable. Rotating IP will NOT help and makes it worse. */
    | "checkpoint"
    /** Challenge URL contained `/suspended/` — not clearable with an SMS code. */
    | "suspended"
    /**
     * `feedback_required`. Instagram's "this action looked automated" response.
     * Distinct from rate limiting: it is scored against the ACCOUNT, so slowing
     * down helps future requests but backing off does not clear the current one.
     */
    | "feedback-required"
    /** IP-level throttle (`sentry_block`, `rate_limit_error`, 429). Backing off helps. */
    | "rate-limited"
    /**
     * "Please wait a few minutes before you try again." instagrapi groups this
     * with the LOGICAL-level blocks, not the IP-level ones, so rotating egress
     * does not clear it — it is scoped to the caller, and only time fixes it.
     * Note it arrives as HTTP 401 with `require_login: true`, which makes it look
     * like an auth failure; classifying it as one sends the user hunting for a
     * cookie problem that does not exist.
     */
    | "please-wait"
    | "not-found"
    | "private-account"
    | "network";

/** Errors where retrying the same request can only make the situation worse. */
const TERMINAL_KINDS: ReadonlySet<InstagramErrorKind> = new Set([
    "checkpoint",
    "suspended",
    "feedback-required",
    "session-required",
    "session-invalid",
    "not-found",
    "private-account",
    "please-wait",
]);

export class InstagramError extends Error {
    constructor(
        readonly kind: InstagramErrorKind,
        message: string,
        readonly status?: number,
        /** Present for checkpoint/suspended — the URL the user must open to resolve it. */
        readonly challengeUrl?: string
    ) {
        super(message);
        this.name = "InstagramError";
    }

    /**
     * instagrapi's retry loop stops on exactly this class of error rather than
     * burning attempts. Retrying a checkpoint adds automation signal to an account
     * that has already been flagged, which is the opposite of what you want.
     */
    get isTerminal(): boolean {
        return TERMINAL_KINDS.has(this.kind);
    }
}
