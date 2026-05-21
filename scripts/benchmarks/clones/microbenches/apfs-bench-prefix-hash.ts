/**
 * Isolated PREFIX-HASH microbenchmark. Targets the optimization at the
 * heart of P3: hash a small prefix of every same-size candidate, group
 * by (size, prefix_hash), then full-hash only the prefix-collision
 * sub-buckets. Files with different prefixes are dropped as non-duplicates
 * with one short read each.
 *
 * Variants:
 *   - "full"    Full sha256 on every same-size candidate (current behavior)
 *   - "prefix"  Prefix sha256 (PREFIX_BYTES) → group → full sha256 only
 *               on the prefix-colliding sub-groups
 *
 * The bench walks the root, groups files by exact size, keeps buckets with
 * ≥2 files (real same-size candidates the dup scan would hash). To keep
 * wall time bounded it caps per-iteration hashed bytes; remaining buckets
 * are skipped. Both variants see the SAME bucket set and the same OS
 * page cache state (we pre-warm before timing).
 *
 * Usage:
 *   bun scripts/benchmarks/clones/microbenches/apfs-bench-prefix-hash.ts \
 *     --root ~/Tresors/Projects/GenesisTools --iterations 3 \
 *     [--variant full|prefix] [--prefix-bytes 4096] [--min-size 1048576]
 *     [--max-mb 1024] [--jsonl /tmp/prefix-hash.jsonl] [--label phase-0]
 */

import { createHash } from "node:crypto";
import { type Dirent, appendFileSync, closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

interface Args {
    root: string;
    iterations: number;
    variant: "full" | "prefix";
    prefixBytes: number;
    minSize: number;
    maxMb: number;
    jsonl: string | null;
    label: string;
}

function parseArgs(): Args {
    const argv = process.argv.slice(2);
    let root = "";
    let iterations = 3;
    let variant: Args["variant"] = "full";
    let prefixBytes = 4096;
    let minSize = 1024 * 1024; // 1 MB default — matches the dup scanner's --min-real default vibes
    let maxMb = 1024;
    let jsonl: string | null = null;
    let label = "";
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--root") {
            root = argv[++i] ?? "";
        } else if (a === "--iterations") {
            iterations = Number.parseInt(argv[++i] ?? "3", 10) || 3;
        } else if (a === "--variant") {
            variant = (argv[++i] as Args["variant"]) ?? "full";
        } else if (a === "--prefix-bytes") {
            prefixBytes = Number.parseInt(argv[++i] ?? "4096", 10) || 4096;
        } else if (a === "--min-size") {
            minSize = Number.parseInt(argv[++i] ?? "1048576", 10) || 1048576;
        } else if (a === "--max-mb") {
            maxMb = Number.parseInt(argv[++i] ?? "1024", 10) || 1024;
        } else if (a === "--jsonl") {
            jsonl = argv[++i] ?? null;
        } else if (a === "--label") {
            label = argv[++i] ?? "";
        }
    }
    if (!root) {
        console.error("usage: --root <dir> [--iterations 3] [--variant full|prefix] [--prefix-bytes 4096] [--min-size 1048576] [--max-mb 1024]");
        process.exit(2);
    }
    return { root, iterations, variant, prefixBytes, minSize, maxMb, jsonl, label };
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

function buildSameSizeBuckets(root: string, minSize: number, maxBytes: number): {
    buckets: Array<{ size: number; paths: string[] }>;
    totalCandidates: number;
    totalCandidateBytes: number;
} {
    const bySize = new Map<number, string[]>();
    let scanned = 0;
    for (const f of walkFilesSimple(root)) {
        if (f.size < minSize) {
            continue;
        }

        if (!bySize.has(f.size)) {
            bySize.set(f.size, []);
        }
        (bySize.get(f.size) as string[]).push(f.path);
        scanned += 1;
        if (scanned > 1_000_000) {
            break;
        }
    }

    const buckets: Array<{ size: number; paths: string[] }> = [];
    let totalCandidates = 0;
    let totalCandidateBytes = 0;
    // Sort by bucket-size descending so we get the most expensive ones first.
    const sortedEntries = [...bySize.entries()]
        .filter(([, paths]) => paths.length >= 2)
        .sort((a, b) => b[0] * b[1].length - a[0] * a[1].length);
    for (const [size, paths] of sortedEntries) {
        const bytesIfAccepted = totalCandidateBytes + size * paths.length;
        if (bytesIfAccepted > maxBytes) {
            // Allow partial inclusion if we still have budget
            const remaining = maxBytes - totalCandidateBytes;
            const accept = Math.floor(remaining / size);
            if (accept < 2) {
                continue;
            }

            const slice = paths.slice(0, accept);
            buckets.push({ size, paths: slice });
            totalCandidates += slice.length;
            totalCandidateBytes += slice.length * size;
            break;
        }

        buckets.push({ size, paths });
        totalCandidates += paths.length;
        totalCandidateBytes += paths.length * size;
    }

    return { buckets, totalCandidates, totalCandidateBytes };
}

const STREAM_CHUNK_BYTES = 128 * 1024;

function sha256File(path: string): string {
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

function sha256Prefix(path: string, prefixBytes: number): string {
    const h = createHash("sha256");
    const fd = openSync(path, "r");
    try {
        const buf = Buffer.allocUnsafe(Math.min(prefixBytes, STREAM_CHUNK_BYTES));
        let read = 0;
        while (read < prefixBytes) {
            const want = Math.min(prefixBytes - read, buf.length);
            const n = readSync(fd, buf, 0, want, null);
            if (n <= 0) {
                break;
            }

            h.update(buf.subarray(0, n));
            read += n;
        }
    } finally {
        closeSync(fd);
    }

    return h.digest("hex");
}

interface RunStats {
    /** Number of full-file hashes performed */
    fullHashes: number;
    /** Number of prefix hashes performed (== candidates in "prefix" variant; 0 in "full") */
    prefixHashes: number;
    /** Bytes the full-hash pass read (sum of file sizes that got full-hashed) */
    fullBytesRead: number;
    /** Bytes the prefix-hash pass read (prefixHashes * prefixBytes, clamped per file) */
    prefixBytesRead: number;
    /** Number of duplicate "groups" emitted (members hashed to the same digest) */
    groupsEmitted: number;
}

function runFull(buckets: Array<{ size: number; paths: string[] }>): RunStats {
    const stats: RunStats = { fullHashes: 0, prefixHashes: 0, fullBytesRead: 0, prefixBytesRead: 0, groupsEmitted: 0 };
    for (const bucket of buckets) {
        const byHash = new Map<string, string[]>();
        for (const p of bucket.paths) {
            const h = sha256File(p);
            stats.fullHashes += 1;
            stats.fullBytesRead += bucket.size;
            if (!byHash.has(h)) {
                byHash.set(h, []);
            }
            (byHash.get(h) as string[]).push(p);
        }
        for (const group of byHash.values()) {
            if (group.length >= 2) {
                stats.groupsEmitted += 1;
            }
        }
    }
    return stats;
}

function runPrefix(buckets: Array<{ size: number; paths: string[] }>, prefixBytes: number): RunStats {
    const stats: RunStats = { fullHashes: 0, prefixHashes: 0, fullBytesRead: 0, prefixBytesRead: 0, groupsEmitted: 0 };
    for (const bucket of buckets) {
        // For very small files (< prefixBytes) the prefix == full content;
        // hash once and skip the second pass. Hashes ≤4KB are tens of µs.
        const effectivePrefix = Math.min(prefixBytes, bucket.size);
        const byPrefix = new Map<string, string[]>();
        for (const p of bucket.paths) {
            const ph = sha256Prefix(p, effectivePrefix);
            stats.prefixHashes += 1;
            stats.prefixBytesRead += effectivePrefix;
            if (!byPrefix.has(ph)) {
                byPrefix.set(ph, []);
            }
            (byPrefix.get(ph) as string[]).push(p);
        }
        // Files whose prefix is the WHOLE file → already fully hashed.
        if (effectivePrefix === bucket.size) {
            for (const group of byPrefix.values()) {
                if (group.length >= 2) {
                    stats.groupsEmitted += 1;
                }
            }

            continue;
        }

        // For larger files: full-hash only sub-buckets where ≥2 prefixes matched.
        for (const subBucket of byPrefix.values()) {
            if (subBucket.length < 2) {
                continue;
            }

            const byFull = new Map<string, string[]>();
            for (const p of subBucket) {
                const h = sha256File(p);
                stats.fullHashes += 1;
                stats.fullBytesRead += bucket.size;
                if (!byFull.has(h)) {
                    byFull.set(h, []);
                }
                (byFull.get(h) as string[]).push(p);
            }
            for (const group of byFull.values()) {
                if (group.length >= 2) {
                    stats.groupsEmitted += 1;
                }
            }
        }
    }
    return stats;
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
    process.stderr.write(`[prefix-bench] building same-size buckets root=${args.root} minSize=${args.minSize} maxMB=${args.maxMb}…\n`);
    const t0 = performance.now();
    const { buckets, totalCandidates, totalCandidateBytes } = buildSameSizeBuckets(
        args.root,
        args.minSize,
        args.maxMb * 1024 * 1024
    );
    process.stderr.write(
        `[prefix-bench]   ${buckets.length} same-size buckets, ${totalCandidates} candidates, ${(totalCandidateBytes / 1e6).toFixed(1)} MB total in ${Math.round(performance.now() - t0)}ms\n`
    );
    if (buckets.length === 0) {
        process.stderr.write(`[prefix-bench] FATAL: no same-size buckets ≥${args.minSize} bytes\n`);
        process.exit(1);
    }

    // Pre-warm OS page cache — read every candidate. Both variants
    // see the same warm-cache state.
    process.stderr.write(`[prefix-bench] warming page cache (reading ${totalCandidates} files)…\n`);
    const wt0 = performance.now();
    for (const b of buckets) {
        for (const p of b.paths) {
            try {
                readFileSync(p);
            } catch {
                // skip unreadable
            }
        }
    }

    process.stderr.write(`[prefix-bench]   warmed in ${Math.round(performance.now() - wt0)}ms\n`);

    process.stderr.write(`[prefix-bench] running variant=${args.variant} iterations=${args.iterations}\n`);
    const runsMs: number[] = [];
    let firstStats: RunStats | null = null;
    for (let i = 0; i < args.iterations; i++) {
        const r0 = performance.now();
        const stats = args.variant === "full" ? runFull(buckets) : runPrefix(buckets, args.prefixBytes);
        const dt = performance.now() - r0;
        runsMs.push(dt);
        if (firstStats === null) {
            firstStats = stats;
        }
        process.stderr.write(
            `[prefix-bench]   run ${i + 1}/${args.iterations}: ${dt.toFixed(0)}ms fullHashes=${stats.fullHashes} prefixHashes=${stats.prefixHashes} groups=${stats.groupsEmitted}\n`
        );
    }

    const sorted = [...runsMs].sort((a, b) => a - b);
    const mean = runsMs.reduce((s, x) => s + x, 0) / runsMs.length;
    const summary = {
        kind: "prefix-hash",
        variant: args.variant,
        root: args.root,
        label: args.label,
        prefixBytes: args.prefixBytes,
        minSize: args.minSize,
        buckets: buckets.length,
        candidates: totalCandidates,
        candidateBytes: totalCandidateBytes,
        iterations: args.iterations,
        runsMs: runsMs.map((x) => Math.round(x)),
        meanMs: Math.round(mean),
        medianMs: Math.round(percentile(sorted, 50)),
        p95Ms: Math.round(percentile(sorted, 95)),
        stats: firstStats,
        ts: new Date().toISOString(),
    };

    const json = JSON.stringify(summary);
    process.stdout.write(`${json}\n`);
    if (args.jsonl) {
        appendFileSync(args.jsonl, `${json}\n`);
    }
}

main().catch((err) => {
    process.stderr.write(`[prefix-bench] ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
});
