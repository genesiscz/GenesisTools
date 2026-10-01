import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { convertFileToMonoMp3 } from "@genesiscz/utils/audio/converter";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

import {
    contentTypeIsMedia,
    extensionOf,
    isAudioExtension,
    isHls,
    isMediaExtension,
    pickMp4Variant,
    type RemoteSource,
    xDurationSec,
    xSyndicationUrl,
} from "./drivers.ts";
import { readMediaCache, writeMediaCache } from "./media-cache.ts";

const { log } = logger.scoped("transcribe");

const USER_AGENT = "GenesisTools transcribe/1.0";
/** A 38-minute 256 kbps MP4 is ~70 MB. Refuse a rendition that would fill the disk. */
const MAX_BYTES = 512 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
/** An HLS playlist is transcoded straight from the network; a live one never ends, so it gets a deadline. */
const HLS_CONVERT_TIMEOUT_MS = 15 * 60 * 1000;

export type MediaConvert = (inputPath: string, outputPath: string, options?: { timeoutMs?: number }) => Promise<string>;

export interface AcquiredAudio {
    audioPath: string;
    driver: RemoteSource["driver"];
    sourceUrl: string;
    mediaUrl: string;
    /** True when the audio came from the one-hour convert cache. */
    cached: boolean;
    cleanup: () => Promise<void>;
}

/** The callable part of `fetch`. Tests do not have to fake `preconnect`. */
export type MediaFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface AcquireDeps {
    fetch?: MediaFetch;
    convert?: MediaConvert;
    /** Test seam. Production uses the OS temp dir. */
    dir?: string;
    /** Keep the converted audio here for one hour. */
    cacheDir?: string;
    /** Override the cache identity. Defaults to the post id or the direct URL. */
    cacheKey?: string;
    now?: () => number;
}

export function remoteCacheKey(source: RemoteSource): string {
    return source.driver === "x" ? `x:${source.statusId}` : `direct:${source.url}`;
}

/** Duration from the post's JSON. Does not download the video. */
export async function fetchXDurationSec(statusId: string, fetchImpl: MediaFetch = fetch): Promise<number> {
    const response = await fetchImpl(xSyndicationUrl(statusId), {
        headers: { accept: "application/json", "user-agent": USER_AGENT },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();

    if (!response.ok) {
        throw new Error(`X post ${statusId} could not be read (syndication HTTP ${response.status}).`);
    }

    let payload: unknown;

    try {
        payload = SafeJSON.parse(body);
    } catch (error) {
        log.warn({ error, statusId }, "x syndication was not json");
        throw new Error(`X post ${statusId} could not be read (syndication did not return JSON).`);
    }

    const seconds = xDurationSec(payload);

    if (seconds === null) {
        throw new Error(`X post ${statusId} has no video duration.`);
    }

    return seconds;
}

export async function acquireRemoteAudio(source: RemoteSource, deps: AcquireDeps = {}): Promise<AcquiredAudio> {
    const fetchImpl = deps.fetch ?? fetch;
    const convert = deps.convert ?? convertFileToMonoMp3;
    const cacheKey = deps.cacheKey ?? remoteCacheKey(source);
    const now = deps.now?.() ?? Date.now();

    if (deps.cacheDir) {
        const hit = await readMediaCache(deps.cacheDir, cacheKey, now);

        if (hit) {
            log.info({ driver: source.driver, cacheKey }, "reusing converted audio");

            return {
                audioPath: hit,
                driver: source.driver,
                sourceUrl: source.url,
                mediaUrl: source.url,
                cached: true,
                cleanup: async () => {},
            };
        }
    }

    const dir = deps.dir ?? (await mkdtemp(join(tmpdir(), "transcribe-url-")));
    const cleanup = async (): Promise<void> => {
        await rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
            log.debug({ error, dir }, "transcribe temp cleanup failed");
        });
    };

    // runTranscription calls process.exit on failure, which skips a caller's finally.
    process.once("exit", () => {
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch (error) {
            log.debug({ error, dir }, "transcribe temp cleanup failed");
        }
    });

    try {
        const mediaUrl = source.driver === "x" ? await resolveXMedia(source.statusId, fetchImpl) : source.url;
        log.info({ driver: source.driver, mediaHost: safeHost(mediaUrl) }, "remote media resolved");
        const produced = await materializeAudio(mediaUrl, dir, fetchImpl, convert);
        const audioPath = deps.cacheDir ? await writeMediaCache(deps.cacheDir, cacheKey, produced, now) : produced;

        if (deps.cacheDir) {
            await cleanup();
        }

        return {
            audioPath,
            driver: source.driver,
            sourceUrl: source.url,
            mediaUrl,
            cached: false,
            cleanup: deps.cacheDir ? async () => {} : cleanup,
        };
    } catch (error) {
        await cleanup();
        throw error;
    }
}

async function resolveXMedia(statusId: string, fetchImpl: MediaFetch): Promise<string> {
    const endpoint = xSyndicationUrl(statusId);
    const response = await fetchImpl(endpoint, {
        headers: { accept: "application/json", "user-agent": USER_AGENT },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();

    if (!response.ok) {
        log.warn({ status: response.status, bytes: body.length, statusId }, "x syndication failed");
        throw new Error(`X post ${statusId} could not be read (syndication HTTP ${response.status}).`);
    }

    let payload: unknown;

    try {
        payload = SafeJSON.parse(body);
    } catch (error) {
        log.warn({ error, status: response.status, statusId }, "x syndication was not json");
        throw new Error(`X post ${statusId} could not be read (syndication did not return JSON).`);
    }

    const variant = pickMp4Variant(payload);

    if (!variant) {
        throw new Error(`X post ${statusId} has no video.`);
    }

    log.info({ statusId, bitrate: variant.bitrate }, "picked x mp4 variant");

    return variant.url;
}

async function materializeAudio(
    mediaUrl: string,
    dir: string,
    fetchImpl: MediaFetch,
    convert: MediaConvert
): Promise<string> {
    const output = join(dir, "audio.mp3");

    if (isHls(mediaUrl)) {
        try {
            return await convert(mediaUrl, output, { timeoutMs: HLS_CONVERT_TIMEOUT_MS });
        } catch (error) {
            log.warn({ error, mediaHost: safeHost(mediaUrl) }, "hls transcode failed");
            throw new Error(
                `The HLS stream from ${safeHost(mediaUrl)} did not convert within ${HLS_CONVERT_TIMEOUT_MS / 60_000} minutes or failed. Live streams are not supported.`,
                { cause: error }
            );
        }
    }

    const ext = extensionOf(mediaUrl);
    const knownMedia = isMediaExtension(ext);
    const saved = join(dir, `source${knownMedia ? ext : ""}`);
    await downloadMedia(mediaUrl, saved, fetchImpl, knownMedia);
    const savedExt = extname(saved).toLowerCase();

    if (isAudioExtension(savedExt)) {
        return saved;
    }

    return convert(saved, output);
}

async function downloadMedia(url: string, dest: string, fetchImpl: MediaFetch, knownMedia: boolean): Promise<void> {
    const response = await fetchImpl(url, {
        headers: { accept: "*/*", "user-agent": USER_AGENT },
        redirect: "follow",
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });

    if (!response.ok) {
        throw new Error(`Download failed (HTTP ${response.status}) for ${safeHost(url)}.`);
    }

    const type = response.headers.get("content-type");

    if (!knownMedia && !contentTypeIsMedia(type)) {
        await response.body?.cancel().catch((error: unknown) => {
            log.debug({ error }, "cancel of non-media response failed");
        });
        throw new Error(
            `That URL is not a video or audio file (${type ?? "no content-type"}). ` +
                "The direct driver accepts a media URL. A YouTube or X page needs its own driver, and an ordinary web page is not supported."
        );
    }

    const declared = Number(response.headers.get("content-length") ?? "0");

    if (Number.isFinite(declared) && declared > MAX_BYTES) {
        await response.body?.cancel().catch((error: unknown) => {
            log.debug({ error }, "cancel of oversized response failed");
        });
        throw new Error(`Remote file is ${declared} bytes, over the ${MAX_BYTES} byte cap.`);
    }

    const body = response.body;

    if (!body) {
        throw new Error(`Download of ${safeHost(url)} returned an empty body.`);
    }

    // Each chunk goes straight to disk, so the peak memory is one chunk, not the whole file twice.
    // A partial file stays in the temp dir, which the caller's cleanup removes.
    const reader = body.getReader();
    const writer = Bun.file(dest).writer();
    let total = 0;

    try {
        while (true) {
            const step = await reader.read();

            if (step.done) {
                break;
            }

            if (!step.value) {
                continue;
            }

            total += step.value.byteLength;

            if (total > MAX_BYTES) {
                await reader.cancel().catch((error: unknown) => {
                    log.debug({ error }, "cancel of oversized stream failed");
                });
                throw new Error(`Remote file exceeded ${MAX_BYTES} bytes.`);
            }

            writer.write(step.value);
            await writer.flush();
        }
    } finally {
        await writer.end();
    }
}

function safeHost(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return "unknown-host";
    }
}
