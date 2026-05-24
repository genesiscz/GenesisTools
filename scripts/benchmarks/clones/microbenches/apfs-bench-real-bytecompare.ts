/**
 * Realistic byte-compare: pick actual same-size GROUPS (not just first pair),
 * and measure the cost mimicking the production hot loop.
 */

import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
    bytesEqualStreaming,
    walkFiles,
} from "../../../../src/utils/fs/disk-usage";

const root = process.argv[2] ?? process.cwd();

// Walk and bucket by size, like findDuplicateFiles does.
const bySize = new Map<number, string[]>();
for (const e of walkFiles(root)) {
    if (e.logical < 1) continue;
    const a = bySize.get(e.logical) ?? [];
    a.push(e.path);
    bySize.set(e.logical, a);
}

// Make pairs from EVERY multi-member group (not just first two).
const pairs: { a: string; b: string; size: number }[] = [];
for (const [size, paths] of bySize) {
    if (paths.length < 2) continue;
    for (let i = 1; i < paths.length; i++) {
        pairs.push({ a: paths[0], b: paths[i], size });
    }
}
console.log(`pairs: ${pairs.length}`);

// Pre-warm
console.log("Pre-warming page cache...");
for (const p of pairs.slice(0, 5000)) {
    try {
        readFileSync(p.a);
        readFileSync(p.b);
    } catch {}
}

// Now time
const t0 = performance.now();
let equalCount = 0;
let diffCount = 0;
let errCount = 0;
let totalBytes = 0;
const sampleSize = Math.min(pairs.length, 5000);
if (sampleSize === 0) {
    console.log("No same-size pairs found — nothing to compare.");
    process.exit(0);
}
for (let i = 0; i < sampleSize; i++) {
    const p = pairs[i];
    try {
        if (bytesEqualStreaming(p.a, p.b)) equalCount += 1;
        else diffCount += 1;
        totalBytes += p.size;
    } catch {
        errCount += 1;
    }
}
const t1 = performance.now();
console.log(`${sampleSize} pairs in ${(t1 - t0).toFixed(0)}ms = ${((t1 - t0) / sampleSize).toFixed(2)}ms/pair`);
console.log(`equal=${equalCount} diff=${diffCount} err=${errCount} totalBytes=${(totalBytes / 1e6).toFixed(0)}MB`);
console.log(`scaled to 33k pairs: ${(((33053 / sampleSize) * (t1 - t0)) / 1000).toFixed(1)}s`);
