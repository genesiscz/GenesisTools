import { performance } from "node:perf_hooks";

function yieldToLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

const YIELD_EVERY_BUCKETS = 64;
const totalBuckets = 19422;
const t0 = performance.now();
let count = 0;
for (let bucketIndex = 0; bucketIndex < totalBuckets; bucketIndex++) {
    if ((bucketIndex & (YIELD_EVERY_BUCKETS - 1)) === 0) {
        await yieldToLoop();
        count += 1;
    }
}
const t1 = performance.now();
console.log(`${count} yieldToLoops in ${(t1 - t0).toFixed(1)}ms, per-yield=${((t1 - t0) / count).toFixed(2)}ms`);
