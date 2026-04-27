import { SafeJSON } from "@app/utils/json";
import type { ChannelHandle } from "@app/youtube/lib/channel.types";
import type { DumpedVideoMetadata, ListedVideo, ListChannelVideosOpts, YtDlpAvailability } from "@app/youtube/lib/yt-dlp.types";

interface RawListing {
    entries?: RawListedVideo[];
}

interface RawListedVideo {
    id?: string;
    title?: string;
    duration?: number;
    upload_date?: string;
    live_status?: string;
}

interface RawDumpJson {
    id?: string;
    title?: string;
    description?: string;
    upload_date?: string;
    duration?: number;
    view_count?: number;
    like_count?: number;
    language?: string;
    subtitles?: Record<string, unknown>;
    automatic_captions?: Record<string, unknown>;
    tags?: string[];
    aspect_ratio?: number;
    is_live?: boolean;
    thumbnail?: string;
    uploader_id?: string;
    channel_id?: string;
    channel?: string;
}

export async function checkYtDlp(): Promise<YtDlpAvailability> {
    try {
        const proc = Bun.spawn(["yt-dlp", "--version"], { stdio: ["ignore", "pipe", "pipe"] });
        const out = await new Response(proc.stdout).text();
        const exit = await proc.exited;

        return { available: exit === 0, version: exit === 0 ? out.trim() : null };
    } catch {
        return { available: false, version: null };
    }
}

export async function listChannelVideos(opts: ListChannelVideosOpts): Promise<ListedVideo[]> {
    const normalVideos = await runChannelListing(opts, false);

    if (!opts.includeShorts) {
        return normalVideos;
    }

    const shortVideos = await runChannelListing(opts, true);
    const seen = new Set<string>();

    return [...normalVideos, ...shortVideos].filter((video) => {
        if (seen.has(video.id)) {
            return false;
        }

        seen.add(video.id);

        return true;
    });
}

async function runChannelListing(opts: ListChannelVideosOpts, shortsOnly: boolean): Promise<ListedVideo[]> {
    const url = `https://www.youtube.com/${opts.handle}/videos`;
    const args = ["yt-dlp", "--flat-playlist", "--dump-single-json", "--no-warnings"];

    if (opts.limit) {
        args.push("--playlist-end", String(opts.limit));
    }

    if (opts.sinceUploadDate) {
        args.push("--dateafter", opts.sinceUploadDate.replaceAll("-", ""));
    }

    if (shortsOnly) {
        args.push("--match-filter", "is_short");
    } else if (!opts.includeShorts) {
        args.push("--match-filter", "!is_short");
    }

    args.push(url);
    const proc = Bun.spawn(args, { stdio: ["ignore", "pipe", "pipe"], signal: opts.signal });
    const stdout = await new Response(proc.stdout).text();
    const exit = await proc.exited;

    if (exit !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`yt-dlp listChannelVideos failed: ${stderr.trim()}`);
    }

    const raw = SafeJSON.parse(stdout, { strict: true }) as RawListing | undefined;

    return (raw?.entries ?? []).flatMap((entry) => normalizeListedVideo(entry, shortsOnly));
}

export async function dumpVideoMetadata(idOrUrl: string, opts: { signal?: AbortSignal } = {}): Promise<DumpedVideoMetadata> {
    const proc = Bun.spawn(["yt-dlp", "--skip-download", "--dump-json", "--no-warnings", idOrUrl], {
        stdio: ["ignore", "pipe", "pipe"],
        signal: opts.signal,
    });
    const stdout = await new Response(proc.stdout).text();
    const exit = await proc.exited;

    if (exit !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`yt-dlp dumpVideoMetadata failed: ${stderr.trim()}`);
    }

    const raw = SafeJSON.parse(stdout, { strict: true }) as RawDumpJson | undefined;

    if (!raw?.id || !raw.title) {
        throw new Error("yt-dlp returned empty metadata");
    }

    return {
        id: raw.id,
        title: raw.title,
        description: raw.description ?? null,
        uploadDate: normalizeUploadDate(raw.upload_date),
        durationSec: raw.duration ?? null,
        viewCount: raw.view_count ?? null,
        likeCount: raw.like_count ?? null,
        language: raw.language ?? null,
        availableCaptionLangs: Object.keys({ ...(raw.subtitles ?? {}), ...(raw.automatic_captions ?? {}) }),
        tags: raw.tags ?? [],
        isShort: raw.duration !== undefined && raw.duration <= 60 && (raw.aspect_ratio ?? 1) < 1,
        isLive: raw.is_live ?? false,
        thumbUrl: raw.thumbnail ?? null,
        channelHandle: raw.uploader_id?.startsWith("@") ? (raw.uploader_id as ChannelHandle) : null,
        channelId: raw.channel_id ?? null,
        channelTitle: raw.channel ?? null,
    };
}

function normalizeListedVideo(entry: RawListedVideo, isShort: boolean): ListedVideo[] {
    if (!entry.id || !entry.title) {
        return [];
    }

    return [
        {
            id: entry.id,
            title: entry.title,
            durationSec: entry.duration ?? null,
            uploadDate: normalizeUploadDate(entry.upload_date),
            isShort,
            isLive: entry.live_status === "is_live" || entry.live_status === "is_upcoming",
        },
    ];
}

function normalizeUploadDate(uploadDate?: string): string | null {
    if (!uploadDate || uploadDate.length !== 8) {
        return null;
    }

    return `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`;
}
