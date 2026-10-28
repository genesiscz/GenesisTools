import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "./atomic-file";
import { LockTimeoutError, withFileLock } from "./file-lock";
import { toolDataDir } from "./root";

/** How long one lock attempt waits before the waiter looks for the holder's answer again. */
const LOCK_TRY_MS = 100;

/**
 * One run for identical calls made close together, across processes. On 2026-10-27 about 16 Claude sessions each
 * started the same `gh pr view` while another session's identical run was still going (644 times, 1027 process-s):
 * every process has its own memory, so the lock and the answer live in files.
 *
 * The first caller takes `<dir>/<hash>.lock` (O_EXCL; a lock whose process died is taken over), runs, and writes
 * `<hash>.json`. A caller that finds the lock waits for it, then reads that answer instead of running, while the answer
 * is at most `ttlMs` old. A wait longer than `waitMs` counts as one retry; after `retries` of them the caller gives up
 * and calls `fallback` (by default `run`, so the worst case is the old cost). A run that throws shares nothing.
 */
export async function singleFlight<T>({
    key,
    run,
    ttlMs = 10_000,
    waitMs = ttlMs,
    retries = 1,
    fallback = run,
    shouldShare,
    dir = toolDataDir("single-flight"),
}: {
    /** Everything that changes the answer: the folder, the argv, any environment it reads. */
    key: string;
    run: () => Promise<T>;
    /** How long a finished answer is shared. A short hold, never a cache. */
    ttlMs?: number;
    waitMs?: number;
    retries?: number;
    fallback?: () => Promise<T>;
    /** False keeps an answer to this caller (a failed command), so the next caller runs again. */
    shouldShare?: (value: T) => boolean;
    dir?: string;
}): Promise<T> {
    const name = Bun.hash(key).toString(16);
    const resultPath = join(dir, `${name}.json`);
    const shared = await readShared<T>(resultPath, key, ttlMs);

    if (shared) {
        return shared.value;
    }

    const lockPath = join(dir, `${name}.lock`);
    const holdAndRun = async (): Promise<T> => {
        // The holder this caller waited for may have answered while the lock was held.
        const answered = await readShared<T>(resultPath, key, ttlMs);

        if (answered) {
            return answered.value;
        }

        const value = await run();

        if (!shouldShare || shouldShare(value)) {
            try {
                const answer: SharedAnswer<T> = { key, at: Date.now(), value };
                atomicWriteFileSync(resultPath, SafeJSON.stringify(answer, { strict: true }));
            } catch (error) {
                logger.warn({ error, key }, "single-flight answer not written; later callers run again");
            }
        }

        return value;
    };

    for (let attempt = 0; attempt <= retries; attempt++) {
        const deadline = Date.now() + waitMs;

        // Short lock attempts with a look at the answer between them: every waiter reads the answer the moment it is
        // written, instead of queueing for the lock one after another only to read it there (50 waiters took 5 s).
        while (true) {
            try {
                return await withFileLock(
                    lockPath,
                    holdAndRun,
                    Math.max(0, Math.min(LOCK_TRY_MS, deadline - Date.now()))
                );
            } catch (error) {
                if (!(error instanceof LockTimeoutError)) {
                    throw error;
                }
            }

            const answered = await readShared<T>(resultPath, key, ttlMs);

            if (answered) {
                return answered.value;
            }

            if (Date.now() >= deadline) {
                break;
            }
        }
    }

    logger.debug({ key, waitMs, retries }, "single-flight wait ran out; falling back");
    return fallback();
}

/** The file a finished run leaves for the callers that waited on it. */
interface SharedAnswer<T> {
    key: string;
    at: number;
    value: T;
}

async function readShared<T>(path: string, key: string, ttlMs: number): Promise<{ value: T } | undefined> {
    try {
        const held: Partial<SharedAnswer<T>> | null = SafeJSON.parse(await readFile(path, "utf8"), { strict: true });

        if (
            held?.key === key &&
            typeof held.at === "number" &&
            Date.now() - held.at < ttlMs &&
            held.value !== undefined
        ) {
            return { value: held.value };
        }
    } catch {
        // No answer yet, or one being replaced: run.
    }

    return undefined;
}
