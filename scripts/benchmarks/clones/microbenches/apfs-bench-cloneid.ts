/**
 * Microbench: getCloneId throughput on a real directory.
 * Used to estimate the warm-hash residual cost from cloneIdCalls=139741.
 */
import { performance } from "node:perf_hooks";
import { getCloneId } from "/Users/Martin/Tresors/Projects/GenesisTools-dupperf/src/utils/macos/apfs";
import { walkFiles } from "/Users/Martin/Tresors/Projects/GenesisTools-dupperf/src/utils/fs/disk-usage";

const root = process.argv[2] ?? "/Users/Martin/Tresors/Projects/GenesisTools";
console.log("Root:", root);

// Walk + collect paths first (separate from getCloneId timing).
const t0 = performance.now();
const paths: string[] = [];
for (const e of walkFiles(root)) {
    paths.push(e.path);
}
const t1 = performance.now();
console.log(`walked: ${paths.length} files in ${(t1 - t0).toFixed(1)}ms (${((paths.length / (t1 - t0)) * 1000).toFixed(0)} files/sec)`);

// Now time JUST getCloneId on all of them.
const t2 = performance.now();
let nullCount = 0;
let zeroCount = 0;
let realCount = 0;
for (const p of paths) {
    const id = getCloneId(p);
    if (id === null) nullCount += 1;
    else if (id === 0n) zeroCount += 1;
    else realCount += 1;
}
const t3 = performance.now();
console.log(
    `getCloneId: ${paths.length} calls in ${(t3 - t2).toFixed(1)}ms (${((paths.length / (t3 - t2)) * 1000).toFixed(0)}/sec); per-call=${(((t3 - t2) * 1000) / paths.length).toFixed(1)}μs`
);
console.log(`  null=${nullCount} zero=${zeroCount} real=${realCount}`);

// Second pass — warm; the kernel inode cache should be hot.
const t4 = performance.now();
for (const p of paths) {
    getCloneId(p);
}
const t5 = performance.now();
console.log(
    `getCloneId (warm): ${paths.length} calls in ${(t5 - t4).toFixed(1)}ms (${((paths.length / (t5 - t4)) * 1000).toFixed(0)}/sec); per-call=${(((t5 - t4) * 1000) / paths.length).toFixed(1)}μs`
);
