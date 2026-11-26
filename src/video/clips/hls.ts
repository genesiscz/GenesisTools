import { createHash } from "node:crypto";
import { type HlsMediaPlaylist, type HlsVariant, parsePlaylist } from "@genesiscz/utils/hls/playlist";
import { chooseQuality } from "@genesiscz/utils/video/choose-quality";
import { redactUrlQueries } from "@genesiscz/utils/video/process";
import { fileNamePart, requireRemoteHttpsUrl } from "./files";
import type { VodPlayback } from "./types";

/** A fetched text file and the URL it came from after redirects, which relative playlist entries resolve against. */
export interface FetchedText {
    text: string;
    url: string;
}

/** Each site sends its own headers; the HLS readers take the site's fetch. */
export type FetchText = (url: string, signal?: AbortSignal) => Promise<FetchedText>;

/** The stream time a playlist covers, from its program date times and the sum of its segments. */
export interface StreamSpan {
    startAt: string;
    endAt: string;
    durationSec: number;
}

function totalSec(playlist: HlsMediaPlaylist): number {
    return playlist.segments.reduce((sum, segment) => sum + segment.durationSec, 0);
}

/**
 * The span from the first segment that carries an `EXT-X-PROGRAM-DATE-TIME`, counted back over the segments before it
 * (RFC 8216 4.3.2.6); null when no segment carries one.
 */
export function spanOf(playlist: HlsMediaPlaylist): StreamSpan | null {
    let before = 0;

    for (const segment of playlist.segments) {
        const at = Date.parse(segment.programDateTime ?? "");

        if (!Number.isNaN(at)) {
            const start = at - before * 1000;
            const durationSec = totalSec(playlist);
            return {
                startAt: new Date(start).toISOString(),
                endAt: new Date(start + durationSec * 1000).toISOString(),
                durationSec,
            };
        }

        before += segment.durationSec;
    }

    return null;
}

/** Fetches a playlist, refusing a redirect to anything but https, and parses it against the URL it came from. */
async function readPlaylist({ url, fetchText, signal }: { url: string; fetchText: FetchText; signal?: AbortSignal }) {
    const fetched = await fetchText(url, signal);
    const finalUrl = requireRemoteHttpsUrl(fetched.url || url, "HLS playlist");
    return { playlist: parsePlaylist(fetched.text, finalUrl), url: finalUrl };
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
    const { playlist } = await readPlaylist({ url, fetchText, signal });

    if (playlist.kind !== "media") {
        throw new Error(`${redactUrlQueries(url)} is a master playlist, not a media playlist`);
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

function folderOf(variant: HlsVariant): string {
    return variant.uri.split("?")[0]?.split("/").at(-2) ?? "";
}

/** `1080p`, `720p60` from the resolution and frame rate (30 fps and below take no suffix), else the variant's folder. */
function baseName(variant: HlsVariant): string {
    if (!variant.height) {
        return folderOf(variant) || "source";
    }

    const fps = variant.frameRate && variant.frameRate > 31 ? String(Math.round(variant.frameRate)) : "";
    return `${variant.height}p${fps}`;
}

/**
 * The variant's name among `variants`: `1080p60`, `720p`. Two variants that would share a name keep them apart with
 * their folder (`720p-720p30`), so each rendition has its own file name and manifest quality.
 */
export function variantName(variant: HlsVariant, variants: HlsVariant[] = [variant]): string {
    const base = baseName(variant);
    const twins = variants.filter((other) => baseName(other) === base);
    if (twins.length < 2) {
        return base;
    }

    const folder = fileNamePart(folderOf(variant));
    const sameFolder = twins.filter((other) => fileNamePart(folderOf(other)) === folder);
    if (folder && sameFolder.length === 1) {
        return `${base}-${folder}`;
    }

    const identity = new URL(variant.uri);
    identity.search = "";
    identity.hash = "";
    const hash = createHash("sha256").update(identity.href).digest("hex").slice(0, 16);
    return `${base}-${folder ? `${folder}-` : ""}${hash}`;
}

/** The variant `quality` names (see `chooseQuality`), else the highest bitrate. */
export function pickVariant(variants: HlsVariant[], quality?: string): HlsVariant {
    return chooseQuality({
        options: [...variants].sort((a, b) => b.bandwidth - a.bandwidth),
        quality,
        names: (variant) => [variantName(variant, variants), baseName(variant), folderOf(variant)].filter(Boolean),
        height: (variant) => variant.height,
    });
}

/**
 * The VOD's variant for a cut, with its length and, when the playlist carries it, the stream time it starts at.
 * Refuses a variant whose audio is a separate playlist: `-c copy` from the video playlist alone would save no sound.
 */
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
    const first = await readPlaylist({ url: masterUrl, fetchText, signal });

    if (first.playlist.kind === "media") {
        return {
            variantUrl: first.url,
            variantName: "source",
            bandwidth: 0,
            durationSec: totalSec(first.playlist),
            startAt: spanOf(first.playlist)?.startAt ?? null,
        };
    }

    const { variants, separateAudioGroups } = first.playlist;
    const variant = pickVariant(variants, quality);

    if (variant.audioGroup && separateAudioGroups.includes(variant.audioGroup)) {
        throw new Error(
            `The VOD's ${variantName(variant, variants)} variant keeps its audio in a separate playlist, which this cut does not merge; a copy would have no sound`
        );
    }

    const media = await readMedia({ url: variant.uri, fetchText, signal });
    return {
        variantUrl: variant.uri,
        variantName: variantName(variant, variants),
        bandwidth: variant.bandwidth,
        durationSec: totalSec(media),
        startAt: spanOf(media)?.startAt ?? null,
    };
}
