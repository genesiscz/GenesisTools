/**
 * Parallel sha256 over a list of files. The bucket loop in
 * `findDuplicateFiles` hashes ~100 k cache-miss reps sequentially on the cold
 * scan; on Apple Silicon the hash itself is hardware-accelerated (~2.5 GB/s
 * SHA-NI ceiling, well above SSD read throughput), so the workload is
 * dominated by `readSync` + open/close syscall overhead — exactly the
 * scenario that benefits from issuing reads concurrently.
 *
 * Approach: async I/O with bounded concurrency via the libuv worker pool.
 * - `fs/promises.open(path).read(buf)` dispatches each read to libuv's
 *   thread pool (default 4 threads, override via `UV_THREADPOOL_SIZE`).
 *   With concurrency N we have up to N concurrent `read()` calls in flight.
 * - SHA-256 CPU work (`h.update(buf.subarray)`) runs on the main JS
 *   thread, serialised across all in-flight workers. For 936 MB total
 *   at SHA-NI 2.5 GB/s that's ~375 ms of CPU — well below the wall
 *   time, so the main-thread bottleneck doesn't bind here.
 *
 * This is intentionally NOT a worker_threads pool — worker IPC + V8 isolate
 * spinup would add seconds of overhead for what should be a sub-1ms-per-
 * file workload. If profiling later shows the main thread can't keep up
 * with the hash CPU (e.g. on a future M-series with faster SSDs that
 * push hash CPU above wall-time), revisit with `node:worker_threads`.
 */
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

const STREAM_CHUNK_BYTES = 64 * 1024;

/** Bytes-per-worker chunk buffer. One per worker, allocated once at pool
 *  start — by the time control returns to the main thread between read
 *  chunks, the buffer is still uniquely owned by this worker's loop. */
const WORKER_BUF_BYTES = STREAM_CHUNK_BYTES;

export interface ParallelSha256Options {
    /** Number of concurrent file readers. Defaults to 8 — empirically
     *  the breakpoint where libuv saturates on Apple Silicon NVMe. Tune
     *  via this option if you know your tree's read amplification. */
    concurrency?: number;
    signal?: AbortSignal;
}

/** Hashes every file in `paths` and returns a Map<path, sha256-hex>.
 *  Order of return is undefined — callers MUST look up by path.
 *  On any per-file error, the entry is omitted from the result Map and
 *  the error is recorded in the second return value. */
export interface ParallelSha256Result {
    shas: Map<string, string>;
    errors: Map<string, Error>;
}

async function hashOne(path: string, buf: Buffer, signal: AbortSignal | undefined): Promise<string> {
    const h = createHash("sha256");
    const file = await open(path, "r");
    try {
        for (;;) {
            signal?.throwIfAborted();
            const { bytesRead } = await file.read(buf, 0, buf.length, null);
            if (bytesRead === 0) {
                break;
            }

            h.update(buf.subarray(0, bytesRead));
        }
    } finally {
        await file.close();
    }

    return h.digest("hex");
}

export async function sha256FilesParallel(
    paths: readonly string[],
    opts: ParallelSha256Options = {}
): Promise<ParallelSha256Result> {
    const concurrency = Math.max(1, opts.concurrency ?? 8);
    const shas = new Map<string, string>();
    const errors = new Map<string, Error>();

    if (paths.length === 0) {
        return { shas, errors };
    }

    // Single-path fast path — no point spinning a "pool" of 1 worker.
    if (paths.length === 1) {
        const buf = Buffer.allocUnsafe(WORKER_BUF_BYTES);
        try {
            shas.set(paths[0], await hashOne(paths[0], buf, opts.signal));
        } catch (err) {
            errors.set(paths[0], err instanceof Error ? err : new Error(String(err)));
        }
        return { shas, errors };
    }

    // Shared queue index — each worker grabs the next path atomically.
    // (Atomicity is trivial here because JS is single-threaded and the
    // worker function only reads `next` after an await point completes
    // its previous file. No race.)
    let next = 0;

    const worker = async (): Promise<void> => {
        const buf = Buffer.allocUnsafe(WORKER_BUF_BYTES);
        while (true) {
            if (opts.signal?.aborted) {
                return;
            }

            const idx = next;
            next += 1;
            if (idx >= paths.length) {
                return;
            }

            const path = paths[idx];
            try {
                shas.set(path, await hashOne(path, buf, opts.signal));
            } catch (err) {
                errors.set(path, err instanceof Error ? err : new Error(String(err)));
            }
        }
    };

    const workerCount = Math.min(concurrency, paths.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return { shas, errors };
}
