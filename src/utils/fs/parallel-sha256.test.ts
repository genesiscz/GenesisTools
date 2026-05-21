/**
 * Evil-path coverage for `sha256FilesParallel`. The pool dispatches reads
 * across libuv's thread pool with bounded concurrency; the failure modes
 * we care about are:
 *
 *   1. Per-file results must match canonical sha256 — buffer reuse within
 *      one worker must not leak across files.
 *   2. Buffer reuse ACROSS workers must not leak — each worker has its
 *      own buffer (we tested this fact in `parallel-sha256.ts`; this test
 *      checks the empirical outcome).
 *   3. One file failing must NOT poison other files' results — the
 *      bucket loop in findDuplicateFiles assumes per-file isolation.
 *   4. AbortSignal must stop in-flight workers and prevent new starts.
 *   5. Concurrency=1 must produce identical results to concurrency=N
 *      (proves the parallel path doesn't trade correctness for speed).
 *   6. Empty input + single-input fast paths must work.
 */
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256FilesParallel } from "@app/utils/fs/parallel-sha256";

function canonicalSha256(content: Buffer): string {
    return createHash("sha256").update(content).digest("hex");
}

function pseudoRandom(seed: number, length: number): Buffer {
    const buf = Buffer.allocUnsafe(length);
    let state = seed >>> 0;
    for (let i = 0; i < length; i++) {
        state = (state * 1103515245 + 12345) >>> 0;
        buf[i] = (state >>> 16) & 0xff;
    }
    return buf;
}

describe("sha256FilesParallel — evil paths", () => {
    it("empty input returns empty result", async () => {
        const { shas, errors } = await sha256FilesParallel([]);
        expect(shas.size).toBe(0);
        expect(errors.size).toBe(0);
    });

    it("single file: returns single sha, no errors", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-psha-single-"));
        try {
            const p = join(dir, "f");
            const content = Buffer.from("hello\n");
            writeFileSync(p, content);
            const { shas, errors } = await sha256FilesParallel([p]);
            expect(shas.get(p)).toBe(canonicalSha256(content));
            expect(errors.size).toBe(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("many files: each sha matches canonical", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-psha-many-"));
        try {
            const paths: string[] = [];
            const expected = new Map<string, string>();
            for (let i = 0; i < 50; i++) {
                const p = join(dir, `f-${i}`);
                const content = pseudoRandom(i + 1, 1000 + i * 47);
                writeFileSync(p, content);
                paths.push(p);
                expected.set(p, canonicalSha256(content));
            }

            const { shas, errors } = await sha256FilesParallel(paths, { concurrency: 8 });
            expect(errors.size).toBe(0);
            expect(shas.size).toBe(paths.length);
            for (const p of paths) {
                expect(shas.get(p)).toBe(expected.get(p));
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("mixed-size files: large + small interleaved, all correct (buffer reuse stress)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-psha-mix-"));
        try {
            const sizes = [50_000, 17, 200_000, 5, 64_000, 1_000_000, 1, 33_000, 7_777];
            const paths: string[] = [];
            const expected = new Map<string, string>();
            for (let i = 0; i < sizes.length; i++) {
                const p = join(dir, `mix-${i}`);
                const content = pseudoRandom(100 + i, sizes[i]);
                writeFileSync(p, content);
                paths.push(p);
                expected.set(p, canonicalSha256(content));
            }

            const { shas, errors } = await sha256FilesParallel(paths, { concurrency: 4 });
            expect(errors.size).toBe(0);
            for (const p of paths) {
                expect(shas.get(p)).toBe(expected.get(p));
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("missing file in batch: error recorded, other files still complete", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-psha-err-"));
        try {
            const good1 = join(dir, "good1");
            const good2 = join(dir, "good2");
            const missing = join(dir, "this-does-not-exist");
            writeFileSync(good1, "AAA");
            writeFileSync(good2, "BBB");

            const { shas, errors } = await sha256FilesParallel([good1, missing, good2], { concurrency: 4 });
            expect(shas.get(good1)).toBe(canonicalSha256(Buffer.from("AAA")));
            expect(shas.get(good2)).toBe(canonicalSha256(Buffer.from("BBB")));
            expect(shas.has(missing)).toBe(false);
            expect(errors.has(missing)).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("concurrency=1 matches concurrency=8 result (parallel preserves correctness)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-psha-conc-"));
        try {
            const paths: string[] = [];
            for (let i = 0; i < 20; i++) {
                const p = join(dir, `f-${i}`);
                writeFileSync(p, pseudoRandom(i + 1, 1000 + i));
                paths.push(p);
            }

            const serial = await sha256FilesParallel(paths, { concurrency: 1 });
            const parallel = await sha256FilesParallel(paths, { concurrency: 8 });
            expect(serial.shas.size).toBe(20);
            expect(parallel.shas.size).toBe(20);
            for (const p of paths) {
                expect(parallel.shas.get(p)).toBe(serial.shas.get(p));
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("pre-aborted signal: returns empty (no work started)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-psha-abort-pre-"));
        try {
            const paths = ["a", "b", "c"].map((n) => {
                const p = join(dir, n);
                writeFileSync(p, "x");
                return p;
            });
            const ac = new AbortController();
            ac.abort(new Error("nope"));
            const { shas } = await sha256FilesParallel(paths, { signal: ac.signal });
            expect(shas.size).toBe(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("repeated call on same files is deterministic (no per-call state leak)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-psha-rep-"));
        try {
            const paths: string[] = [];
            for (let i = 0; i < 12; i++) {
                const p = join(dir, `f-${i}`);
                writeFileSync(p, pseudoRandom(i, 5000 + i * 13));
                paths.push(p);
            }

            const a = await sha256FilesParallel(paths, { concurrency: 4 });
            const b = await sha256FilesParallel(paths, { concurrency: 4 });
            const c = await sha256FilesParallel(paths, { concurrency: 4 });
            for (const p of paths) {
                expect(a.shas.get(p)).toBe(b.shas.get(p));
                expect(b.shas.get(p)).toBe(c.shas.get(p));
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("empty file in batch: hash is canonical empty-sha", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-psha-empty-"));
        try {
            const e = join(dir, "empty");
            const ne = join(dir, "ne");
            writeFileSync(e, Buffer.alloc(0));
            writeFileSync(ne, "X");
            const { shas } = await sha256FilesParallel([e, ne], { concurrency: 2 });
            expect(shas.get(e)).toBe(canonicalSha256(Buffer.alloc(0)));
            expect(shas.get(ne)).toBe(canonicalSha256(Buffer.from("X")));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("more paths than concurrency: queue drains all", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-psha-many2-"));
        try {
            const paths: string[] = [];
            for (let i = 0; i < 100; i++) {
                const p = join(dir, `f-${i}`);
                writeFileSync(p, pseudoRandom(i + 200, 500));
                paths.push(p);
            }
            const { shas } = await sha256FilesParallel(paths, { concurrency: 3 });
            expect(shas.size).toBe(100);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
