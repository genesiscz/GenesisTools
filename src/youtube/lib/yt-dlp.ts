import { SafeJSON } from "@app/utils/json";
import type { ChannelHandle } from "@app/youtube/lib/channel.types";
import type { ListedVideo, ListChannelVideosOpts, YtDlpAvailability } from "@app/youtube/lib/yt-dlp.types";

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
