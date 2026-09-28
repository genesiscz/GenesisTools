import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, type FileHandle, lstat, mkdir, open, opendir, rename, rm, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type EvaluationRequest, type IssueCount, toJson } from "./types";

const { log } = logger.scoped("jev-grep");

/** Bump to invalidate every entry. Entries of other schema numbers are deleted on the first write. */
const SCHEMA = 1;
const ENTRIES = `entries-v${SCHEMA}`;
const ENTRY_NAME = /^[a-f0-9]{64}\.json$/;
const PENDING_NAME = /^\.pending-[a-f0-9-]+$/;
const DETACHED_NAME = /^\.cleared-[a-f0-9-]+$/;
const OTHER_SCHEMA = /^entries-v\d+$/;
const PENDING_MAX_AGE_MS = 60 * 60 * 1000;

export type CacheWarning = "cache_unavailable" | "cache_corrupt" | "cache_limit";
export type CacheAnswers = Record<string, number>;

export interface CacheKeyInput {
    /** Provider id, model id, filesystem `policyVersion`, prompt version. Never the absolute root. */
    namespace: { provider: string; model: string; policyVersion: string; promptVersion: string };
    /** Relative paths and content hashes of every snapshot the request was built from. */
    sources: Array<{ path: string; contentHash: string }>;
    /** The exact state and question object sent to Jev. Only its digest reaches the disk. */
    request: EvaluationRequest;
}

export interface GrepCacheOptions {
    directory: string;
    enabled?: boolean;
    ttlMs?: number;
    maxBytes?: number;
    now?: () => number;
}

function validAnswers(value: unknown): value is CacheAnswers {
    return (
        !!value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.values(value).every((answer) => typeof answer === "number" && Number.isFinite(answer))
    );
}

function errnoCode(error: unknown): string | undefined {
    return error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;
}

function missing(error: unknown): boolean {
    return errnoCode(error) === "ENOENT";
}

/**
 * Answer-only, best-effort storage under `~/.genesis-tools/jev/grep-cache/`. A value is the validated
 * `id -> probability` map; no source, preview or excerpt is ever written. Every problem is a warning,
 * never an issue, so a broken cache cannot turn a healthy search incomplete.
 */
export function createGrepCache(options: GrepCacheOptions) {
    const directory = resolve(options.directory);
    const entries = join(directory, ENTRIES);
    const enabled = options.enabled !== false;
    const ttlMs = options.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
    const maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
    const now = options.now ?? Date.now;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        throw new Error("Invalid cache limits");
    }

    const maxEntryBytes = Math.min(maxBytes, 1024 * 1024);
    const warnings = new Map<CacheWarning, number>();
    let hits = 0;
    let misses = 0;
    /** Bytes this process believes the entries directory holds; measured once, then kept by the writer. */
    let storedBytes: number | undefined;
    let opening: Promise<number> | undefined;

    function warn(kind: CacheWarning, error?: unknown): void {
        warnings.set(kind, (warnings.get(kind) ?? 0) + 1);
        log.debug({ kind, code: errnoCode(error) }, "Grep cache warning");
    }

    function key(input: CacheKeyInput): string {
        const sources = [...new Map(input.sources.map((source) => [source.path, source])).values()]
            .map(({ path, contentHash }) => [path, contentHash])
            .sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0));
        // Request and question order are preserved: they are part of what Jev saw.
        return createHash("sha256")
            .update(toJson([SCHEMA, input.namespace, sources, input.request]))
            .digest("hex");
    }

    async function checkDirectory(path: string, create: boolean): Promise<void> {
        if (create) {
            await mkdir(path, { recursive: true, mode: 0o700 });
        }

        const info = await lstat(path);
        if (!info.isDirectory() || info.isSymbolicLink()) {
            throw new Error("Cache path is not a directory");
        }

        if (create && (info.mode & 0o777) !== 0o700) {
            await chmod(path, 0o700);
        }
    }

    async function remove(path: string): Promise<void> {
        try {
            await unlink(path);
        } catch (error) {
            if (!missing(error)) {
                throw error;
            }
        }
    }

    /** Drop other schema generations and detached clears, prune expired and abandoned entries, sum the rest. */
    async function openEntries(): Promise<number> {
        await checkDirectory(directory, true);
        for await (const entry of await opendir(directory)) {
            if (entry.name === ENTRIES || !(OTHER_SCHEMA.test(entry.name) || DETACHED_NAME.test(entry.name))) {
                continue;
            }

            try {
                await rm(join(directory, entry.name), { recursive: true, force: true });
                log.debug({ name: entry.name }, "Removed an old grep cache generation");
            } catch (error) {
                warn("cache_unavailable", error);
            }
        }

        await checkDirectory(entries, true);
        let total = 0;
        for await (const entry of await opendir(entries)) {
            if (!ENTRY_NAME.test(entry.name) && !PENDING_NAME.test(entry.name)) {
                continue;
            }

            const path = join(entries, entry.name);
            try {
                const info = await lstat(path);
                if (!info.isFile() || info.isSymbolicLink()) {
                    continue;
                }

                const age = now() - info.mtimeMs;
                if (PENDING_NAME.test(entry.name) ? age > PENDING_MAX_AGE_MS : age >= ttlMs) {
                    await remove(path);
                    continue;
                }

                total += info.size;
            } catch (error) {
                if (!missing(error)) {
                    warn("cache_unavailable", error);
                }
            }
        }

        return total;
    }

    async function get(input: CacheKeyInput): Promise<CacheAnswers | undefined> {
        if (!enabled) {
            misses++;
            return undefined;
        }

        let handle: FileHandle | undefined;
        try {
            handle = await open(
                join(entries, `${key(input)}.json`),
                constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
            );
            const info = await handle.stat();
            if (!info.isFile() || info.size > maxEntryBytes) {
                warn("cache_corrupt");
                misses++;
                return undefined;
            }

            const buffer = Buffer.allocUnsafe(maxEntryBytes + 1);
            let length = 0;
            while (length < buffer.length) {
                const result = await handle.read(buffer, length, buffer.length - length, null);
                if (!result.bytesRead) {
                    break;
                }

                length += result.bytesRead;
            }

            let value: unknown;
            try {
                value = SafeJSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)), {
                    strict: true,
                });
            } catch (error) {
                warn("cache_corrupt", error);
                misses++;
                return undefined;
            }

            if (
                !value ||
                typeof value !== "object" ||
                !("schema" in value) ||
                value.schema !== SCHEMA ||
                !("createdAt" in value) ||
                typeof value.createdAt !== "number" ||
                !Number.isFinite(value.createdAt) ||
                !("answers" in value) ||
                !validAnswers(value.answers)
            ) {
                warn("cache_corrupt");
                misses++;
                return undefined;
            }

            const age = now() - value.createdAt;
            if (age < 0 || age >= ttlMs) {
                misses++;
                return undefined;
            }

            hits++;
            return value.answers;
        } catch (error) {
            if (!missing(error)) {
                warn("cache_unavailable", error);
            }

            misses++;
            return undefined;
        } finally {
            try {
                await handle?.close();
            } catch (error) {
                warn("cache_unavailable", error);
            }
        }
    }

    /** The evaluator calls this only with a complete, validated answer map from a healthy call. */
    async function put(input: CacheKeyInput, answers: CacheAnswers): Promise<void> {
        if (!enabled) {
            return;
        }

        if (!validAnswers(answers)) {
            warn("cache_corrupt");
            return;
        }

        const payload = toJson({ schema: SCHEMA, createdAt: now(), answers });
        const size = Buffer.byteLength(payload);
        let temporary: string | undefined;
        let handle: FileHandle | undefined;
        let reserved = 0;
        try {
            // A failed first scan is not kept: the next write scans again.
            opening ??= openEntries().catch((error: unknown) => {
                opening = undefined;
                throw error;
            });
            const measured = await opening;
            storedBytes ??= measured;
            // Check and reserve in one synchronous step: up to 32 writers share this cap.
            if (size > maxEntryBytes || storedBytes + size > maxBytes) {
                warn("cache_limit");
                return;
            }

            storedBytes += size;
            reserved = size;
            // A concurrent clear may have detached the directory; recreate it rather than fail.
            await checkDirectory(entries, true);
            temporary = join(entries, `.pending-${randomUUID()}`);
            handle = await open(
                temporary,
                constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
                0o600
            );
            await handle.writeFile(payload);
            await handle.close();
            handle = undefined;
            await rename(temporary, join(entries, `${key(input)}.json`));
            temporary = undefined;
            reserved = 0;
        } catch (error) {
            warn("cache_unavailable", error);
        } finally {
            if (storedBytes !== undefined) {
                storedBytes -= reserved;
            }

            try {
                await handle?.close();
            } catch (error) {
                warn("cache_unavailable", error);
            }

            if (temporary) {
                try {
                    await remove(temporary);
                } catch (error) {
                    warn("cache_unavailable", error);
                }
            }
        }
    }

    function stats(): { hits: number; misses: number; warnings: IssueCount[] } {
        return { hits, misses, warnings: [...warnings].map(([kind, count]) => ({ kind, count })) };
    }

    return { directory, enabled, get, put, stats };
}

export type GrepCache = ReturnType<typeof createGrepCache>;

/**
 * Detach the live generation with one rename, then delete it. A search still running keeps writing
 * into the detached directory or recreates a fresh one; neither crashes. Touches nothing outside
 * `directory`, so the arena connectome cache beside it survives.
 */
export async function clearGrepCache(directory: string): Promise<{ cleared: boolean }> {
    const root = resolve(directory);
    const detached = join(root, `.cleared-${randomUUID()}`);
    try {
        await rename(join(root, ENTRIES), detached);
    } catch (error) {
        if (missing(error)) {
            log.info({ directory: root }, "Grep cache was already empty");
            return { cleared: false };
        }

        throw error;
    }

    await rm(detached, { recursive: true, force: true });
    log.info({ directory: root }, "Cleared the grep cache");
    return { cleared: true };
}
