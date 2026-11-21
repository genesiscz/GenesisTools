import { abortableSleep } from "@genesiscz/utils/async";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";
import type { FetchedText } from "../clips/hls";
import { CLIP_RANGES, type Clip, type ClipRange, type ClipTarget, type Vod } from "../clips/types";

const API_ROOT = "https://kick.com/api/v2";
/** The one VOD detail route; v2 has none. */
const API_V1_ROOT = "https://kick.com/api/v1";
const REQUEST_TIMEOUT_MS = 20_000;
/**
 * Kick answers HTTP 429 after a few hundred quick requests (measured 2026-11-20: a backfill of 389 clips at 4 at once
 * lost 292 of them). A 429 waits for `Retry-After`, else 2, 4, 8, 16, 30 s, and tries again.
 */
const RATE_LIMIT_RETRIES = 6;
/** The longest wait of the doubling fallback when Kick names no `Retry-After`. */
const RATE_LIMIT_MAX_WAIT_MS = 30_000;
/** A `Retry-After` longer than this is not waited out: the request fails and says when to try again. */
const RETRY_AFTER_MAX_MS = 15 * 60_000;
/** Kick answers a request without a browser user agent with a Cloudflare page more often. */
const BROWSER_USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

export const KICK_CLIP_SORTS = ["date", "view"] as const;
export type KickClipSort = (typeof KICK_CLIP_SORTS)[number];

/** A clip id: `clip_` and a 26 character ULID. */
const CLIP_ID = /^clip_[0-9A-HJKMNP-TV-Z]{26}$/i;
const CHANNEL_SLUG = /^[a-z0-9_-]+$/i;
/** A VOD id: the uuid in `kick.com/<channel>/videos/<uuid>`. */
const VOD_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Paths on kick.com that are not a channel. */
const RESERVED_PATHS = new Set(["api", "categories", "browse", "following", "search", "clips", "video"]);
/** No stream runs a week; a larger `vod_starts_at` is no offset. */
const MAX_VOD_OFFSET_SEC = 7 * 86_400;

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
    /** Whole seconds into the VOD, rounded down; 0 until Kick has placed the clip (seen 2026-11-19 on fresh clips). */
    vod_starts_at: z.number().nullish(),
    is_mature: z.boolean().nullish(),
    category: z.object({ name: z.string(), slug: z.string() }).nullish(),
    creator: z.object({ username: z.string(), slug: z.string() }).nullish(),
    channel: z.object({ username: z.string(), slug: z.string() }),
});

/**
 * Kick writes a stream's start as `2026-11-19 17:28:55` (UTC) in lists and with `+00:00` in the VOD detail. A time
 * without a zone is UTC; a value that is no date is a schema issue, so the caller's invalid-answer handling reports it.
 */
export const kickTimeSchema = z.string().transform((value, ctx) => {
    const withT = value
        .trim()
        .replace(" ", "T")
        .replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    const at = Date.parse(/(Z|[+-]\d{2}:\d{2})$/i.test(withT) ? withT : `${withT}Z`);

    if (Number.isNaN(at)) {
        ctx.addIssue({ code: "custom", message: `"${value}" is not a Kick time`, input: value });
        return z.NEVER;
    }

    return new Date(at).toISOString();
});

const livestreamSchema = z.object({
    id: z.number(),
    session_title: z.string().nullish(),
    is_live: z.boolean(),
    start_time: kickTimeSchema,
    /** Milliseconds; 0 while the stream is live. */
    duration: z.number(),
    source: z.string().nullish(),
});

const vodListItemSchema = livestreamSchema.extend({
    video: z.object({ uuid: z.string(), is_private: z.boolean().nullish(), status: z.string().nullish() }).nullish(),
});

const vodDetailSchema = z.object({
    uuid: z.string(),
    source: z.string().nullish(),
    is_private: z.boolean().nullish(),
    status: z.string().nullish(),
    livestream: livestreamSchema.extend({ channel: z.object({ slug: z.string() }) }),
});

const clipListSchema = z.object({ clips: z.array(clipSchema), nextCursor: z.string().nullish() });
const clipDetailSchema = z.object({ clip: clipSchema });

/** True for a Kick VOD id (the uuid in a VOD URL); Kick's VOD detail route takes nothing else. */
export function isKickVodId(id: string): boolean {
    return VOD_UUID.test(id);
}

/** A Kick VOD and the playlist Kick serves for it without a login (null for subscriber-only and removed VODs). */
export interface KickVodInfo {
    vod: Vod;
    playlistUrl: string | null;
}

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

/** The page's `range` query value is one of the shared ranges; the API calls it `time`. */
function isRange(value: string | null): value is ClipRange {
    return CLIP_RANGES.some((range) => range === value);
}

/**
 * Reads a clip URL (`kick.com/<channel>/clips/clip_…`, `kick.com/<channel>?clip=clip_…`), a bare clip id, a channel
 * clips page (`kick.com/<channel>/clips?sort=date&range=day`), a VOD page (`kick.com/<channel>/videos/<uuid>`) or its
 * bare uuid, a channel page or a bare channel slug.
 */
export function parseKickTarget(input: string): ClipTarget {
    const text = input.trim();

    if (CLIP_ID.test(text)) {
        return clipTarget(text);
    }

    if (VOD_UUID.test(text)) {
        return { kind: "vod", id: text.toLowerCase() };
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

    const [first, section, id, ...rest] = url.pathname.split("/").filter(Boolean);
    const channel = first?.toLowerCase();

    if (!channel || RESERVED_PATHS.has(channel) || !CHANNEL_SLUG.test(channel)) {
        throw new Error(`"${input}" names no Kick channel`);
    }

    // Only the page shapes Kick has: a channel, its clips or videos tab, one clip, one VOD.
    if ((section && section !== "clips" && section !== "videos") || rest.length > 0) {
        throw new Error(`"${input}" is not a Kick channel, clips page, clip or VOD URL`);
    }

    if (section === "clips" && id) {
        if (!CLIP_ID.test(id)) {
            throw new Error(`"${input}" names no Kick clip (${id} is not a clip id)`);
        }

        return clipTarget(id);
    }

    if (section === "videos" && id) {
        if (!VOD_UUID.test(id)) {
            throw new Error(`"${input}" names no Kick VOD (${id} is not a VOD id)`);
        }

        return { kind: "vod", id: id.toLowerCase() };
    }

    const clipParam = url.searchParams.get("clip");

    if (clipParam !== null) {
        if (!CLIP_ID.test(clipParam)) {
            throw new Error(`"${input}" names no Kick clip (${clipParam} is not a clip id)`);
        }

        return clipTarget(clipParam);
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

/** Kick's `vod_starts_at` when it is a usable offset: whole seconds, above 0 (0 means not placed yet), under a week. */
export function siteOffset(value: number | null | undefined): number | null {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_VOD_OFFSET_SEC
        ? value
        : null;
}

function clipTarget(id: string): ClipTarget {
    return { kind: "clip", id: `clip_${id.slice(5).toUpperCase()}` };
}

function toClip(raw: z.infer<typeof clipSchema>): Clip {
    return {
        provider: "kick",
        id: raw.id,
        title: raw.title,
        mediaUrl: raw.clip_url,
        thumbnailUrl: raw.thumbnail_url ?? null,
        durationSec: raw.duration,
        views: raw.view_count ?? raw.views ?? 0,
        likes: raw.likes ?? 0,
        createdAt: raw.created_at,
        channel: raw.channel.slug,
        channelName: raw.channel.username,
        streamId: raw.livestream_id ?? null,
        vodOffsetSec: siteOffset(raw.vod_starts_at),
        creator: raw.creator?.username ?? null,
        category: raw.category?.name ?? null,
        mature: raw.is_mature ?? false,
        pageUrl: `https://kick.com/${raw.channel.slug}/clips/${raw.id}`,
    };
}

/** The wait `Retry-After` asks for (seconds or an HTTP date), as Kick says it; else 2, 4, 8, 16, 30 s by attempt. */
export function retryAfterMs(header: string | null, attempt: number, now = Date.now()): number {
    const seconds = Number(header);

    if (header && Number.isFinite(seconds) && seconds > 0) {
        return seconds * 1000;
    }

    const at = header ? Date.parse(header) : Number.NaN;

    if (!Number.isNaN(at) && at > now) {
        return at - now;
    }

    return Math.min(RATE_LIMIT_MAX_WAIT_MS, 2000 * 2 ** attempt);
}

async function request(
    url: string,
    signal?: AbortSignal
): Promise<{ status: number; ok: boolean; text: string; url: string }> {
    for (let attempt = 0; ; attempt++) {
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        logger.debug({ url, attempt }, "Kick request");
        const response = await fetch(url, {
            headers: { accept: "application/json, */*", "user-agent": BROWSER_USER_AGENT },
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        const text = await response.text();
        const answer = { status: response.status, ok: response.ok, text, url: response.url || url };

        if (response.status !== 429 || attempt >= RATE_LIMIT_RETRIES) {
            return answer;
        }

        const wait = retryAfterMs(response.headers.get("retry-after"), attempt);

        if (wait > RETRY_AFTER_MAX_MS) {
            logger.warn({ url, wait }, "Kick rate limit asks for a longer wait than this run waits out");
            throw new KickApiError(
                `Kick's rate limit asks to wait ${Math.ceil(wait / 60_000)} min; try again then`,
                429
            );
        }

        logger.debug({ url, attempt, wait }, "Kick rate limit; waiting");
        await abortableSleep(wait, signal);
    }
}

/** A playlist or another text file from Kick's CDN, sent as the API requests are, with the URL it came from. */
export async function fetchKickText(url: string, signal?: AbortSignal): Promise<FetchedText> {
    const answer = await request(url, signal);

    if (!answer.ok) {
        logger.warn({ url, status: answer.status, body: answer.text.slice(0, 300) }, "Kick CDN request failed");
        throw new KickApiError(`Kick answered HTTP ${answer.status} for ${url}`, answer.status);
    }

    return { text: answer.text, url: answer.url };
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
    const { status, ok, text } = await request(url, signal);
    if (status === 404) {
        throw new KickApiError(`Kick has no such channel or clip (${url})`, 404);
    }

    if (!ok) {
        const blocked = /cloudflare|just a moment/i.test(text)
            ? " (Cloudflare refused the request; try again later)"
            : "";
        // A 403 is Kick refusing a subscriber-only VOD, which the caller explains; anything else is worth a warning.
        logger[status === 403 ? "debug" : "warn"]({ url, status, body: text.slice(0, 500) }, "Kick API request failed");
        throw new KickApiError(`Kick answered HTTP ${status}${blocked}`, status);
    }

    let body: unknown;

    try {
        body = SafeJSON.parse(text, { strict: true });
    } catch (error) {
        logger.warn({ url, error, body: text.slice(0, 500) }, "Kick API answered no JSON");
        throw new KickApiError("Kick answered something that is not JSON (a Cloudflare check page?)", status);
    }

    const parsed = schema.safeParse(body);

    if (!parsed.success) {
        logger.warn({ url, issues: parsed.error.issues.slice(0, 5) }, "Kick API answer has an unknown shape");
        throw new KickApiError(`Kick's API answer changed shape: ${parsed.error.issues[0]?.message}`, status);
    }

    return parsed.data;
}

function toVod({
    stream,
    channel,
    video,
}: {
    stream: z.infer<typeof livestreamSchema>;
    channel: string;
    video: { uuid: string; is_private?: boolean | null; status?: string | null; source?: string | null } | null;
}): KickVodInfo {
    const access = video?.status ?? (video?.is_private ? "private" : "public");
    const source = video?.source || stream.source;
    return {
        vod: {
            provider: "kick",
            id: video?.uuid ?? String(stream.id),
            streamId: String(stream.id),
            title: stream.session_title ?? "",
            channel,
            startedAt: stream.start_time,
            durationSec: Math.round(stream.duration / 1000),
            live: stream.is_live,
            access,
            pageUrl: video ? `https://kick.com/${channel}/videos/${video.uuid}` : null,
        },
        playlistUrl: source && access === "public" ? source : null,
    };
}

/** The channel's recent streams with their VODs, newest first, as the channel's Videos tab lists them. */
export async function listKickVods(channel: string, signal?: AbortSignal): Promise<KickVodInfo[]> {
    const items = await getJson({
        url: `${API_ROOT}/channels/${encodeURIComponent(channel)}/videos`,
        schema: z.array(vodListItemSchema),
        signal,
    });
    return items.map((item) => toVod({ stream: item, channel, video: item.video ?? null }));
}

/** One VOD by its uuid. Kick refuses a subscriber-only VOD with HTTP 403. */
export async function fetchKickVod(uuid: string, signal?: AbortSignal): Promise<KickVodInfo> {
    try {
        const detail = await getJson({
            url: `${API_V1_ROOT}/video/${encodeURIComponent(uuid)}`,
            schema: vodDetailSchema,
            signal,
        });
        return toVod({ stream: detail.livestream, channel: detail.livestream.channel.slug, video: detail });
    } catch (error) {
        if (error instanceof KickApiError && error.status === 403) {
            throw new KickApiError(
                `Kick VOD ${uuid} is for subscribers only; Kick gives its playlist only to a logged-in subscriber`,
                403
            );
        }

        throw error;
    }
}

export async function fetchKickClip(id: string, signal?: AbortSignal): Promise<Clip> {
    const { clip } = await getJson({
        url: `${API_ROOT}/clips/${encodeURIComponent(id)}`,
        schema: clipDetailSchema,
        signal,
    });
    return toClip(clip);
}

/**
 * The channel's clips, page after page, until `limit` clips or the last page. `since` keeps only clips made at or after
 * it; sorted by date, the pages stop at the first page that reaches back past it.
 */
export async function listKickClips({
    channel,
    sort,
    range,
    limit,
    since,
    signal,
}: {
    channel: string;
    sort: KickClipSort;
    range: ClipRange;
    /** 0 takes every clip. */
    limit: number;
    since?: Date;
    signal?: AbortSignal;
}): Promise<Clip[]> {
    const clips: Clip[] = [];
    const max = limit === 0 ? Number.POSITIVE_INFINITY : limit;
    let cursor: string | null = null;
    let pages = 0;
    const seen = new Set<string>();

    while (clips.length < max) {
        const params = new URLSearchParams({ sort, time: range });

        if (cursor) {
            params.set("cursor", cursor);
        }

        const page = await getJson({
            url: `${API_ROOT}/channels/${encodeURIComponent(channel)}/clips?${params}`,
            schema: clipListSchema,
            signal,
        });
        pages++;
        const found = page.clips.map(toClip);
        clips.push(...(since ? found.filter((clip) => Date.parse(clip.createdAt) >= since.getTime()) : found));
        const reachedPast =
            since !== undefined &&
            sort === "date" &&
            found.some((clip) => Date.parse(clip.createdAt) < since.getTime());

        if (reachedPast || !page.nextCursor || page.clips.length === 0) {
            break;
        }

        if (page.nextCursor === cursor || seen.has(page.nextCursor)) {
            throw new KickApiError(
                `Kick's clip pages of ${channel} loop: page ${pages + 1} would repeat an earlier one; stopped with ${clips.length} clips`,
                null
            );
        }

        if (cursor) {
            seen.add(cursor);
        }

        cursor = page.nextCursor;
    }

    logger.debug(
        { channel, sort, range, limit, since: since?.toISOString(), pages, found: clips.length },
        "Kick clips listed"
    );
    return clips.slice(0, max);
}
