/**
 * Microbench: instrumented findDuplicateFiles, breaks down warm hash phase
 * into pre-filter (getCloneId loop) vs sha-check (cached, should be 0) vs
 * byte-compare vs scheduler-overhead.
 */
import { performance } from "node:perf_hooks";
import { findDuplicateFiles, emptyFindDuplicatesStats } from "/Users/Martin/Tresors/Projects/GenesisTools-dupperf/src/utils/fs/disk-usage";
import { FileMetaCache } from "/Users/Martin/Tresors/Projects/GenesisTools-dupperf/src/macos/lib/clones/file-meta-cache";

const root = process.argv[2] ?? "/Users/Martin/Tresors/Projects/GenesisTools";

// Reuse the shipping singleton
const cache = FileMetaCache.getInstance();
await cache.loadScope(root);
console.log("Cache size loaded:", cache.size());

const stats = emptyFindDuplicatesStats();
const t0 = performance.now();
const groups = await findDuplicateFiles(root, { stats, cache, minSize: 1 });
const t1 = performance.now();
console.log(`findDuplicateFiles: ${groups.length} groups in ${(t1 - t0).toFixed(0)}ms`);
console.log("Stats:", JSON.stringify(stats, null, 2));

cache.close();
