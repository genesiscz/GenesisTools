/**
 * Realistic byte-compare WITHOUT pre-warming — what production warm scan
 * actually does (sha was cached so files were never read this scan).
 */
import { performance } from "node:perf_hooks";
import { execSync } from "node:child_process";
import { bytesEqualStreaming, walkFiles } from "/Users/Martin/Tresors/Projects/GenesisTools-dupperf/src/utils/fs/disk-usage";

const root = process.argv[2] ?? "/Users/Martin/Tresors/Projects/GenesisTools";

const bySize = new Map<number, string[]>();
for (const e of walkFiles(root)) {
    if (e.logical < 1) continue;
    const a = bySize.get(e.logical) ?? [];
    a.push(e.path);
    bySize.set(e.logical, a);
}

const pairs: { a: string; b: string; size: number }[] = [];
for (const [size, paths] of bySize) {
    if (paths.length < 2) continue;
    for (let i = 1; i < paths.length; i++) {
        pairs.push({ a: paths[0], b: paths[i], size });
    }
}
console.log(`pairs: ${pairs.length}`);

// NOT pre-warming. Just running.
const sampleSize = Math.min(pairs.length, 5000);
const t0 = performance.now();
for (let i = 0; i < sampleSize; i++) {
    try {
        bytesEqualStreaming(pairs[i].a, pairs[i].b);
    } catch {}
}
const t1 = performance.now();
console.log(`COLD ${sampleSize} pairs in ${(t1 - t0).toFixed(0)}ms = ${((t1 - t0) / sampleSize).toFixed(2)}ms/pair`);
console.log(`scaled to 33k pairs: ${((33053 / sampleSize) * (t1 - t0) / 1000).toFixed(1)}s`);

// Second run = warm in-process
const t2 = performance.now();
for (let i = 0; i < sampleSize; i++) {
    try {
        bytesEqualStreaming(pairs[i].a, pairs[i].b);
    } catch {}
}
const t3 = performance.now();
console.log(`WARM ${sampleSize} pairs in ${(t3 - t2).toFixed(0)}ms = ${((t3 - t2) / sampleSize).toFixed(2)}ms/pair`);
console.log(`scaled to 33k pairs: ${((33053 / sampleSize) * (t3 - t2) / 1000).toFixed(1)}s`);
