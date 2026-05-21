/**
 * Isolated bench for the PRODUCTION `sha256File` from
 * `src/utils/fs/disk-usage.ts`. Unlike `apfs-bench-hash-isolated.ts` which
 * re-implements sha256 inline (per-call `Buffer.allocUnsafe`), this one
 * imports the actual export so a refactor like Phase 6 (module-level
 * shared buffer) shows its real delta on this bench.
 *
 * Workload: walks the root, picks the top-N files by size up to a byte cap,
 * pre-warms the page cache by reading each file once, then loops `--iterations`
 * over the file list calling `sha256File`. Reports per-iteration wall time
 * and MB/s. `--gc-stats` adds Bun's `gc()` between iterations to surface
 * allocator pressure differences.
 *
 * Usage:
 *   bun scripts/benchmarks/clones/microbenches/apfs-bench-prod-sha256.ts \
 *     --root ~/Tresors/Projects/GenesisTools --iterations 5 \
 *     [--max-files 500] [--max-mb 512] \
 *     [--jsonl scripts/benchmarks/clones/microbench-results.jsonl] \
 *     [--label phase-6-buffer-reuse-small]
 */
import { appendFileSync, openSync, closeSync, readSync, statSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { sha256File } from "@app/utils/fs/disk-usage";

interface Args {
    root: string;
    iterations: number;
    maxFiles: number;
    maxMb: number;
    jsonl: string | null;
    label: string;
}

function parseArgs(): Args {
    const argv = process.argv.slice(2);
    let root = "";
    let iterations = 5;
    let maxFiles = 500;
    let maxMb = 512;
    let jsonl: string | null = null;
    let label = "unlabeled";
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--root") {
            root = argv[++i] ?? "";
        } else if (a === "--iterations") {
            iterations = Number(argv[++i] ?? "5");
        } else if (a === "--max-files") {
            maxFiles = Number(argv[++i] ?? "500");
        } else if (a === "--max-mb") {
            maxMb = Number(argv[++i] ?? "512");
        } else if (a === "--jsonl") {
            jsonl = argv[++i] ?? null;
        } else if (a === "--label") {
            label = argv[++i] ?? "unlabeled";
        }
    }
    if (!root) {
        console.error("usage: --root <path> [--iterations N] [--max-files N] [--max-mb N] [--jsonl path] [--label name]");
        process.exit(2);
    }

    return { root, iterations, maxFiles, maxMb, jsonl, label };
}

function* walk(root: string): Generator<{ path: string; size: number }> {
    const stack: string[] = [root];
    while (stack.length > 0) {
        const d = stack.pop();
        if (d === undefined) break;
        let entries: Dirent[] = [];
        try {
            entries = readdirSync(d, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            const p = join(d, e.name);
            if (e.isSymbolicLink()) continue;
            if (e.isDirectory()) {
                stack.push(p);
            } else if (e.isFile()) {
                try {
                    const st = statSync(p);
                    yield { path: p, size: st.size };
                } catch {
                    /* ignore */
                }
            }
        }
    }
}

function preWarm(paths: string[]): void {
    // Read each file once with a discard buffer to pull it into the OS page
    // cache. Doing this OUTSIDE the timed loop neutralizes "first iteration
    // is cold" noise so the bench measures hash CPU + chunked-read overhead.
    const buf = Buffer.allocUnsafe(64 * 1024);
    for (const p of paths) {
        const fd = openSync(p, "r");
        try {
            for (;;) {
                const n = readSync(fd, buf, 0, buf.length, null);
                if (n <= 0) break;
            }
        } finally {
            closeSync(fd);
        }
    }
}

const { root, iterations, maxFiles, maxMb, jsonl, label } = parseArgs();

const candidates: Array<{ path: string; size: number }> = [];
for (const e of walk(root)) {
    if (e.size > 0) candidates.push(e);
}
// Sort ASCENDING so the picker prefers MANY SMALL files first — the
// scenario where `Buffer.allocUnsafe`-per-call overhead actually dominates.
// Few-large-files would be IO-throughput bound and hide the alloc delta.
candidates.sort((a, b) => a.size - b.size);

const picked: Array<{ path: string; size: number }> = [];
let pickedBytes = 0;
const capBytes = maxMb * 1024 * 1024;
for (const c of candidates) {
    if (picked.length >= maxFiles) break;
    if (pickedBytes + c.size > capBytes) continue;
    picked.push(c);
    pickedBytes += c.size;
}

console.error(
    `[prod-sha256] label=${label} root=${root} candidates=${candidates.length} picked=${picked.length} bytes=${(pickedBytes / 1e6).toFixed(1)} MB iterations=${iterations}`
);

preWarm(picked.map((p) => p.path));

const perIter: number[] = [];
for (let iter = 0; iter < iterations; iter++) {
    const t0 = performance.now();
    for (const p of picked) {
        sha256File(p.path);
    }
    const t1 = performance.now();
    perIter.push(t1 - t0);
    console.error(
        `[prod-sha256] iter=${iter + 1}/${iterations} ms=${(t1 - t0).toFixed(1)} mb_per_sec=${((pickedBytes / 1e6) / ((t1 - t0) / 1000)).toFixed(1)}`
    );
}

const meanMs = perIter.reduce((s, x) => s + x, 0) / perIter.length;
const minMs = Math.min(...perIter);
const maxMs = Math.max(...perIter);
const mbPerSec = (pickedBytes / 1e6) / (meanMs / 1000);

const result = {
    label,
    root,
    iterations,
    files: picked.length,
    totalBytes: pickedBytes,
    perIterMs: perIter.map((x) => +x.toFixed(2)),
    meanMs: +meanMs.toFixed(2),
    minMs: +minMs.toFixed(2),
    maxMs: +maxMs.toFixed(2),
    mbPerSec: +mbPerSec.toFixed(1),
    ts: new Date().toISOString(),
};

console.log(JSON.stringify(result));
if (jsonl !== null) {
    appendFileSync(jsonl, `${JSON.stringify(result)}\n`);
}
