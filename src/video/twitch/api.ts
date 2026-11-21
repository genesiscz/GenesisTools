import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { chooseQuality } from "@genesiscz/utils/video/choose-quality";
import { z } from "zod";
import { CLIP_RANGES, type Clip, type ClipMedia, type ClipRange, type ClipTarget, type Vod } from "../clips/types";

const GQL_URL = "https://gql.twitch.tv/gql";
const USHER_URL = "https://usher.ttvnw.net/vod";
/** The client id twitch.tv itself sends; GQL answers it without a login for public data. */
const WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const REQUEST_TIMEOUT_MS = 20_000;
const PAGE_SIZE = 100;
const PLAYER_PARAMS = '{platform: "web", playerBackend: "mediaplayer", playerType: "site"}';

/**
 * `view` and `trending` are Twitch's own orders. Twitch's API refuses a date order, so `date` reads the whole range
 * by views and sorts it by creation here; a large range costs as many pages as it has clips.
 */
export const TWITCH_CLIP_SORTS = ["view", "trending", "date"] as const;
export type TwitchClipSort = (typeof TWITCH_CLIP_SORTS)[number];

const SORT_CRITERIA: Record<TwitchClipSort, string> = { view: "VIEWS_DESC", trending: "TRENDING", date: "VIEWS_DESC" };
const RANGE_PERIOD: Record<ClipRange, string> = {
    day: "LAST_DAY",
    week: "LAST_WEEK",
    month: "LAST_MONTH",
    all: "ALL_TIME",
};
/** The `range` value of a twitch.tv clips page URL. */
const PAGE_RANGE: Record<string, ClipRange> = { "24hr": "day", "7d": "week", "30d": "month", all: "all" };

const LOGIN = /^[a-z0-9_]{1,25}$/i;
/** A clip slug: CamelCase words, today with a `-` and a 16 character suffix; older ones are longer than any login. */
const CLIP_SLUG = /^[A-Za-z0-9]+(-[A-Za-z0-9_-]+)?$/;
const VOD_ID = /^\d{5,}$/;
const RESERVED_PATHS = new Set(["directory", "videos", "search", "settings", "downloads", "p", "jobs", "turbo"]);

const clipFields = `id slug title url viewCount durationSeconds createdAt thumbnailURL videoOffsetSeconds
    curator { login displayName } game { name } broadcaster { login displayName } video { id }`;
const vodFields = "id title createdAt lengthSeconds status owner { login displayName }";

const clipSchema = z.object({
    id: z.string(),
    slug: z.string(),
    title: z.string(),
    url: z.string(),
    viewCount: z.number(),
    durationSeconds: z.number(),
    createdAt: z.string(),
    thumbnailURL: z.string().nullish(),
    videoOffsetSeconds: z.number().nullish(),
    curator: z.object({ login: z.string(), displayName: z.string() }).nullish(),
    game: z.object({ name: z.string() }).nullish(),
    broadcaster: z.object({ login: z.string(), displayName: z.string() }).nullish(),
    video: z.object({ id: z.string() }).nullish(),
});

const vodSchema = z.object({
    id: z.string(),
    title: z.string().nullish(),
    createdAt: z.string(),
    lengthSeconds: z.number(),
    /** `RECORDING` while the stream is live. */
    status: z.string().nullish(),
    owner: z.object({ login: z.string(), displayName: z.string() }).nullish(),
});

const clipPageSchema = z.object({
    user: z
        .object({
            clips: z.object({
                edges: z.array(z.object({ cursor: z.string().nullish(), node: clipSchema })),
                pageInfo: z.object({ hasNextPage: z.boolean() }),
            }),
        })
        .nullish(),
});

const tokenSchema = z.object({ signature: z.string(), value: z.string() });

export class TwitchApiError extends Error {
    constructor(
        message: string,
        readonly status: number | null
    ) {
        super(message);
        this.name = "TwitchApiError";
    }
}

function isRange(value: string | undefined): value is ClipRange {
    return CLIP_RANGES.some((range) => range === value);
}

/**
 * Reads a clip URL (`twitch.tv/<channel>/clip/<slug>`, `clips.twitch.tv/<slug>`), a bare clip slug, a VOD URL
 * (`twitch.tv/videos/<id>`) or its bare id, a clips page (`twitch.tv/<channel>/clips?range=7d`), a channel page or a
 * bare login.
 */
export function parseTwitchTarget(input: string): ClipTarget {
    const text = input.trim();

    if (VOD_ID.test(text)) {
        return { kind: "vod", id: text };
    }

    if (LOGIN.test(text)) {
        return { kind: "channel", channel: text.toLowerCase() };
    }

    if (CLIP_SLUG.test(text)) {
        return { kind: "clip", id: text };
    }

    let url: URL;

    try {
        url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    } catch (error) {
        logger.debug({ error, input }, "Twitch target is not a URL");
        throw new Error(`"${input}" is not a Twitch clip, VOD, channel or clips page URL`);
    }

    if (!/(^|\.)twitch\.tv$/i.test(url.hostname)) {
        throw new Error(`"${input}" is not a twitch.tv URL`);
    }

    const [first, second, third] = url.pathname.split("/").filter(Boolean);

    if (/^clips\.twitch\.tv$/i.test(url.hostname) && first && CLIP_SLUG.test(first)) {
        return { kind: "clip", id: first };
    }

    if (first === "videos" && second && VOD_ID.test(second)) {
        return { kind: "vod", id: second };
    }

    if (!first || RESERVED_PATHS.has(first.toLowerCase()) || !LOGIN.test(first)) {
        throw new Error(`"${input}" names no Twitch channel`);
    }

    if (second === "clip" && third && CLIP_SLUG.test(third)) {
        return { kind: "clip", id: third };
    }

    const range = PAGE_RANGE[url.searchParams.get("range") ?? ""];
    return { kind: "channel", channel: first.toLowerCase(), ...(isRange(range) ? { range } : {}) };
}

async function gql<T>({
    query,
    pick,
    signal,
}: {
    query: string;
    /** Takes the wanted part out of `data`. */
    pick: z.ZodType<T>;
    signal?: AbortSignal;
}): Promise<T> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    logger.debug({ query: query.slice(0, 200) }, "Twitch GQL request");
    const response = await fetch(GQL_URL, {
        method: "POST",
        headers: { "client-id": WEB_CLIENT_ID, "content-type": "application/json" },
        body: SafeJSON.stringify({ query }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = await response.text();

    if (!response.ok) {
        logger.warn({ status: response.status, body: text.slice(0, 500) }, "Twitch GQL request failed");
        throw new TwitchApiError(`Twitch answered HTTP ${response.status}`, response.status);
    }

    const body = z
        .object({ data: z.unknown().nullish(), errors: z.array(z.object({ message: z.string() })).nullish() })
        .parse(SafeJSON.parse(text, { strict: true }));

    if (body.errors?.length) {
        logger.warn({ errors: body.errors, query: query.slice(0, 300) }, "Twitch GQL answered errors");
        throw new TwitchApiError(
            `Twitch GQL: ${body.errors.map((error) => error.message).join("; ")}`,
            response.status
        );
    }

    const parsed = pick.safeParse(body.data);

    if (!parsed.success) {
        logger.warn({ issues: parsed.error.issues.slice(0, 5) }, "Twitch GQL answer has an unknown shape");
        throw new TwitchApiError(`Twitch's GQL answer changed shape: ${parsed.error.issues[0]?.message}`, 200);
    }

    return parsed.data;
}

function literal(value: string): string {
    return SafeJSON.stringify(value);
}

function toClip(raw: z.infer<typeof clipSchema>): Clip {
    const login = raw.broadcaster?.login ?? raw.url.split("/")[3] ?? "";
    return {
        provider: "twitch",
        id: raw.slug,
        title: raw.title,
        pageUrl: raw.url,
        mediaUrl: raw.url,
        thumbnailUrl: raw.thumbnailURL ?? null,
        durationSec: raw.durationSeconds,
        views: raw.viewCount,
        likes: 0,
        createdAt: raw.createdAt,
        channel: login,
        channelName: raw.broadcaster?.displayName ?? login,
        creator: raw.curator?.displayName ?? null,
        category: raw.game?.name ?? null,
        mature: false,
        streamId: raw.video?.id ?? null,
        vodOffsetSec: raw.videoOffsetSeconds ?? null,
    };
}

function toVod(raw: z.infer<typeof vodSchema>, channel: string): Vod {
    return {
        provider: "twitch",
        id: raw.id,
        streamId: raw.id,
        title: raw.title ?? "",
        channel: raw.owner?.login ?? channel,
        startedAt: new Date(raw.createdAt).toISOString(),
        durationSec: raw.lengthSeconds,
        live: raw.status === "RECORDING",
        access: "public",
        pageUrl: `https://www.twitch.tv/videos/${raw.id}`,
    };
}

/**
 * The channel's clips, page after page, until `limit` clips or the last page. `since` keeps only clips made at or
 * after it. With `date`, every page of the range is read first, because Twitch orders only by views.
 */
export async function listTwitchClips({
    channel,
    sort,
    range,
    limit,
    since,
    signal,
}: {
    channel: string;
    sort: TwitchClipSort;
    range: ClipRange;
    /** 0 takes every clip. */
    limit: number;
    since?: Date;
    signal?: AbortSignal;
}): Promise<Clip[]> {
    const clips: Clip[] = [];
    const max = limit === 0 || sort === "date" ? Number.POSITIVE_INFINITY : limit;
    let cursor: string | null = null;
    let pages = 0;

    while (clips.length < max) {
        const after: string = cursor ? `, after: ${literal(cursor)}` : "";
        const page: z.infer<typeof clipPageSchema> = await gql({
            query: `query { user(login: ${literal(channel)}) { clips(first: ${PAGE_SIZE}${after}, criteria: { period: ${RANGE_PERIOD[range]}, sort: ${SORT_CRITERIA[sort]} }) { edges { cursor node { ${clipFields} } } pageInfo { hasNextPage } } } }`,
            pick: clipPageSchema,
            signal,
        });

        if (!page.user) {
            throw new TwitchApiError(`Twitch has no channel "${channel}"`, 404);
        }

        pages++;
        const { edges, pageInfo } = page.user.clips;
        const found = edges.map((edge) => toClip(edge.node));
        clips.push(...(since ? found.filter((clip) => Date.parse(clip.createdAt) >= since.getTime()) : found));
        const nextCursor: string | null = edges.at(-1)?.cursor ?? null;

        if (!pageInfo.hasNextPage || edges.length === 0 || !nextCursor || nextCursor === cursor) {
            break;
        }

        cursor = nextCursor;
    }

    logger.debug({ channel, sort, range, limit, pages, found: clips.length }, "Twitch clips listed");
    const ordered = sort === "date" ? clips.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : clips;
    return limit === 0 ? ordered : ordered.slice(0, limit);
}

export async function fetchTwitchClip(slug: string, signal?: AbortSignal): Promise<Clip> {
    const { clip } = await gql({
        query: `query { clip(slug: ${literal(slug)}) { ${clipFields} } }`,
        pick: z.object({ clip: clipSchema.nullish() }),
        signal,
    });

    if (!clip) {
        throw new TwitchApiError(`Twitch has no clip "${slug}"`, 404);
    }

    return toClip(clip);
}

/** `1080p60` from Twitch's `1080` and 60 fps; 30 fps and below take no suffix. */
function twitchQualityName({ quality, frameRate }: { quality: string; frameRate?: number | null }): string {
    return frameRate && frameRate > 31 ? `${quality}p${Math.round(frameRate)}` : `${quality}p`;
}

/** The clip's MP4 in `quality` (default `best`), signed with a fresh playback token (it expires after about a day). */
export async function twitchClipMedia({
    slug,
    quality,
    signal,
}: {
    slug: string;
    quality?: string;
    signal?: AbortSignal;
}): Promise<ClipMedia> {
    const { clip } = await gql({
        query: `query { clip(slug: ${literal(slug)}) { playbackAccessToken(params: ${PLAYER_PARAMS}) { signature value } videoQualities { quality frameRate sourceURL } } }`,
        pick: z.object({
            clip: z
                .object({
                    playbackAccessToken: tokenSchema,
                    videoQualities: z.array(
                        z.object({ quality: z.string(), frameRate: z.number().nullish(), sourceURL: z.string() })
                    ),
                })
                .nullish(),
        }),
        signal,
    });
    const offered = (clip?.videoQualities ?? []).toSorted(
        (a, b) => Number(b.quality) - Number(a.quality) || (b.frameRate ?? 0) - (a.frameRate ?? 0)
    );

    if (!clip || offered.length === 0) {
        throw new TwitchApiError(`Twitch serves no video for clip "${slug}"`, 404);
    }

    const chosen = chooseQuality({
        options: offered,
        quality,
        names: (option) => [twitchQualityName(option)],
        height: (option) => Number(option.quality),
    });
    const { signature, value } = clip.playbackAccessToken;
    return {
        url: `${chosen.sourceURL}?sig=${signature}&token=${encodeURIComponent(value)}`,
        quality: twitchQualityName(chosen),
        best: chosen === offered[0],
    };
}

/** The channel's past broadcasts, newest first. */
export async function listTwitchVods(channel: string, signal?: AbortSignal): Promise<Vod[]> {
    const { user } = await gql({
        query: `query { user(login: ${literal(channel)}) { videos(first: ${PAGE_SIZE}, type: ARCHIVE, sort: TIME) { edges { node { ${vodFields} } } } } }`,
        pick: z.object({
            user: z.object({ videos: z.object({ edges: z.array(z.object({ node: vodSchema })) }) }).nullish(),
        }),
        signal,
    });

    if (!user) {
        throw new TwitchApiError(`Twitch has no channel "${channel}"`, 404);
    }

    return user.videos.edges.map((edge) => toVod(edge.node, channel));
}

export async function fetchTwitchVod(id: string, signal?: AbortSignal): Promise<Vod> {
    const { video } = await gql({
        query: `query { video(id: ${literal(id)}) { ${vodFields} } }`,
        pick: z.object({ video: vodSchema.nullish() }),
        signal,
    });

    if (!video) {
        throw new TwitchApiError(`Twitch has no VOD ${id}`, 404);
    }

    return toVod(video, video.owner?.login ?? "");
}

/** The VOD's master playlist, signed with a fresh playback token. Twitch's CDN refuses a subscriber-only VOD. */
export async function twitchVodPlaylistUrl(id: string, signal?: AbortSignal): Promise<string> {
    const { videoPlaybackAccessToken: token } = await gql({
        query: `query { videoPlaybackAccessToken(id: ${literal(id)}, params: ${PLAYER_PARAMS}) { signature value } }`,
        pick: z.object({ videoPlaybackAccessToken: tokenSchema.nullish() }),
        signal,
    });

    if (!token) {
        throw new TwitchApiError(`Twitch gives no playback token for VOD ${id}`, 403);
    }

    const params = new URLSearchParams({
        sig: token.signature,
        token: token.value,
        allow_source: "true",
        player: "twitchweb",
    });
    return `${USHER_URL}/${encodeURIComponent(id)}.m3u8?${params}`;
}

/** A playlist from Twitch's CDN; HTTP 403 there means a subscriber-only VOD. */
export async function fetchTwitchText(url: string, signal?: AbortSignal): Promise<string> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    const text = await response.text();

    if (response.status === 403) {
        throw new TwitchApiError("Twitch refuses this VOD without a login (subscriber-only)", 403);
    }

    if (!response.ok) {
        logger.warn({ url: url.split("?")[0], status: response.status }, "Twitch CDN request failed");
        throw new TwitchApiError(`Twitch's CDN answered HTTP ${response.status}`, response.status);
    }

    return text;
}
