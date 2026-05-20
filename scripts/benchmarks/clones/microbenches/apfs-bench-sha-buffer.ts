import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { performance } from "node:perf_hooks";

function sha256WithChunk(path: string, chunkSize: number): { sha: string; ms: number } {
    const start = performance.now();
    const h = createHash("sha256");
    const fd = openSync(path, "r");
    try {
        const buf = Buffer.allocUnsafe(chunkSize);
        for (;;) {
            const n = readSync(fd, buf, 0, buf.length, null);
            if (n <= 0) break;
            h.update(buf.subarray(0, n));
        }
    } finally {
        closeSync(fd);
    }
    return { sha: h.digest("hex"), ms: performance.now() - start };
}

const filesArg = process.argv.slice(2);
if (filesArg.length === 0) {
    console.error("usage: bun /tmp/apfs-bench-sha-buffer.ts <files...>");
    process.exit(1);
}

const CHUNK_SIZES = [
    64 * 1024,
    128 * 1024,
    256 * 1024,
    512 * 1024,
    1024 * 1024,
    2 * 1024 * 1024,
    4 * 1024 * 1024,
];

// Pre-warm the page cache by reading every file once
for (const p of filesArg) {
    readFileSync(p);
}

const RUNS = 4;
const results = new Map<number, { totalMs: number; totalBytes: number }>();
for (const chunk of CHUNK_SIZES) {
    let totalMs = 0;
    let totalBytes = 0;
    let lastSha = "";
    for (let r = 0; r < RUNS; r++) {
        for (const p of filesArg) {
            const size = statSync(p).size;
            const res = sha256WithChunk(p, chunk);
            totalMs += res.ms;
            totalBytes += size;
            lastSha = res.sha;
        }
    }
    results.set(chunk, { totalMs, totalBytes });
    console.log(
        `chunk=${(chunk / 1024).toFixed(0)}KiB totalMs=${totalMs.toFixed(1)} bytes=${totalBytes} mb/s=${((totalBytes / 1e6) / (totalMs / 1000)).toFixed(1)} sha=${lastSha.slice(0, 8)}…`
    );
}

console.log("");
console.log("Files:", filesArg.length, "Runs:", RUNS);
const sizes = filesArg.map((p) => statSync(p).size);
console.log(
    "Total per run:",
    (sizes.reduce((s, x) => s + x, 0) / 1e6).toFixed(1),
    "MB across",
    filesArg.length,
    "files; min/avg/max size:",
    Math.min(...sizes),
    Math.round(sizes.reduce((s, x) => s + x, 0) / sizes.length),
    Math.max(...sizes)
);
