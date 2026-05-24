/**
 * Microbench: bytesEqualStreaming throughput on warm-cache file pairs.
 * Mirrors warm `findDuplicateFiles` byte-compare phase.
 */

import { readFileSync, statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
    bytesEqualStreaming,
    walkFiles,
} from "../../../../src/utils/fs/disk-usage";

const root = process.argv[2] ?? process.cwd();

// Collect paths, group by size, pick same-size pairs.
const bySize = new Map<number, string[]>();
for (const e of walkFiles(root)) {
    if (e.logical < 4096) continue;
    const a = bySize.get(e.logical) ?? [];
    a.push(e.path);
    bySize.set(e.logical, a);
}

// Make pairs: only multi-member size groups. To simulate warm hot path, pick
// pairs that are likely IDENTICAL — same-size files in node_modules.
const pairs: { a: string; b: string; size: number }[] = [];
for (const [size, paths] of bySize) {
    if (paths.length < 2) continue;
    pairs.push({ a: paths[0], b: paths[1], size });
}
console.log(
    `pairs: ${pairs.length}, total bytes per side ~ ${(pairs.reduce((s, p) => s + p.size, 0) / 1e6).toFixed(1)} MB`
);

// Pre-warm the page cache on every file.
for (const p of pairs) {
    readFileSync(p.a);
    readFileSync(p.b);
}

if (pairs.length === 0) {
    console.log("No same-size pairs found — nothing to compare.");
    process.exit(0);
}

// Now time bytesEqualStreaming.
const t0 = performance.now();
let equal = 0;
let diff = 0;
let totalBytes = 0;
for (const p of pairs) {
    if (bytesEqualStreaming(p.a, p.b)) equal += 1;
    else diff += 1;
    totalBytes += p.size; // reading both files = 2x; but report logical
}
const t1 = performance.now();
const ms = t1 - t0;
console.log(`bytesEqualStreaming: ${pairs.length} pairs in ${ms.toFixed(1)}ms`);
console.log(`  equal=${equal} diff=${diff}`);
console.log(`  per-pair=${(ms / pairs.length).toFixed(2)}ms`);
console.log(`  logical bytes (each side)=${totalBytes} = ${(totalBytes / 1e6).toFixed(1)}MB`);
console.log(`  throughput (1 side, MB/s)=${(totalBytes / 1e6 / (ms / 1000)).toFixed(1)}`);
console.log(`  throughput (2 sides, MB/s)=${((2 * totalBytes) / 1e6 / (ms / 1000)).toFixed(1)}`);
