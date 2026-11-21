import { type HlsMediaPlaylist, type HlsVariant, parsePlaylist } from "@genesiscz/utils/hls/playlist";
import { chooseQuality } from "@genesiscz/utils/video/choose-quality";
import type { VodPlayback } from "./types";

/** Each site sends its own headers; the HLS readers take the site's fetch. */
export type FetchText = (url: string, signal?: AbortSignal) => Promise<string>;

/** The stream time a playlist covers, from its first `EXT-X-PROGRAM-DATE-TIME` and the sum of its segments. */
export interface StreamSpan {
    startAt: string;
    endAt: string;
    durationSec: number;
}

function totalSec(playlist: HlsMediaPlaylist): number {
    return playlist.segments.reduce((sum, segment) => sum + segment.durationSec, 0);
}

function spanOf(playlist: HlsMediaPlaylist): StreamSpan | null {
    const start = Date.parse(playlist.segments[0]?.programDateTime ?? "");

    if (Number.isNaN(start)) {
        return null;
    }

    const durationSec = totalSec(playlist);
    return {
        startAt: new Date(start).toISOString(),
        endAt: new Date(start + durationSec * 1000).toISOString(),
        durationSec,
    };
}

async function readMedia({
    url,
    fetchText,
    signal,
}: {
    url: string;
    fetchText: FetchText;
    signal?: AbortSignal;
}): Promise<HlsMediaPlaylist> {
    const playlist = parsePlaylist(await fetchText(url, signal), url);

    if (playlist.kind !== "media") {
        throw new Error(`${url} is a master playlist, not a media playlist`);
    }

    return playlist;
}

/** The stream time a media playlist covers; null when it carries no program date time. */
export async function readStreamSpan({
    url,
    fetchText,
    signal,
}: {
    url: string;
    fetchText: FetchText;
    signal?: AbortSignal;
}): Promise<StreamSpan | null> {
    return spanOf(await readMedia({ url, fetchText, signal }));
}

/** `1080p` from the resolution, else the variant's folder name (`1080p60`, `chunked`). */
export function variantName(variant: HlsVariant): string {
    return variant.height ? `${variant.height}p` : (variant.uri.split("/").at(-2) ?? "source");
}

/** The variant `quality` names (see `chooseQuality`), else the highest bitrate. */
export function pickVariant(variants: HlsVariant[], quality?: string): HlsVariant {
    return chooseQuality({
        options: [...variants].sort((a, b) => b.bandwidth - a.bandwidth),
        quality,
        names: (variant) => [variantName(variant), variant.uri.split("/").at(-2) ?? ""],
        height: (variant) => variant.height,
    });
}

/** The VOD's variant for a cut, with its length and, when the playlist carries it, the stream time it starts at. */
export async function readVodPlayback({
    masterUrl,
    quality,
    fetchText,
    signal,
}: {
    masterUrl: string;
    quality?: string;
    fetchText: FetchText;
    signal?: AbortSignal;
}): Promise<VodPlayback> {
    const master = parsePlaylist(await fetchText(masterUrl, signal), masterUrl);
    const variant = master.kind === "master" ? pickVariant(master.variants, quality) : null;
    const variantUrl = variant?.uri ?? masterUrl;
    const media = await readMedia({ url: variantUrl, fetchText, signal });
    return {
        variantUrl,
        variantName: variant ? variantName(variant) : "source",
        bandwidth: variant?.bandwidth ?? 0,
        durationSec: totalSec(media),
        startAt: spanOf(media)?.startAt ?? null,
    };
}
