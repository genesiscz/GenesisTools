import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";

const API_ROOT = "https://kick.com/api/v2";
const REQUEST_TIMEOUT_MS = 20_000;
/** Kick answers a request without a browser user agent with a Cloudflare page more often. */
const BROWSER_USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

export const KICK_CLIP_SORTS = ["date", "view"] as const;
export type KickClipSort = (typeof KICK_CLIP_SORTS)[number];
/** The page's `range` query value; the API calls it `time`. */
export const KICK_CLIP_RANGES = ["day", "week", "month", "all"] as const;
export type KickClipRange = (typeof KICK_CLIP_RANGES)[number];

/** A clip id: `clip_` and a 26 character ULID. */
const CLIP_ID = /clip_[0-9A-HJKMNP-TV-Z]{26}/i;
const CHANNEL_SLUG = /^[a-z0-9_-]+$/i;
/** Paths on kick.com that are not a channel. */
const RESERVED_PATHS = new Set(["api", "categories", "browse", "following", "search", "clips", "video"]);

const clipSchema = z.object({
    id: z.string(),
    title: z.string(),
    /** An HLS media playlist with byte-range segments. */
    clip_url: z.string(),
    thumbnail_url: z.string().nullish(),
    duration: z.number(),
    views: z.number().nullish(),
    view_count: z.number().nullish(),
    likes: z.number().nullish(),
    created_at: z.string(),
    livestream_id: z.string().nullish(),
    is_mature: z.boolean().nullish(),
    category: z.object({ name: z.string(), slug: z.string() }).nullish(),
    creator: z.object({ username: z.string(), slug: z.string() }).nullish(),
    channel: z.object({ username: z.string(), slug: z.string() }),
});

const clipListSchema = z.object({ clips: z.array(clipSchema), nextCursor: z.string().nullish() });
const clipDetailSchema = z.object({ clip: clipSchema });

export interface KickClip {
    id: string;
    title: string;
    playlistUrl: string;
    thumbnailUrl: string | null;
    durationSec: number;
    views: number;
    likes: number;
    createdAt: string;
    channel: string;
    channelName: string;
    creator: string | null;
    category: string | null;
    mature: boolean;
    pageUrl: string;
}

/** What a command-line argument names: one clip, or a channel's clip list with the page's filters. */
export type KickTarget =
    | { kind: "clip"; id: string }
    | { kind: "channel"; channel: string; sort?: KickClipSort; range?: KickClipRange };

export class KickApiError extends Error {
    constructor(
        message: string,
        readonly status: number | null
    ) {
        super(message);
        this.name = "KickApiError";
    }
}

function isSort(value: string | null): value is KickClipSort {
    return KICK_CLIP_SORTS.some((sort) => sort === value);
}

function isRange(value: string | null): value is KickClipRange {
    return KICK_CLIP_RANGES.some((range) => range === value);
}

/**
 * Reads a clip URL (`kick.com/<channel>/clips/clip_…`, `kick.com/<channel>?clip=clip_…`), a bare clip id, a channel
 * clips page (`kick.com/<channel>/clips?sort=date&range=day`), a channel page or a bare channel slug.
 */
export function parseKickTarget(input: string): KickTarget {
    const text = input.trim();
    const clipId = text.match(CLIP_ID)?.[0];

    if (clipId) {
        return { kind: "clip", id: `clip_${clipId.slice(5).toUpperCase()}` };
    }

    if (CHANNEL_SLUG.test(text)) {
        return { kind: "channel", channel: text.toLowerCase() };
    }

    let url: URL;

    try {
        url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    } catch (error) {
        logger.debug({ error, input }, "Kick target is not a URL");
        throw new Error(`"${input}" is not a Kick clip, channel or clips page URL`);
    }

    if (!/(^|\.)kick\.com$/i.test(url.hostname)) {
        throw new Error(`"${input}" is not a kick.com URL`);
    }

    const channel = url.pathname.split("/").filter(Boolean)[0]?.toLowerCase();

    if (!channel || RESERVED_PATHS.has(channel) || !CHANNEL_SLUG.test(channel)) {
        throw new Error(`"${input}" names no Kick channel`);
    }

    const sort = url.searchParams.get("sort");
    const range = url.searchParams.get("range");
    return {
        kind: "channel",
        channel,
        ...(isSort(sort) ? { sort } : {}),
        ...(isRange(range) ? { range } : {}),
    };
}

function toClip(raw: z.infer<typeof clipSchema>): KickClip {
    return {
        id: raw.id,
        title: raw.title,
        playlistUrl: raw.clip_url,
        thumbnailUrl: raw.thumbnail_url ?? null,
        durationSec: raw.duration,
        views: raw.view_count ?? raw.views ?? 0,
        likes: raw.likes ?? 0,
        createdAt: raw.created_at,
        channel: raw.channel.slug,
        channelName: raw.channel.username,
        creator: raw.creator?.username ?? null,
        category: raw.category?.name ?? null,
        mature: raw.is_mature ?? false,
        pageUrl: `https://kick.com/${raw.channel.slug}/clips/${raw.id}`,
    };
}

async function getJson<T>({
    url,
    schema,
    signal,
}: {
    url: string;
    schema: z.ZodType<T>;
    signal?: AbortSignal;
}): Promise<T> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    logger.debug({ url }, "Kick API request");
    const response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": BROWSER_USER_AGENT },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = await response.text();

    if (response.status === 404) {
        throw new KickApiError(`Kick has no such channel or clip (${url})`, 404);
    }

    if (!response.ok) {
        const blocked = /cloudflare|just a moment/i.test(text)
            ? " (Cloudflare refused the request; try again later)"
            : "";
        logger.warn({ url, status: response.status, body: text.slice(0, 500) }, "Kick API request failed");
        throw new KickApiError(`Kick answered HTTP ${response.status}${blocked}`, response.status);
    }

    let body: unknown;

    try {
        body = SafeJSON.parse(text, { strict: true });
    } catch (error) {
        logger.warn({ url, error, body: text.slice(0, 500) }, "Kick API answered no JSON");
        throw new KickApiError("Kick answered something that is not JSON (a Cloudflare check page?)", response.status);
    }

    const parsed = schema.safeParse(body);

    if (!parsed.success) {
        logger.warn({ url, issues: parsed.error.issues.slice(0, 5) }, "Kick API answer has an unknown shape");
        throw new KickApiError(`Kick's API answer changed shape: ${parsed.error.issues[0]?.message}`, response.status);
    }

    return parsed.data;
}

export async function fetchKickClip(id: string, signal?: AbortSignal): Promise<KickClip> {
    const { clip } = await getJson({
        url: `${API_ROOT}/clips/${encodeURIComponent(id)}`,
        schema: clipDetailSchema,
        signal,
    });
    return toClip(clip);
}

/** The channel's clips, page after page, until `limit` clips or the last page. */
export async function listKickClips({
    channel,
    sort,
    range,
    limit,
    signal,
}: {
    channel: string;
    sort: KickClipSort;
    range: KickClipRange;
    limit: number;
    signal?: AbortSignal;
}): Promise<KickClip[]> {
    const clips: KickClip[] = [];
    let cursor: string | null = null;

    while (clips.length < limit) {
        const params = new URLSearchParams({ sort, time: range });

        if (cursor) {
            params.set("cursor", cursor);
        }

        const page = await getJson({
            url: `${API_ROOT}/channels/${encodeURIComponent(channel)}/clips?${params}`,
            schema: clipListSchema,
            signal,
        });
        clips.push(...page.clips.map(toClip));

        if (!page.nextCursor || page.clips.length === 0 || page.nextCursor === cursor) {
            break;
        }

        cursor = page.nextCursor;
    }

    logger.debug({ channel, sort, range, limit, found: clips.length }, "Kick clips listed");
    return clips.slice(0, limit);
}
