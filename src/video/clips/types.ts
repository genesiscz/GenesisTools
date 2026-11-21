/** The sites `tools video` reads clips and VODs from. Adding one is a folder and an entry in `CLIP_PROVIDERS`. */
export const CLIP_PROVIDER_IDS = ["kick", "twitch"] as const;
export type ClipProviderId = (typeof CLIP_PROVIDER_IDS)[number];

/** How far back a clip list reaches; every provider maps these four to its own words. */
export const CLIP_RANGES = ["day", "week", "month", "all"] as const;
export type ClipRange = (typeof CLIP_RANGES)[number];

export interface Clip {
    provider: ClipProviderId;
    id: string;
    title: string;
    /** The clip's page on the site. */
    pageUrl: string;
    /** The clip's video: Kick's HLS playlist, Twitch's MP4 (which still needs a token to play). */
    mediaUrl: string;
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
    /** The stream the clip was cut from; the VOD of that stream carries the same `streamId`. */
    streamId: string | null;
    /** The clip's start in its VOD as the site says it (Twitch; Kick rounds down to a whole second); null when unsaid. */
    vodOffsetSec: number | null;
}

/** A stream's recording. */
export interface Vod {
    provider: ClipProviderId;
    /** The id in the VOD's URL. */
    id: string;
    streamId: string;
    title: string;
    channel: string;
    startedAt: string;
    durationSec: number;
    live: boolean;
    /** The site's own word: `public`, `subscriber_only`, … */
    access: string;
    pageUrl: string | null;
}

/** What a command-line argument names. `sort` and `range` come from a clips page URL. */
export type ClipTarget =
    | { kind: "clip"; id: string }
    | { kind: "vod"; id: string }
    | { kind: "channel"; channel: string; sort?: string; range?: ClipRange };

/**
 * How a clip's place in its VOD was found. `site`: the site names the offset (Twitch; Kick in whole seconds, used only
 * when the VOD playlist is closed). `vod-playlist`: clip and VOD playlists both carry stream time (Kick, public VOD),
 * exact to the segment. `stream-start`: neither, so the offset counts from the site's stream start, which the VOD's
 * first frame follows by a few seconds.
 */
export type OffsetSource = "site" | "vod-playlist" | "stream-start";

/** A clip's place in the stream it was cut from. Offsets count seconds into the VOD. */
export interface ClipSource {
    streamId: string;
    vodId: string | null;
    vodPageUrl: string | null;
    /** The VOD page opened at the clip, when the site has such a link. */
    vodUrlAtClip: string | null;
    /** Stream (wall-clock) time of the clip's first and last frame; null when nothing gives it. */
    startAt: string | null;
    endAt: string | null;
    vodOffsetSec: number | null;
    vodEndOffsetSec: number | null;
    offsetFrom: OffsetSource | null;
}

/** The variant playlist of a VOD that ffmpeg reads for a cut. */
export interface VodPlayback {
    variantUrl: string;
    variantName: string;
    /** Bits per second from the master playlist; 0 when unknown. */
    bandwidth: number;
    durationSec: number;
    /** Stream time of the first frame, when the playlist carries it. */
    startAt: string | null;
}

/** A clip file the site serves now (Twitch signs its URL with a fresh token). */
export interface ClipMedia {
    url: string;
    /** `1080p60`, `720p`; `source` when the site serves one quality only. */
    quality: string;
    /** True when no better quality is offered. */
    best: boolean;
}

export interface PlacedClips {
    sources: Map<string, ClipSource | null>;
    vods: Array<{ vod: Vod; playback: VodPlayback | null }>;
}

export interface ListClipsOptions {
    channel: string;
    sort: string;
    range: ClipRange;
    /** 0 takes every clip. */
    limit: number;
    since?: Date;
    signal?: AbortSignal;
}

/** Everything `tools video <provider>` needs from a site. Each member is one folder under `src/video/`. */
export interface ClipProvider {
    id: ClipProviderId;
    label: string;
    /** The sort words of the site's clips page; the first is the default. */
    sorts: readonly string[];
    defaultRange: ClipRange;
    /** A clips page URL for help texts. */
    exampleClipsUrl: string;
    /** Throws when the input is not this site's clip, VOD, clips page or channel. */
    parseTarget(input: string): ClipTarget;
    listClips(options: ListClipsOptions): Promise<Clip[]>;
    fetchClip(id: string, signal?: AbortSignal): Promise<Clip>;
    /** True when the site serves a clip in more than one quality (Twitch). Kick serves only the stream's own. */
    clipQualities: boolean;
    /** The clip in `quality` (see `chooseQuality`, default `best`), at a URL ffmpeg can read now. */
    clipMedia(options: { clip: Clip; quality?: string; signal?: AbortSignal }): Promise<ClipMedia>;
    /** The part of a clip file name that names the clip, and back; a rerun finds its file by it. */
    clipFileId(clip: Clip): string;
    clipIdFromFileName(name: string): string | null;
    listVods(channel: string, signal?: AbortSignal): Promise<Vod[]>;
    fetchVod(id: string, signal?: AbortSignal): Promise<Vod>;
    /** The VOD's variant for a cut (`quality`: a name such as `720p`, else the best); throws with the reason when the site serves none (subscriber-only, gone). */
    vodPlayback(options: { vod: Vod; quality?: string; signal?: AbortSignal }): Promise<VodPlayback>;
    /** Each clip's place in its VOD, and the VODs it read for that. A failed request leaves a clip unplaced. */
    placeClips(options: { clips: Clip[]; jobs: number; signal?: AbortSignal }): Promise<PlacedClips>;
}
