import { stat } from "node:fs/promises";
import { SafeJSON } from "@app/utils/json";
import type { ChannelHandle } from "@app/youtube/lib/channel.types";
import type {
    DownloadAudioOpts,
    DownloadAudioResult,
    DownloadVideoOpts,
    DownloadVideoResult,
    DumpedVideoMetadata,
    ListedVideo,
    ListChannelVideosOpts,
    YtDlpAvailability,
} from "@app/youtube/lib/yt-dlp.types";

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

export async function downloadAudio(opts: DownloadAudioOpts): Promise<DownloadAudioResult> {
    const args = ["yt-dlp", "-x", "--no-playlist", "--newline", "-o", opts.outPath];

    if (opts.format === "wav") {
        args.push("--audio-format", "wav", "--postprocessor-args", `ffmpeg:-ar ${opts.sampleRate ?? 16000} -ac 1`);
    } else {
        args.push("--audio-format", "opus", "--audio-quality", `${opts.bitrate ?? 64}K`);
    }

    args.push(opts.idOrUrl);
    await runDownloadWithProgress(args, opts.signal, (line) => {
        parseProgressLine(line, opts.onProgress);
    }, "downloadAudio");
    const file = await stat(opts.outPath);

    return { path: opts.outPath, sizeBytes: file.size, durationSec: null };
}

export async function downloadVideo(opts: DownloadVideoOpts): Promise<DownloadVideoResult> {
    const heightMap = { "720p": 720, "1080p": 1080, best: undefined };
    const fmtFilter =
        opts.quality === "best"
            ? "bv*+ba/b"
            : `bv*[height<=${heightMap[opts.quality]}]+ba/b[height<=${heightMap[opts.quality]}]`;
    const args = ["yt-dlp", "-f", fmtFilter, "--merge-output-format", "mp4", "--no-playlist", "--newline", "-o", opts.outPath, opts.idOrUrl];

    await runDownloadWithProgress(args, opts.signal, (line) => {
        parseProgressLine(line, opts.onProgress);
    }, "downloadVideo");
    const file = await stat(opts.outPath);

    return { path: opts.outPath, sizeBytes: file.size };
}

async function runDownloadWithProgress(args: string[], signal: AbortSignal | undefined, onLine: (line: string) => void, label: string): Promise<string> {
    const proc = Bun.spawn(args, { stdio: ["ignore", "pipe", "pipe"], signal });
    let stderr = "";

    await streamProgress(proc.stderr, (line) => {
        stderr += `${line}\n`;
        onLine(line);
    });

    const exit = await proc.exited;

    if (exit !== 0) {
        throw new Error(`yt-dlp ${label} failed: ${stderr.trim()}`);
    }

    return stderr;
}

function parseProgressLine(line: string, onProgress?: DownloadAudioOpts["onProgress"]): void {
    const downloadMatch = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);

    if (downloadMatch) {
        onProgress?.({ phase: "download", percent: Number.parseFloat(downloadMatch[1]), message: line.trim() });
    }

    if (line.includes("[ExtractAudio]")) {
        onProgress?.({ phase: "postprocess", message: line.trim() });
    }

    if (line.includes("[Merger]")) {
        onProgress?.({ phase: "merge", message: line.trim() });
    }
}

async function streamProgress(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        buf += decoder.decode(value, { stream: true });
        let idx = buf.indexOf("\n");

        while (idx !== -1) {
            onLine(buf.slice(0, idx));
            buf = buf.slice(idx + 1);
            idx = buf.indexOf("\n");
        }
    }

    if (buf.length) {
        onLine(buf);
    }
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
