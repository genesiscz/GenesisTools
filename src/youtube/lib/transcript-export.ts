import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { ChannelHandle } from "@app/youtube/lib/channel.types";
import type { YoutubeDatabase } from "@app/youtube/lib/db";
import type { Transcript, TranscriptSegment } from "@app/youtube/lib/transcript.types";
import type { VideoId } from "@app/youtube/lib/video.types";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

export type TranscriptExportFormat = "md" | "json" | "txt" | "srt" | "vtt";

/** The video fields an export carries; a `Video` row satisfies it structurally. */
export interface ExportVideoMeta {
    id: string;
    title: string;
    channelHandle: string;
    uploadDate: string | null;
    durationSec: number | null;
}

export interface TranscriptExportJson {
    videoId: string;
    title: string;
    channel: string;
    url: string;
    uploadDate: string | null;
    durationSec: number | null;
    lang: string;
    source: string;
    text: string;
    segments: TranscriptSegment[];
    exportedAt: string;
}

export interface ExportTranscriptsOpts {
    db: YoutubeDatabase;
    videoIds: VideoId[];
    dir: string;
    format: TranscriptExportFormat;
    /** Rewrite files that already exist. Default false — existing files are skipped. */
    overwrite?: boolean;
}

export interface ExportedTranscript {
    videoId: string;
    path: string;
    bytes: number;
}

export interface ExportTranscriptsResult {
    written: ExportedTranscript[];
    /** Videos that produced no file, with the reason (`no-transcript` / `exists`). */
    skipped: Array<{ videoId: string; reason: string }>;
    dir: string;
}

export interface ImportTranscriptDirResult {
    imported: Array<{ videoId: string; file: string; segments: number }>;
    skipped: Array<{ file: string; reason: string }>;
    dir: string;
}

/** `h:mm:ss` past an hour, `mm:ss` below it — the form used in markdown exports and citations. */
export function formatClock(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);

    return hours > 0 ? `${hours}:${mm}:${String(secs).padStart(2, "0")}` : `${mm}:${String(secs).padStart(2, "0")}`;
}

/** Inverse of `formatClock` — accepts `ss`, `mm:ss`, and `h:mm:ss`. */
export function parseClock(value: string): number | null {
    const raw = value.split(":");

    // Every component must be digits end to end. `Number.parseInt` stops at the first
    // non-digit, so a corrupt export like `1x:02` would otherwise import as 62s.
    if (!raw.every((part) => /^\d+$/.test(part))) {
        return null;
    }

    const parts = raw.map((part) => Number.parseInt(part, 10));

    if (parts.some((part) => !Number.isFinite(part))) {
        return null;
    }

    if (parts.length === 1) {
        return parts[0];
    }

    if (parts.length === 2) {
        return parts[0] * 60 + parts[1];
    }

    if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }

    return null;
}

/** Watch URL, optionally deep-linked to a second offset (`&t=123s`). */
export function videoUrl(videoId: string, atSec?: number | null): string {
    const base = `https://www.youtube.com/watch?v=${videoId}`;

    return atSec === null || atSec === undefined ? base : `${base}&t=${Math.max(0, Math.floor(atSec))}s`;
}

export function transcriptToExportJson(video: ExportVideoMeta, transcript: Transcript): TranscriptExportJson {
    return {
        videoId: video.id,
        title: video.title,
        channel: video.channelHandle,
        url: videoUrl(video.id),
        uploadDate: video.uploadDate,
        durationSec: video.durationSec ?? transcript.durationSec ?? null,
        lang: transcript.lang,
        source: transcript.source,
        text: transcript.text,
        segments: transcript.segments,
        exportedAt: new Date().toISOString(),
    };
}

/**
 * Human-readable export: YAML-ish frontmatter followed by `[mm:ss] text` lines.
 * Segment END times are NOT written — re-importing infers each end from the
 * next segment's start (and the last from `durationSec`). Use the `json`
 * format when exact round-tripping matters.
 */
export function renderTranscriptMarkdown(video: ExportVideoMeta, transcript: Transcript): string {
    const meta = transcriptToExportJson(video, transcript);
    const frontmatter = [
        "---",
        `videoId: ${meta.videoId}`,
        `title: ${quoteYaml(meta.title)}`,
        `channel: ${meta.channel}`,
        `url: ${meta.url}`,
        `uploadDate: ${meta.uploadDate ?? ""}`,
        `durationSec: ${meta.durationSec ?? ""}`,
        `lang: ${meta.lang}`,
        `source: ${meta.source}`,
        `segments: ${meta.segments.length}`,
        `exportedAt: ${meta.exportedAt}`,
        "---",
    ].join("\n");
    const body = meta.segments.length
        ? meta.segments.map((segment) => `[${formatClock(segment.start)}] ${segment.text}`).join("\n")
        : meta.text;

    return `${frontmatter}\n\n# ${meta.title}\n\n${body}\n`;
}

export function renderTranscriptSrt(segments: TranscriptSegment[]): string {
    return segments
        .map(
            (segment, index) => `${index + 1}\n${srtClock(segment.start)} --> ${srtClock(segment.end)}\n${segment.text}`
        )
        .join("\n\n");
}

export function renderTranscriptVtt(segments: TranscriptSegment[]): string {
    const cues = segments
        .map(
            (segment) =>
                `${srtClock(segment.start).replace(",", ".")} --> ${srtClock(segment.end).replace(",", ".")}\n${segment.text}`
        )
        .join("\n\n");

    return `WEBVTT\n\n${cues}`;
}

export function renderTranscript(
    video: ExportVideoMeta,
    transcript: Transcript,
    format: TranscriptExportFormat
): string {
    switch (format) {
        case "md":
            return renderTranscriptMarkdown(video, transcript);
        case "json":
            return `${SafeJSON.stringify(transcriptToExportJson(video, transcript), null, 2)}\n`;
        case "txt":
            return `${transcript.text}\n`;
        case "srt":
            return `${renderTranscriptSrt(transcript.segments)}\n`;
        case "vtt":
            return `${renderTranscriptVtt(transcript.segments)}\n`;
    }
}

export async function exportTranscripts(opts: ExportTranscriptsOpts): Promise<ExportTranscriptsResult> {
    if (!existsSync(opts.dir)) {
        mkdirSync(opts.dir, { recursive: true });
    }

    const written: ExportedTranscript[] = [];
    const skipped: ExportTranscriptsResult["skipped"] = [];

    for (const videoId of opts.videoIds) {
        const transcript = opts.db.getTranscript(videoId);

        if (!transcript) {
            skipped.push({ videoId, reason: "no-transcript" });
            continue;
        }

        const video = opts.db.getVideo(videoId);

        if (!video) {
            skipped.push({ videoId, reason: "no-video-row" });
            continue;
        }

        const path = join(opts.dir, `${videoId}.${opts.format}`);

        if (!opts.overwrite && existsSync(path)) {
            skipped.push({ videoId, reason: "exists" });
            continue;
        }

        const content = renderTranscript(video, transcript, opts.format);
        await Bun.write(path, content);
        written.push({ videoId, path, bytes: Buffer.byteLength(content) });
    }

    logger.info(
        { dir: opts.dir, format: opts.format, written: written.length, skipped: skipped.length },
        "youtube transcripts exported"
    );

    return { written, skipped, dir: opts.dir };
}

/**
 * Reads `.md` / `.json` transcript exports back into the database (channel,
 * video and transcript rows), so a directory of previously exported files can
 * be asked over with the very same retrieval path as freshly fetched captions.
 */
export async function importTranscriptDir(opts: {
    db: YoutubeDatabase;
    dir: string;
}): Promise<ImportTranscriptDirResult> {
    if (!existsSync(opts.dir)) {
        throw new Error(`transcript import: directory not found: ${opts.dir}`);
    }

    const imported: ImportTranscriptDirResult["imported"] = [];
    const skipped: ImportTranscriptDirResult["skipped"] = [];

    for (const entry of readdirSync(opts.dir).sort()) {
        const ext = extname(entry).toLowerCase();

        if (ext !== ".md" && ext !== ".json") {
            continue;
        }

        const path = join(opts.dir, entry);
        const raw = await Bun.file(path).text();

        try {
            const parsed = ext === ".json" ? parseExportJson(raw) : parseExportMarkdown(raw, basename(entry, ext));

            if (!parsed) {
                skipped.push({ file: entry, reason: "unrecognised format" });
                continue;
            }

            opts.db.upsertChannel({ handle: parsed.channel as ChannelHandle });
            opts.db.upsertVideo({
                id: parsed.videoId,
                channelHandle: parsed.channel as ChannelHandle,
                title: parsed.title,
                uploadDate: parsed.uploadDate,
                durationSec: parsed.durationSec,
            });
            opts.db.saveTranscript({
                videoId: parsed.videoId as VideoId,
                lang: parsed.lang,
                source: parsed.source === "ai" ? "ai" : "captions",
                text: parsed.text,
                segments: parsed.segments,
                durationSec: parsed.durationSec,
            });
            imported.push({ videoId: parsed.videoId, file: entry, segments: parsed.segments.length });
        } catch (error) {
            logger.warn({ file: path, err: error }, "youtube transcript import: file failed");
            skipped.push({ file: entry, reason: error instanceof Error ? error.message : String(error) });
        }
    }

    logger.info(
        { dir: opts.dir, imported: imported.length, skipped: skipped.length },
        "youtube transcripts imported from directory"
    );

    return { imported, skipped, dir: opts.dir };
}

interface ParsedExport {
    videoId: string;
    title: string;
    channel: string;
    uploadDate: string | null;
    durationSec: number | null;
    lang: string;
    source: string;
    text: string;
    segments: TranscriptSegment[];
}

export function parseExportJson(raw: string): ParsedExport | null {
    const parsed = SafeJSON.parse(raw, { unbox: true }) as Partial<TranscriptExportJson> | undefined;

    if (!parsed || typeof parsed.videoId !== "string" || typeof parsed.text !== "string") {
        return null;
    }

    return {
        videoId: parsed.videoId,
        title: typeof parsed.title === "string" ? parsed.title : parsed.videoId,
        channel: typeof parsed.channel === "string" ? parsed.channel : "@unknown",
        uploadDate: typeof parsed.uploadDate === "string" ? parsed.uploadDate : null,
        durationSec: typeof parsed.durationSec === "number" ? parsed.durationSec : null,
        lang: typeof parsed.lang === "string" ? parsed.lang : "en",
        source: typeof parsed.source === "string" ? parsed.source : "captions",
        text: parsed.text,
        segments: parseSegments(parsed.segments),
    };
}

/**
 * Keeps only the entries that really are segments.
 *
 * `Array.isArray` proved the container and nothing about the contents, so
 * `segments: [null]` or a string `start` went through `saveTranscript` untouched and
 * surfaced much later as broken chunking, indexing or rendering — with no trace back
 * to the import that wrote it. Dropping bad entries rather than rejecting the file
 * keeps a mostly-good export usable, and the count is logged so a silently thinned
 * import is still visible.
 */
function parseSegments(value: unknown): TranscriptSegment[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const segments = value.filter(isTranscriptSegment);

    if (segments.length !== value.length) {
        logger.warn(
            { received: value.length, kept: segments.length },
            "youtube transcript import dropped malformed segments"
        );
    }

    return segments;
}

function isTranscriptSegment(value: unknown): value is TranscriptSegment {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const segment = value as Record<string, unknown>;

    if (typeof segment.text !== "string") {
        return false;
    }

    if (!isFiniteNumber(segment.start) || !isFiniteNumber(segment.end)) {
        return false;
    }

    // Negative or reversed ranges are the ones that bite downstream: chunking slices
    // on [start, end] and a reversed pair yields an empty or negative-length window.
    if (segment.start < 0 || segment.end < segment.start) {
        return false;
    }

    return segment.speaker === undefined || isFiniteNumber(segment.speaker);
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

export function parseExportMarkdown(raw: string, fallbackVideoId: string): ParsedExport | null {
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
    const frontmatter = new Map<string, string>();
    const body = match ? match[2] : raw;

    if (match) {
        for (const line of match[1].split("\n")) {
            const idx = line.indexOf(":");

            if (idx === -1) {
                continue;
            }

            frontmatter.set(line.slice(0, idx).trim(), unquoteYaml(line.slice(idx + 1).trim()));
        }
    }

    const durationRaw = frontmatter.get("durationSec");
    const durationSec = durationRaw ? Number.parseFloat(durationRaw) : Number.NaN;
    const timed: Array<{ start: number; text: string }> = [];
    const plain: string[] = [];

    for (const line of body.split("\n")) {
        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith("# ")) {
            continue;
        }

        const stamped = /^\[(\d+(?::\d+){0,2})\]\s*(.*)$/.exec(trimmed);

        if (!stamped) {
            plain.push(trimmed);
            continue;
        }

        const start = parseClock(stamped[1]);

        if (start === null) {
            plain.push(trimmed);
            continue;
        }

        timed.push({ start, text: stamped[2] });
    }

    if (timed.length === 0 && plain.length === 0) {
        return null;
    }

    const duration = Number.isFinite(durationSec) ? durationSec : null;
    // Markdown carries starts only — each end is the next start, and the final
    // end falls back to the declared duration (or its own start).
    const segments: TranscriptSegment[] = timed.map((entry, index) => ({
        text: entry.text,
        start: entry.start,
        end: timed[index + 1]?.start ?? duration ?? entry.start,
    }));

    return {
        videoId: frontmatter.get("videoId") || fallbackVideoId,
        title: frontmatter.get("title") || fallbackVideoId,
        channel: frontmatter.get("channel") || "@unknown",
        uploadDate: frontmatter.get("uploadDate") || null,
        durationSec: duration,
        lang: frontmatter.get("lang") || "en",
        source: frontmatter.get("source") || "captions",
        text: (timed.length ? timed.map((entry) => entry.text) : plain).join(" "),
        segments,
    };
}

function srtClock(seconds: number): string {
    const totalMs = Math.round(Math.max(0, seconds) * 1000);
    const hours = Math.floor(totalMs / 3_600_000);
    const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
    const secs = Math.floor((totalMs % 60_000) / 1000);
    const ms = totalMs % 1000;

    return `${pad2(hours)}:${pad2(minutes)}:${pad2(secs)},${String(ms).padStart(3, "0")}`;
}

function pad2(value: number): string {
    return String(value).padStart(2, "0");
}

function quoteYaml(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function unquoteYaml(value: string): string {
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }

    return value;
}
