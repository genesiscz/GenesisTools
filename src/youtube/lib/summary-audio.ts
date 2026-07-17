import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { getTextToSpeechProvider } from "@app/utils/ai/providers";
import type { AITextToSpeechProvider } from "@app/utils/ai/types";
import { Storage } from "@app/utils/storage/storage";
import { deleteIfExists, ensureBinaryDir } from "@app/youtube/lib/cache";
import type { YoutubeDatabase } from "@app/youtube/lib/db";
import { recordYoutubeUsage } from "@app/youtube/lib/usage";
import type { SummaryMode, VideoId, VideoLongSummary } from "@app/youtube/lib/video.types";

export class NoSummaryError extends Error {
    constructor(videoId: VideoId) {
        super(`no long summary for video ${videoId}; generate a summary first`);
        this.name = "NoSummaryError";
    }
}

export class NoTtsProviderError extends Error {
    constructor() {
        super("no TTS provider configured");
        this.name = "NoTtsProviderError";
    }
}

/**
 * Turns a structured long summary into plain narration prose — a TEMPLATE,
 * never an LLM call. TL;DR first, then key points and learnings read
 * naturally, then each chapter as a spoken section break ("Chapter: <title>.
 * <chapter summary>"), then the closing verdict. Markdown/citation markers
 * are stripped; missing/empty sections are skipped without leaving artifacts.
 */
export function buildNarrationScript(summary: VideoLongSummary, _mode: SummaryMode): string {
    const parts: string[] = [];

    if (summary.tldr.trim()) {
        parts.push(stripMarkdown(summary.tldr));
    }

    if (summary.keyPoints.length > 0) {
        parts.push(`Key points. ${summary.keyPoints.map(stripMarkdown).join(". ")}.`);
    }

    if (summary.learnings.length > 0) {
        parts.push(`What you should take away. ${summary.learnings.map(stripMarkdown).join(". ")}.`);
    }

    for (const chapter of summary.chapters) {
        const title = stripMarkdown(chapter.title);
        const chapterSummary = stripMarkdown(chapter.summary);
        parts.push(chapterSummary ? `Chapter: ${title}. ${chapterSummary}` : `Chapter: ${title}.`);
    }

    if (summary.conclusion?.trim()) {
        parts.push(stripMarkdown(summary.conclusion));
    }

    return parts.join(" ").trim();
}

/** Strips markdown emphasis/heading markers, `[#N]` citation markers, and turns `[text](url)` links into plain text. */
function stripMarkdown(text: string): string {
    return text
        .replace(/\[#\d+\]/g, "")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[*_`#]+/g, "")
        .replace(/\s+([.,!?])/g, "$1")
        .replace(/\s+/g, " ")
        .trim();
}

export function summaryAudioDir(): string {
    return join(new Storage("youtube").getBaseDir(), "audio");
}

export function summaryAudioCacheKey(script: string, voice: string, providerId: string): string {
    return createHash("sha256").update(`${script}\u0000${voice}\u0000${providerId}`).digest("hex").slice(0, 20);
}

export function summaryAudioFilePath(videoId: VideoId, hash: string): string {
    return join(summaryAudioDir(), `${videoId}-${hash}.mp3`);
}

interface ResolvedTtsProvider {
    provider: AITextToSpeechProvider;
    providerId: "xai" | "openai";
}

/** xAI realtime TTS first, OpenAI TTS fallback — never the task-based auto-selector (its fallback list omits both TTS providers). */
async function resolveTtsProvider(): Promise<ResolvedTtsProvider | null> {
    const xai = getTextToSpeechProvider("xai");

    if (await xai.isAvailable()) {
        return { provider: xai, providerId: "xai" };
    }

    const openai = getTextToSpeechProvider("openai");

    if (await openai.isAvailable()) {
        return { provider: openai, providerId: "openai" };
    }

    return null;
}

export interface SummaryAudioTarget {
    script: string;
    voice: string;
    providerId: "xai" | "openai";
    provider: AITextToSpeechProvider;
    path: string;
}

/**
 * Resolves everything needed to serve or synthesize a summary's audio
 * (provider, narration script, cache path) without touching disk or the
 * network — cheap enough for a route's pre-charge cache-hit check. Throws
 * `NoSummaryError` / `NoTtsProviderError` for the two "can't proceed" cases.
 */
export async function resolveSummaryAudioTarget(opts: {
    db: YoutubeDatabase;
    videoId: VideoId;
    mode: SummaryMode;
    voice?: string;
}): Promise<SummaryAudioTarget> {
    const video = opts.db.getVideo(opts.videoId);

    if (!video?.summaryLong) {
        throw new NoSummaryError(opts.videoId);
    }

    const resolved = await resolveTtsProvider();

    if (!resolved) {
        throw new NoTtsProviderError();
    }

    const script = buildNarrationScript(video.summaryLong, opts.mode);
    const voice = opts.voice ?? "";
    const hash = summaryAudioCacheKey(script, voice, resolved.providerId);
    const path = summaryAudioFilePath(opts.videoId, hash);

    return { script, voice, providerId: resolved.providerId, provider: resolved.provider, path };
}

export async function summaryAudioCacheHit(target: SummaryAudioTarget): Promise<boolean> {
    return Bun.file(target.path).exists();
}

/**
 * Cache hit → returns the existing path (free). Cache miss → synthesizes via
 * the resolved provider, writes the file, prunes stale `<videoId>-*` files,
 * and records usage. Callers charge credits only when `cached` comes back
 * `false` — this function never charges, it only spends the provider call.
 */
export async function getOrSynthesizeSummaryAudio(opts: {
    db: YoutubeDatabase;
    videoId: VideoId;
    mode: SummaryMode;
    voice?: string;
    userId: number;
}): Promise<{ path: string; cached: boolean; contentType: string }> {
    const target = await resolveSummaryAudioTarget(opts);

    if (await summaryAudioCacheHit(target)) {
        return { path: target.path, cached: true, contentType: "audio/mpeg" };
    }

    const result = await target.provider.synthesize(target.script, target.voice ? { voice: target.voice } : undefined);
    ensureBinaryDir(target.path);
    await Bun.write(target.path, result.audio);
    await recordYoutubeUsage({
        action: "tts:summary",
        provider: target.providerId,
        model: "(tts-default)",
        scope: opts.videoId,
        videoId: opts.videoId,
    });
    await pruneStaleSummaryAudio(opts.videoId, target.path);

    return { path: target.path, cached: false, contentType: result.contentType };
}

async function pruneStaleSummaryAudio(videoId: VideoId, keepPath: string): Promise<void> {
    const dir = summaryAudioDir();
    let entries: string[];

    try {
        entries = readdirSync(dir);
    } catch {
        return;
    }

    const prefix = `${videoId}-`;

    for (const entry of entries) {
        if (!entry.startsWith(prefix) || !entry.endsWith(".mp3")) {
            continue;
        }

        const full = join(dir, entry);

        if (full === keepPath) {
            continue;
        }

        await deleteIfExists(full);
    }
}
