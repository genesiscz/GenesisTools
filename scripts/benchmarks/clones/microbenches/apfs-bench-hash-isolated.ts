/**
 * Isolated HASH microbenchmark. Times JUST the file-hash function on a
 * representative set of real files, with the OS page cache pre-warmed.
 * Measures the CPU+chunked-IO cost of the hash itself, isolated from the
 * walk + bucket-detect work.
 *
 * Variants:
 *   - "sha256-node"   Node createHash("sha256") with chunked readSync (current)
 *   - "sha256-bun"    Bun.CryptoHasher("sha256") with chunked readSync
 *   - "blake3"        P2 future variant (errors with "not implemented" until P2 lands)
 *
 * File selection: walks the root, sorts files by size, picks files in a
 * stratified-by-size sample (small/medium/large buckets) so the bench
 * reflects real workload shape, not just one size. Cap defaults: ≤300 files,
 * ≤512 MB total per iteration — keeps wall time under ~5s on warm cache.
 *
 * Usage:
 *   bun scripts/benchmarks/clones/microbenches/apfs-bench-hash-isolated.ts \
 *     --root ~/Tresors/Projects/GenesisTools --iterations 5 \
 *     [--variant sha256-node] [--max-files 300] [--max-mb 512]
 *     [--jsonl /tmp/hash-results.jsonl] [--label phase-0]
 *
 * Output: one summary line on stderr, one JSON object on stdout (and to
 * --jsonl if given).
 */

import { createHash } from "node:crypto";
import { appendFileSync, closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { type Dirent, readdirSync } from "node:fs";

interface Args {
    root: string;
    iterations: number;
    variant: "sha256-node" | "sha256-bun" | "blake3";
    maxFiles: number;
    maxMb: number;
    jsonl: string | null;
    label: string;
}

function parseArgs(): Args {
    const argv = process.argv.slice(2);
    let root = "";
    let iterations = 3;
    let variant: Args["variant"] = "sha256-node";
    let maxFiles = 300;
    let maxMb = 512;
    let jsonl: string | null = null;
    let label = "";
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--root") {
            root = argv[++i] ?? "";
        } else if (a === "--iterations") {
            iterations = Number.parseInt(argv[++i] ?? "3", 10) || 3;
        } else if (a === "--variant") {
            variant = (argv[++i] as Args["variant"]) ?? "sha256-node";
        } else if (a === "--max-files") {
            maxFiles = Number.parseInt(argv[++i] ?? "300", 10) || 300;
        } else if (a === "--max-mb") {
            maxMb = Number.parseInt(argv[++i] ?? "512", 10) || 512;
        } else if (a === "--jsonl") {
            jsonl = argv[++i] ?? null;
        } else if (a === "--label") {
            label = argv[++i] ?? "";
        }
    }
    if (!root) {
        console.error("usage: --root <dir> [--iterations 3] [--variant sha256-node|sha256-bun|blake3] [--max-files N] [--max-mb M]");
        process.exit(2);
    }
    return { root, iterations, variant, maxFiles, maxMb, jsonl, label };
}

const STREAM_CHUNK_BYTES = 128 * 1024;

function sha256Node(path: string): string {
    const h = createHash("sha256");
    const fd = openSync(path, "r");
    try {
        const buf = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
        for (;;) {
            const n = readSync(fd, buf, 0, buf.length, null);
            if (n <= 0) {
                break;
            }

            h.update(buf.subarray(0, n));
        }
    } finally {
        closeSync(fd);
    }

    return h.digest("hex");
}

function sha256Bun(path: string): string {
    const h = new Bun.CryptoHasher("sha256");
    const fd = openSync(path, "r");
    try {
        const buf = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
        for (;;) {
            const n = readSync(fd, buf, 0, buf.length, null);
            if (n <= 0) {
                break;
            }

            h.update(buf.subarray(0, n));
        }
    } finally {
        closeSync(fd);
    }

    return h.digest("hex");
}

async function blake3Hash(path: string): Promise<string> {
    try {
        const mod = await import("@app/utils/fs/hash");
        if (typeof mod.blake3File === "function") {
            return mod.blake3File(path);
        }
    } catch {
        // module not present yet — P2 hasn't landed
    }

    throw new Error("blake3 variant not implemented (P2 not landed)");
}

function pickHasher(variant: Args["variant"]): (path: string) => Promise<string> {
    if (variant === "sha256-node") {
        return async (p) => sha256Node(p);
    }

    if (variant === "sha256-bun") {
        return async (p) => sha256Bun(p);
    }

    return blake3Hash;
}

function* walkFilesSimple(root: string): Generator<{ path: string; size: number }> {
    const stack = [root];
    while (stack.length > 0) {
        const cur = stack.pop() as string;
        let entries: Dirent[];
        try {
            entries = readdirSync(cur, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const e of entries) {
            if (e.isSymbolicLink()) {
                continue;
            }

            const p = join(cur, e.name);
            if (e.isDirectory()) {
                stack.push(p);
            } else if (e.isFile()) {
                try {
                    const st = statSync(p);
                    yield { path: p, size: st.size };
                } catch {
                    // unreadable
                }
            }
        }
    }
}

function pickSample(root: string, maxFiles: number, maxBytes: number): { paths: string[]; totalBytes: number } {
    // Bucket by size band (powers of 2) so we sample tiny/small/med/large
    // files proportionally — a real scan's hash workload has all four,
    // and they have very different MB/s due to syscall overhead vs throughput.
    const bands: Map<number, Array<{ path: string; size: number }>> = new Map();
    let scanned = 0;
    for (const f of walkFilesSimple(root)) {
        if (f.size < 1024) {
            continue;
        }

        const band = Math.floor(Math.log2(f.size));
        if (!bands.has(band)) {
            bands.set(band, []);
        }
        (bands.get(band) as Array<{ path: string; size: number }>).push(f);
        scanned += 1;
        // Hard cap on walk work to keep bench startup fast on huge trees.
        if (scanned > 500_000) {
            break;
        }
    }

    // Round-robin across bands until we hit the caps. Within each band,
    // take the *first* files (deterministic; readdir order is FS-defined
    // but stable for a given snapshot — good enough for repeat runs).
    const bandKeys = [...bands.keys()].sort((a, b) => a - b);
    const cursors = new Map<number, number>();
    for (const k of bandKeys) {
        cursors.set(k, 0);
    }

    const picked: string[] = [];
    let totalBytes = 0;
    let exhausted = false;
    while (!exhausted && picked.length < maxFiles && totalBytes < maxBytes) {
        exhausted = true;
        for (const band of bandKeys) {
            const list = bands.get(band) as Array<{ path: string; size: number }>;
            const cur = cursors.get(band) as number;
            if (cur >= list.length) {
                continue;
            }

            const f = list[cur] as { path: string; size: number };
            if (totalBytes + f.size > maxBytes) {
                // Skip this file, try next band — but don't bump cursor so
                // a future round can still pick it if budget allows. Saves
                // us from getting stuck on one giant file.
                continue;
            }

            picked.push(f.path);
            totalBytes += f.size;
            cursors.set(band, cur + 1);
            exhausted = false;
            if (picked.length >= maxFiles || totalBytes >= maxBytes) {
                break;
            }
        }
    }

    return { paths: picked, totalBytes };
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) {
        return 0;
    }

    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx] as number;
}

async function main(): Promise<void> {
    const args = parseArgs();
    process.stderr.write(`[hash-bench] sampling root=${args.root} (max ${args.maxFiles} files, ${args.maxMb} MB)…\n`);
    const t0 = performance.now();
    const sample = pickSample(args.root, args.maxFiles, args.maxMb * 1024 * 1024);
    process.stderr.write(
        `[hash-bench]   sampled ${sample.paths.length} files, ${(sample.totalBytes / 1e6).toFixed(1)} MB in ${Math.round(performance.now() - t0)}ms\n`
    );

    if (sample.paths.length === 0) {
        process.stderr.write(`[hash-bench] FATAL: no files matched the sample criteria\n`);
        process.exit(1);
    }

    // Pre-warm OS page cache — read every sampled file. This bench measures
    // CPU+chunked-IO of the HASH FUNCTION ITSELF, not disk read latency.
    process.stderr.write(`[hash-bench] warming page cache…\n`);
    const wt0 = performance.now();
    for (const p of sample.paths) {
        readFileSync(p);
    }

    process.stderr.write(`[hash-bench]   warmed in ${Math.round(performance.now() - wt0)}ms\n`);

    const hasher = pickHasher(args.variant);
    process.stderr.write(`[hash-bench] hashing variant=${args.variant} iterations=${args.iterations}\n`);

    const runsMs: number[] = [];
    for (let i = 0; i < args.iterations; i++) {
        const r0 = performance.now();
        for (const p of sample.paths) {
            await hasher(p);
        }

        const dt = performance.now() - r0;
        runsMs.push(dt);
        const mb = sample.totalBytes / 1e6;
        process.stderr.write(`[hash-bench]   run ${i + 1}/${args.iterations}: ${dt.toFixed(0)}ms (${(mb / (dt / 1000)).toFixed(0)} MB/s)\n`);
    }

    const sorted = [...runsMs].sort((a, b) => a - b);
    const mean = runsMs.reduce((s, x) => s + x, 0) / runsMs.length;
    const mbPerSec = sample.totalBytes / 1e6 / (mean / 1000);
    const summary = {
        kind: "hash",
        variant: args.variant,
        root: args.root,
        label: args.label,
        files: sample.paths.length,
        totalBytes: sample.totalBytes,
        totalMb: Math.round(sample.totalBytes / 1e6),
        iterations: args.iterations,
        runsMs: runsMs.map((x) => Math.round(x)),
        meanMs: Math.round(mean),
        medianMs: Math.round(percentile(sorted, 50)),
        p95Ms: Math.round(percentile(sorted, 95)),
        minMs: Math.round(sorted[0] ?? 0),
        maxMs: Math.round(sorted[sorted.length - 1] ?? 0),
        mbPerSec: Math.round(mbPerSec),
        ts: new Date().toISOString(),
    };

    const json = JSON.stringify(summary);
    process.stdout.write(`${json}\n`);
    if (args.jsonl) {
        appendFileSync(args.jsonl, `${json}\n`);
    }
}

main().catch((err) => {
    process.stderr.write(`[hash-bench] ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
});
