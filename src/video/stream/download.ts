import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { abortableSleep, retry } from "@genesiscz/utils/async";
import {
    deriveSegmentTemplate,
    type HlsMediaPlaylist,
    type SegmentUriTemplate,
    segmentUri,
} from "@genesiscz/utils/hls/playlist";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";
import {
    fetchPlaylist,
    PlaylistHttpError,
    type ResolvedMedia,
    resolveMedia,
    type StreamSource,
    safeUrl,
} from "./source";

const SEGMENT_TIMEOUT_MS = 120_000;
const SEGMENT_ATTEMPTS = 4;
/** Consecutive 404/410 answers for the playlist that mean the stream is over. */
const GONE_POLLS = 3;
const SEGMENT_FILE = /^seg-(\d+)\.[a-z0-9]+$/i;

const stateSchema = z.object({
    version: z.literal(1),
    source: z.object({
        playlistUrl: z.string(),
        headers: z.record(z.string(), z.string()),
        page: z.string().optional(),
    }),
    mediaUrl: z.string(),
    /** How segment URIs are named, kept so a resume can fetch gaps after the playlist itself is gone. */
    template: z.object({ prefix: z.string(), suffix: z.string(), width: z.number() }).nullable().optional(),
    /** Sequence numbers the CDN answered 404 or 410 for in the last run. A resume asks for them once more. */
    gone: z.array(z.number()),
    ended: z.boolean(),
    updatedAt: z.string(),
});

export type StreamState = z.infer<typeof stateSchema>;

export interface StreamProgress {
    phase: "probing" | "downloading" | "waiting" | "retrying" | "stitching";
    downloaded: number;
    queued: number;
    gone: number;
    bytes: number;
    newestSequence: number | null;
}

export interface StreamDownloadResult {
    /** Null when the run stopped before stitching (Ctrl-C, or nothing downloaded). */
    output: string | null;
    partsDir: string;
    segments: number;
    firstSequence: number | null;
    lastSequence: number | null;
    /** Sequence numbers between the first and the last segment that are not on disk. */
    gaps: number[];
    downloadedThisRun: number;
    bytesThisRun: number;
    ended: boolean;
    aborted: boolean;
}

class SegmentHttpError extends Error {
    constructor(readonly status: number) {
        super(`HTTP ${status}`);
        this.name = "SegmentHttpError";
    }
}

function isGoneStatus(status: number): boolean {
    return status === 404 || status === 410;
}

export function partsDirFor(output: string): string {
    return `${output}.parts`;
}

function segmentPath({ partsDir, sequence, uri }: { partsDir: string; sequence: number; uri: string }): string {
    const ext = extname(new URL(uri).pathname).toLowerCase() || ".ts";
    return join(partsDir, `seg-${String(sequence).padStart(10, "0")}${ext}`);
}

export async function readState(partsDir: string): Promise<StreamState | null> {
    const path = join(partsDir, "state.json");

    if (!existsSync(path)) {
        return null;
    }

    const parsed = stateSchema.safeParse(SafeJSON.parse(await readFile(path, "utf8"), { strict: true }));

    if (!parsed.success) {
        throw new Error(`${path} is not a stream state this version reads: ${parsed.error.issues[0]?.message}`);
    }

    return parsed.data;
}

/** The state holds the request headers (cookies included), so only the owner may read it. */
async function writeState(partsDir: string, state: StreamState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    await writeFile(join(partsDir, "state.json"), SafeJSON.stringify(state, null, 2), { mode: 0o600 });
}

async function segmentsOnDisk(partsDir: string): Promise<Map<number, string>> {
    const found = new Map<number, string>();

    for (const name of await readdir(partsDir)) {
        const match = SEGMENT_FILE.exec(name);

        if (match) {
            found.set(Number(match[1]), join(partsDir, name));
        }
    }

    return found;
}

/** Wanted segments by sequence number. Workers take the oldest or the newest; `next` waits until one is added. */
class SegmentQueue {
    private readonly wanted = new Map<number, string>();
    private wakers: (() => void)[] = [];
    private closed = false;

    get size(): number {
        return this.wanted.size;
    }

    add(sequence: number, uri: string): void {
        if (this.closed) {
            return;
        }

        this.wanted.set(sequence, uri);
        this.wake();
    }

    close(): void {
        this.closed = true;
        this.wake();
    }

    async next(newestFirst: boolean): Promise<{ sequence: number; uri: string } | null> {
        while (true) {
            if (this.wanted.size > 0) {
                let pick: number | null = null;

                for (const sequence of this.wanted.keys()) {
                    if (pick === null || (newestFirst ? sequence > pick : sequence < pick)) {
                        pick = sequence;
                    }
                }

                const sequence = pick ?? 0;
                const uri = this.wanted.get(sequence) ?? "";
                this.wanted.delete(sequence);
                return { sequence, uri };
            }

            if (this.closed) {
                return null;
            }

            await new Promise<void>((resolve) => this.wakers.push(resolve));
        }
    }

    private wake(): void {
        const wakers = this.wakers;
        this.wakers = [];

        for (const waker of wakers) {
            waker();
        }
    }
}

async function downloadToFile({
    url,
    headers,
    path,
    signal,
}: {
    url: string;
    headers: Record<string, string>;
    path: string;
    signal: AbortSignal;
}): Promise<number> {
    const response = await fetch(url, {
        headers,
        signal: AbortSignal.any([signal, AbortSignal.timeout(SEGMENT_TIMEOUT_MS)]),
    });

    if (!response.ok) {
        await response.body?.cancel();
        throw new SegmentHttpError(response.status);
    }

    const partial = `${path}.part`;
    const bytes = await Bun.write(partial, response);

    if (bytes === 0) {
        throw new Error("empty segment");
    }

    await rename(partial, path);
    return bytes;
}

async function segmentExists({
    url,
    headers,
    signal,
}: {
    url: string;
    headers: Record<string, string>;
    signal: AbortSignal;
}): Promise<boolean> {
    const response = await fetch(url, {
        headers: { ...headers, range: "bytes=0-0" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    await response.body?.cancel();

    if (response.ok) {
        return true;
    }

    if (isGoneStatus(response.status) || response.status === 403) {
        return false;
    }

    throw new SegmentHttpError(response.status);
}

/**
 * The oldest sequence number the CDN still serves, found by binary search below `below` (which exists). A live CDN
 * deletes the oldest segments first, so the served range is one contiguous run that ends at the live edge.
 */
async function findEarliestSegment({
    template,
    headers,
    below,
    signal,
}: {
    template: SegmentUriTemplate;
    headers: Record<string, string>;
    below: number;
    signal: AbortSignal;
}): Promise<number> {
    const exists = (sequence: number) => segmentExists({ url: segmentUri(template, sequence), headers, signal });

    if (below <= 0 || (await exists(0))) {
        return 0;
    }

    let missing = 0;
    let present = below;

    while (present - missing > 1) {
        const middle = Math.floor((missing + present) / 2);

        if (await exists(middle)) {
            present = middle;
        } else {
            missing = middle;
        }
    }

    return present;
}

/** Writes the segments in order: concatenated as they are for `.ts`, through `ffmpeg -c copy` for any other container. */
async function stitch({
    partsDir,
    output,
    signal,
}: {
    partsDir: string;
    output: string;
    signal: AbortSignal;
}): Promise<{ segments: number; first: number; last: number; gaps: number[] }> {
    const onDisk = await segmentsOnDisk(partsDir);
    const sequences = [...onDisk.keys()].sort((a, b) => a - b);

    if (sequences.length === 0) {
        throw new Error(`No segment in ${partsDir} to stitch`);
    }

    const first = sequences[0];
    const last = sequences[sequences.length - 1];
    const gaps: number[] = [];

    for (let sequence = first; sequence <= last; sequence++) {
        if (!onDisk.has(sequence)) {
            gaps.push(sequence);
        }
    }

    const init = (await readdir(partsDir)).find((name) => name.startsWith("init."));
    const files = [...(init ? [join(partsDir, init)] : []), ...sequences.map((sequence) => onDisk.get(sequence) ?? "")];
    const ext = extname(output);
    const staging = join(dirname(output), `${basename(output, ext)}.stitching${ext}`);
    const concatenate = ext.toLowerCase() === ".ts" && !init;
    logger.debug({ partsDir, output, segments: sequences.length, gaps: gaps.length, concatenate }, "Stitching stream");

    if (concatenate) {
        const writer = Bun.file(staging).writer();

        for (const file of files) {
            signal.throwIfAborted();
            writer.write(await Bun.file(file).bytes());
            await writer.flush();
        }

        await writer.end();
    } else {
        await remuxWithFfmpeg({ files, output: staging, signal });
    }

    await rename(staging, output);
    return { segments: sequences.length, first, last, gaps };
}

async function remuxWithFfmpeg({
    files,
    output,
    signal,
}: {
    files: string[];
    output: string;
    signal: AbortSignal;
}): Promise<void> {
    const command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", "pipe:0", "-c", "copy"];

    if (/\.(mp4|m4v|mov)$/i.test(output)) {
        command.push("-movflags", "+faststart");
    }

    command.push(output);
    logger.debug({ command }, "ffmpeg remux started");
    let proc: Bun.Subprocess<"pipe", "ignore", "pipe">;

    try {
        proc = Bun.spawn(command, { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
    } catch (error) {
        logger.warn({ error }, "ffmpeg did not start");
        throw new Error("ffmpeg is needed for this container (brew install ffmpeg), or pass an --out ending in .ts");
    }

    const stderr = new Response(proc.stderr).text();
    const kill = () => proc.kill();
    signal.addEventListener("abort", kill, { once: true });

    try {
        for (const file of files) {
            signal.throwIfAborted();
            proc.stdin.write(await Bun.file(file).bytes());
            await proc.stdin.flush();
        }

        await proc.stdin.end();
    } catch (error) {
        logger.warn({ error }, "Writing segments to ffmpeg failed");
    }

    const status = await proc.exited;
    signal.removeEventListener("abort", kill);
    signal.throwIfAborted();

    if (status !== 0) {
        const tail = (await stderr).slice(-2000);
        logger.warn({ status, stderr: tail }, "ffmpeg remux failed");
        throw new Error(`ffmpeg exited ${status}: ${tail.trim() || "no message"}`);
    }
}

export interface StreamDownloadOptions {
    output: string;
    /** Undefined on a resume: the state in the parts folder names it. */
    source?: StreamSource;
    quality: string;
    concurrency: number;
    idleTimeoutMs: number;
    backfill: boolean;
    stitchOnly: boolean;
    signal: AbortSignal;
    onProgress?: (progress: StreamProgress) => void;
}

function stitchedResult({
    output,
    partsDir,
    stitched,
    downloadedThisRun,
    bytesThisRun,
    ended,
}: {
    output: string;
    partsDir: string;
    stitched: { segments: number; first: number; last: number; gaps: number[] };
    downloadedThisRun: number;
    bytesThisRun: number;
    ended: boolean;
}): StreamDownloadResult {
    return {
        output,
        partsDir,
        segments: stitched.segments,
        firstSequence: stitched.first,
        lastSequence: stitched.last,
        gaps: stitched.gaps,
        downloadedThisRun,
        bytesThisRun,
        ended,
        aborted: false,
    };
}

export async function downloadStream(options: StreamDownloadOptions): Promise<StreamDownloadResult> {
    const { output, signal } = options;
    const partsDir = partsDirFor(output);
    await mkdir(partsDir, { recursive: true });
    const saved = await readState(partsDir);
    const source = options.source ?? saved?.source;
    const report = (phase: StreamProgress["phase"], extra: Partial<StreamProgress> = {}) =>
        options.onProgress?.({
            phase,
            downloaded: 0,
            queued: 0,
            gone: 0,
            bytes: 0,
            newestSequence: null,
            ...extra,
        });

    if (options.stitchOnly) {
        report("stitching");
        const stitched = await stitch({ partsDir, output, signal });
        return stitchedResult({
            output,
            partsDir,
            stitched,
            downloadedThisRun: 0,
            bytesThisRun: 0,
            ended: saved?.ended ?? false,
        });
    }

    if (!source) {
        throw new Error(`Nothing to resume in ${partsDir}: pass the HAR file or the playlist URL`);
    }

    let resolved: ResolvedMedia | null = null;

    try {
        resolved = await resolveMedia({ source, quality: options.quality, signal });
    } catch (error) {
        const goneWithParts =
            error instanceof PlaylistHttpError &&
            isGoneStatus(error.status) &&
            (await segmentsOnDisk(partsDir)).size > 0;

        if (!goneWithParts) {
            throw error;
        }

        logger.warn({ status: error.status }, "Playlist is gone; filling gaps from the saved template, then stitching");
    }

    if (saved && resolved && new URL(saved.mediaUrl).pathname !== new URL(resolved.mediaUrl).pathname) {
        throw new Error(
            `${partsDir} holds another stream (${safeUrl(saved.mediaUrl)}, now ${safeUrl(resolved.mediaUrl)}). Pass another --out, or the same --quality as before.`
        );
    }

    const playlist: HlsMediaPlaylist | null = resolved?.playlist ?? null;
    const template = playlist ? deriveSegmentTemplate(playlist.segments) : (saved?.template ?? null);
    const state: StreamState = {
        version: 1,
        source,
        mediaUrl: resolved?.mediaUrl ?? saved?.mediaUrl ?? source.playlistUrl,
        template,
        gone: [],
        ended: playlist === null,
        updatedAt: "",
    };
    await writeState(partsDir, state);

    const headers = source.headers;
    const done = new Set((await segmentsOnDisk(partsDir)).keys());
    const gone = new Set<number>();
    const failed = new Map<number, string>();
    const queue = new SegmentQueue();
    let newestSeen = -1;
    let downloadedThisRun = 0;
    let bytesThisRun = 0;
    let phase: StreamProgress["phase"] = "downloading";
    const progress = () =>
        report(phase, {
            downloaded: done.size,
            queued: queue.size,
            gone: gone.size,
            bytes: bytesThisRun,
            newestSequence: newestSeen >= 0 ? newestSeen : null,
        });
    const want = (sequence: number, uri: string) => {
        newestSeen = Math.max(newestSeen, sequence);

        if (!done.has(sequence)) {
            queue.add(sequence, uri);
        }
    };

    logger.debug(
        { template: template !== null, listed: playlist?.segments.length ?? null, onDisk: done.size },
        "Stream download planned"
    );

    if (!playlist && template && done.size > 0) {
        const sorted = [...done].sort((a, b) => a - b);

        for (let sequence = sorted[0]; sequence <= sorted[sorted.length - 1]; sequence++) {
            want(sequence, segmentUri(template, sequence));
        }
    }

    const firstListed = playlist?.segments[0]?.sequence;
    const playlistHasAll = playlist?.playlistType !== undefined || playlist?.mediaSequence === 0;

    if (playlist && options.backfill && template && firstListed !== undefined && !playlistHasAll) {
        report("probing");
        const earliest = await findEarliestSegment({ template, headers, below: firstListed, signal });
        logger.debug({ earliest, firstListed }, "Backfill range found");

        for (let sequence = earliest; sequence < firstListed; sequence++) {
            want(sequence, segmentUri(template, sequence));
        }
    }

    for (const segment of playlist?.segments ?? []) {
        want(segment.sequence, segment.uri);
    }

    if (playlist?.initUri) {
        const initPath = join(partsDir, `init${extname(new URL(playlist.initUri).pathname) || ".mp4"}`);

        if (!existsSync(initPath)) {
            await downloadToFile({ url: playlist.initUri, headers, path: initPath, signal });
        }
    }

    progress();

    const worker = async (newestFirst: boolean) => {
        while (true) {
            const item = await queue.next(newestFirst);

            if (!item || signal.aborted) {
                return;
            }

            const path = segmentPath({ partsDir, sequence: item.sequence, uri: item.uri });

            try {
                const bytes = await retry(() => downloadToFile({ url: item.uri, headers, path, signal }), {
                    maxAttempts: SEGMENT_ATTEMPTS,
                    delay: 1000,
                    shouldRetry: (error) =>
                        !signal.aborted && !(error instanceof SegmentHttpError && isGoneStatus(error.status)),
                });
                done.add(item.sequence);
                failed.delete(item.sequence);
                downloadedThisRun++;
                bytesThisRun += bytes;
            } catch (error) {
                if (signal.aborted) {
                    return;
                }

                if (error instanceof SegmentHttpError && isGoneStatus(error.status)) {
                    gone.add(item.sequence);
                } else {
                    failed.set(item.sequence, item.uri);
                    logger.warn({ error, sequence: item.sequence }, "Segment failed after retries");
                }
            }

            progress();
        }
    };

    const runWorkers = () =>
        Promise.all(Array.from({ length: options.concurrency }, (_, index) => worker(index % 2 === 1)));

    const onAbort = () => queue.close();
    signal.addEventListener("abort", onAbort, { once: true });
    const workers = runWorkers();
    let ended = playlist?.ended ?? true;

    if (!ended && playlist) {
        ended = await followLivePlaylist({
            mediaUrl: state.mediaUrl,
            headers,
            targetDurationSec: playlist.targetDurationSec,
            idleTimeoutMs: options.idleTimeoutMs,
            template,
            signal,
            want,
            newest: () => newestSeen,
            onPoll: (waiting) => {
                phase = waiting ? "waiting" : "downloading";
                progress();
            },
        });
    }

    queue.close();
    await workers;

    if (failed.size > 0 && !signal.aborted) {
        phase = "retrying";
        const retryQueue = [...failed.entries()];
        failed.clear();

        for (const [sequence, uri] of retryQueue) {
            const path = segmentPath({ partsDir, sequence, uri });

            try {
                bytesThisRun += await downloadToFile({ url: uri, headers, path, signal });
                done.add(sequence);
                downloadedThisRun++;
            } catch (error) {
                if (error instanceof SegmentHttpError && isGoneStatus(error.status)) {
                    gone.add(sequence);
                } else {
                    failed.set(sequence, uri);
                }
            }

            progress();
        }
    }

    signal.removeEventListener("abort", onAbort);
    state.gone = [...gone].sort((a, b) => a - b);
    state.ended = ended && !signal.aborted;
    await writeState(partsDir, state);
    logger.debug(
        { downloadedThisRun, bytesThisRun, gone: gone.size, failed: failed.size, ended, aborted: signal.aborted },
        "Stream download finished"
    );

    if (signal.aborted) {
        const onDisk = [...done].sort((a, b) => a - b);
        return {
            output: null,
            partsDir,
            segments: onDisk.length,
            firstSequence: onDisk[0] ?? null,
            lastSequence: onDisk[onDisk.length - 1] ?? null,
            gaps: [],
            downloadedThisRun,
            bytesThisRun,
            ended: false,
            aborted: true,
        };
    }

    phase = "stitching";
    progress();
    const stitched = await stitch({ partsDir, output, signal });
    return stitchedResult({ output, partsDir, stitched, downloadedThisRun, bytesThisRun, ended });
}

/**
 * Re-reads a live media playlist every target duration and hands each new segment to `want`, filling a jump past the
 * newest known segment from the template. Returns true when the stream ended (ENDLIST, or the playlist is gone) and
 * false when it went quiet for `idleTimeoutMs` or the run was cancelled.
 */
async function followLivePlaylist({
    mediaUrl,
    headers,
    targetDurationSec,
    idleTimeoutMs,
    template,
    signal,
    want,
    newest,
    onPoll,
}: {
    mediaUrl: string;
    headers: Record<string, string>;
    targetDurationSec: number;
    idleTimeoutMs: number;
    template: SegmentUriTemplate | null;
    signal: AbortSignal;
    want: (sequence: number, uri: string) => void;
    newest: () => number;
    onPoll: (waiting: boolean) => void;
}): Promise<boolean> {
    const intervalMs = Math.max(1000, targetDurationSec * 1000);
    let lastNewAt = Date.now();
    let goneAnswers = 0;

    while (!signal.aborted) {
        try {
            await abortableSleep(intervalMs, signal);
        } catch {
            return false;
        }

        try {
            const playlist = await fetchPlaylist({ url: mediaUrl, headers, signal });
            goneAnswers = 0;

            if (playlist.kind !== "media") {
                throw new Error("The media playlist turned into a master playlist");
            }

            const before = newest();
            const firstListed = playlist.segments[0]?.sequence;

            if (template && firstListed !== undefined && before >= 0 && firstListed > before + 1) {
                logger.warn({ from: before + 1, to: firstListed - 1 }, "Live window jumped; filling from the template");

                for (let sequence = before + 1; sequence < firstListed; sequence++) {
                    want(sequence, segmentUri(template, sequence));
                }
            }

            for (const segment of playlist.segments) {
                want(segment.sequence, segment.uri);
            }

            if (newest() > before) {
                lastNewAt = Date.now();
            }

            onPoll(newest() === before);

            if (playlist.ended) {
                logger.debug({ newest: newest() }, "Playlist ended (EXT-X-ENDLIST)");
                return true;
            }
        } catch (error) {
            if (signal.aborted) {
                return false;
            }

            if (error instanceof PlaylistHttpError && isGoneStatus(error.status)) {
                goneAnswers++;

                if (goneAnswers >= GONE_POLLS) {
                    logger.debug({ status: error.status }, "Playlist is gone: the stream ended");
                    return true;
                }
            } else {
                logger.warn({ error }, "Live playlist poll failed");
            }
        }

        if (Date.now() - lastNewAt > idleTimeoutMs) {
            logger.debug({ idleTimeoutMs }, "No new segment within the idle timeout: treating the stream as ended");
            return true;
        }
    }

    return false;
}
