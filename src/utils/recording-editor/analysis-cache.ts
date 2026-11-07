import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { releaseLock, tryAcquireLock } from "@genesiscz/utils/storage/file-lock";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { z } from "zod";

const { log } = logger.scoped("recording-analysis-cache");

/**
 * One analysis per movie, not per copy (R8 8). Every slow read of a movie (its screen text, the dense screen text,
 * the motion, the change steps, the scene times) is cached under the movie's CONTENT key in one shared folder,
 * `~/.genesis-tools/recorder/analysis/<key>/<name>.json`. A copy made with `cp -c` or `duplicate()` has the same
 * content, so it reuses the first copy's reads; three editors on three copies of one demo used to OCR it three times
 * and queue Vision for an hour. A lock beside each file keeps two processes from computing the same one at once:
 * the second waits for the first and reads its answer.
 */

/** How many bytes of the movie's start, middle and end the content key hashes, besides its size. */
const SLICE_BYTES = 4 * 1024 * 1024;

const contentKeys = new Map<string, { identity: string; key: string }>();

/**
 * The movie's content key: its size and a hash of three 4 MB slices (start, middle, end). An MP4 keeps its index
 * (durations, sample sizes) at one end, so two different recordings never share it, while a byte copy always does.
 * Kept per process by path and file identity, so a second call reads nothing.
 */
export function movieContentKey(video: string): string {
    const stat = statSync(video);
    const identity = `${stat.ino}:${stat.size}:${Math.round(stat.mtimeMs)}`;
    const known = contentKeys.get(video);

    if (known?.identity === identity) {
        return known.key;
    }

    const hash = createHash("sha256");
    const fd = openSync(video, "r");

    try {
        const starts = [
            0,
            Math.max(0, Math.floor(stat.size / 2) - SLICE_BYTES / 2),
            Math.max(0, stat.size - SLICE_BYTES),
        ];
        const buffer = Buffer.allocUnsafe(SLICE_BYTES);

        for (const start of starts) {
            const read = readSync(fd, buffer, 0, Math.min(SLICE_BYTES, stat.size - start), start);
            hash.update(buffer.subarray(0, read));
        }
    } finally {
        closeSync(fd);
    }

    const key = `${stat.size.toString(36)}-${hash.digest("hex").slice(0, 24)}`;
    contentKeys.set(video, { identity, key });
    return key;
}

/** Where the analysis `name` of the movie is kept: one file per content key and name, shared by every copy. */
export function analysisCachePath(video: string, name: string): string {
    return toolDataDir("recorder", "analysis", movieContentKey(video), `${name}.json`);
}

/** An analysis cache from before R8 8: beside the movie, keyed by the file's size and time. Read once, then moved. */
export interface LegacyAnalysisCache {
    path: string;
    key: string;
}

function readFileCache<T>(path: string, key: string, schema: z.ZodType<T>): T | undefined {
    if (!existsSync(path)) {
        return undefined;
    }

    try {
        const parsed = z
            .object({ key: z.string(), data: schema })
            .safeParse(SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }));
        return parsed.success && parsed.data.key === key ? parsed.data.data : undefined;
    } catch (error) {
        log.debug({ error, path }, "an analysis cache does not read; it is made again");
        return undefined;
    }
}

function writeFileCache(path: string, key: string, data: unknown): void {
    try {
        mkdirSync(dirname(path), { recursive: true });
        atomicWriteFileSync(path, SafeJSON.stringify({ key, data }));
    } catch (error) {
        log.warn({ error, path }, "an analysis cache could not be written; the next call reads the movie again");
    }
}

export interface AnalysisCacheRequest<T> {
    video: string;
    /** The analysis: "screen-text", "motion", "waits" and so on. */
    name: string;
    /** How it was read (rates, versions, the windows asked for). Another key is another answer. */
    key: string;
    schema: z.ZodType<T>;
    /** The pre-R8 cache beside the movie; cachedAnalysis copies a hit into the shared place. */
    legacy?: LegacyAnalysisCache;
}

/** The stored analysis: the shared one, else the old one beside the movie (`legacy` true). */
function readStored<T>({ video, name, key, schema, legacy }: AnalysisCacheRequest<T>): {
    value: T | undefined;
    legacy: boolean;
} {
    const shared = readFileCache(analysisCachePath(video, name), key, schema);

    if (shared !== undefined || !legacy) {
        return { value: shared, legacy: false };
    }

    const old = readFileCache(legacy.path, legacy.key, schema);
    return { value: old, legacy: old !== undefined };
}

/**
 * The cached analysis, or undefined. Takes no lock, computes nothing and writes nothing: for a check that must not
 * read the movie or change what a later process sees.
 */
export function readAnalysis<T>(request: AnalysisCacheRequest<T>): T | undefined {
    return readStored(request).value;
}

/** How long a caller waits for another process that computes the same analysis before it computes it itself. */
const LOCK_WAIT_MS = 3 * 60 * 60 * 1000;
/** How often a waiting caller tries the lock again (the holder runs for minutes, so a second is fine). */
const LOCK_RETRY_MS = 1000;

/** Calls in this process that wait for the same lock run one after another, without polling the lock file. */
const inProcess = new Map<string, Promise<unknown>>();

/**
 * The analysis from the shared cache, or computed under its lock and written there. `complete` says whether a cached
 * value covers what the caller needs (an incremental cache of frames or windows); when it does not, `compute` gets
 * the cached value to extend and returns the whole new one. A caller that finds the lock held waits for the holder
 * (it is alive: a dead holder's lock is taken over) and then reads its answer instead of computing.
 */
export async function cachedAnalysis<T>(
    request: AnalysisCacheRequest<T> & {
        compute: (cached: T | undefined) => Promise<T>;
        complete?: (cached: T) => boolean;
        /** Test seams. */
        waitMs?: number;
        retryMs?: number;
    }
): Promise<T> {
    const { video, name, key, compute, complete = () => true } = request;
    const path = analysisCachePath(video, name);
    const first = readStored(request);

    if (first.value !== undefined && complete(first.value)) {
        if (first.legacy) {
            writeFileCache(path, key, first.value);
        }

        return first.value;
    }

    const lockPath = `${path}.lock`;
    const previous = inProcess.get(lockPath) ?? Promise.resolve();
    const run = previous
        .catch(() => undefined)
        .then(async () => {
            const held = await takeLock({
                lockPath,
                waitMs: request.waitMs ?? LOCK_WAIT_MS,
                retryMs: request.retryMs ?? LOCK_RETRY_MS,
                name,
            });

            try {
                const stored = readStored(request);

                if (stored.value !== undefined && complete(stored.value)) {
                    if (stored.legacy) {
                        writeFileCache(path, key, stored.value);
                    }

                    return stored.value;
                }

                const value = await compute(stored.value);
                writeFileCache(path, key, value);
                return value;
            } finally {
                if (held) {
                    await releaseLock(lockPath);
                }
            }
        });
    inProcess.set(lockPath, run);

    try {
        return await run;
    } finally {
        if (inProcess.get(lockPath) === run) {
            inProcess.delete(lockPath);
        }
    }
}

/** Takes the lock, waiting while a live process holds it. False after `waitMs`: the caller computes without it. */
async function takeLock({
    lockPath,
    waitMs,
    retryMs,
    name,
}: {
    lockPath: string;
    waitMs: number;
    retryMs: number;
    name: string;
}): Promise<boolean> {
    const deadline = Date.now() + waitMs;
    let told = false;

    while (!(await tryAcquireLock(lockPath))) {
        const remaining = deadline - Date.now();

        if (remaining <= 0) {
            log.warn(
                { lockPath, waitMs },
                `waited too long for another process's ${name} of this movie; reading it here`
            );
            return false;
        }

        if (!told) {
            log.info({ lockPath }, `another process reads the ${name} of this movie; waiting for its answer`);
            told = true;
        }

        await Bun.sleep(Math.min(retryMs, remaining));
    }

    return true;
}
