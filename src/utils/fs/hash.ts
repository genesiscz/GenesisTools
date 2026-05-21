/**
 * Pluggable content-hash functions for the clones duplicate detector.
 *
 * - `sha256File(path)`         — the canonical hash, hardware-accelerated via
 *                                  BoringSSL/OpenSSL (Bun.CryptoHasher / Node
 *                                  createHash). ~2.5 GB/s on Apple Silicon.
 *                                  This is the production default.
 * - `blake3File(path)`         — BLAKE3 via `hash-wasm` (WebAssembly with
 *                                  SIMD where the runtime supports it). Used
 *                                  by the HASH microbench to compare vs
 *                                  sha256. Production-grade BLAKE3 needs a
 *                                  native binding; we keep this in for the
 *                                  measurement but recommend sha256 until a
 *                                  Bun-compatible native BLAKE3 lands.
 *
 * Both functions stream the file in 128 KB chunks — `apfs-bench-sha-buffer.ts`
 * established 128 K as the sweet spot for the chunked-readSync approach on
 * APFS / Apple Silicon (P4 in the internal audit).
 */

import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";

const STREAM_CHUNK_BYTES = 128 * 1024;

/** Module-level read buffer reused across `sha256File` and `blake3File`.
 *  Same serial-execution safety contract as `READ_BUF` in `disk-usage.ts`
 *  — see that file for the full rationale. In short: `readSync` and the
 *  hash `update` calls are synchronous and never yield, so a single buffer
 *  is safe under JS's single-threaded execution. Workers get their own
 *  module instance and thus their own buffer. */
const READ_BUF = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);

export function sha256File(path: string, opts: { signal?: AbortSignal } = {}): string {
    const h = createHash("sha256");
    const fd = openSync(path, "r");
    try {
        for (;;) {
            opts.signal?.throwIfAborted();
            const n = readSync(fd, READ_BUF, 0, READ_BUF.length, null);
            if (n <= 0) {
                break;
            }

            h.update(READ_BUF.subarray(0, n));
        }
    } finally {
        closeSync(fd);
    }

    return h.digest("hex");
}

/** BLAKE3 hasher singleton (lazy-initialized via `hash-wasm`). Reused
 *  across calls — `init()` resets internal state in O(1). The factory
 *  promise is cached so we only pay WASM-module load once. */
let blake3HasherPromise: Promise<import("hash-wasm").IHasher> | null = null;

function getBlake3Hasher(): Promise<import("hash-wasm").IHasher> {
    if (blake3HasherPromise === null) {
        blake3HasherPromise = (async () => {
            const mod = await import("hash-wasm");
            return mod.createBLAKE3();
        })();
    }

    return blake3HasherPromise;
}

/** BLAKE3 file hash via `hash-wasm`. Async because the WASM hasher is
 *  async-initialized on first use. Subsequent calls reuse the same
 *  hasher instance via `init()` (state reset). */
export async function blake3File(path: string, opts: { signal?: AbortSignal } = {}): Promise<string> {
    const hasher = await getBlake3Hasher();
    hasher.init();
    const fd = openSync(path, "r");
    try {
        for (;;) {
            opts.signal?.throwIfAborted();
            const n = readSync(fd, READ_BUF, 0, READ_BUF.length, null);
            if (n <= 0) {
                break;
            }

            hasher.update(READ_BUF.subarray(0, n));
        }
    } finally {
        closeSync(fd);
    }

    return hasher.digest("hex");
}
