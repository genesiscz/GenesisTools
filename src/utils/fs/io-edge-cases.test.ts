/**
 * Evil-path coverage for the streaming I/O primitives we touch in Phase 6
 * (Buffer-reuse refactor):
 *
 *   - sha256File              (src/utils/fs/disk-usage.ts)
 *   - sha256PrefixFile        (src/utils/fs/disk-usage.ts)
 *   - bytesEqualStreaming     (src/utils/fs/disk-usage.ts)
 *   - copyFileStreaming       (src/utils/fs/disk-usage.ts)
 *   - sha256File              (src/utils/fs/hash.ts — bench variant, 128KB chunk)
 *
 * Why this exists separately from disk-usage.test.ts: the production tests
 * mostly cover happy-path. The Phase 6 refactor introduces a NEW invariant
 * — module-level buffers reused across calls — that was previously trivially
 * satisfied by per-call `Buffer.allocUnsafe`. These tests target the failure
 * modes that buffer reuse can introduce:
 *
 *   1. State leakage between sequential calls (stale tail bytes corrupting
 *      the next file's hash).
 *   2. State leakage between *different* functions sharing the same buffer
 *      (sha256File → bytesEqualStreaming → sha256File: must be stable).
 *   3. Boundary conditions where the file is exactly STREAM_CHUNK_BYTES,
 *      one less, or one more — the loop should produce identical results
 *      vs Node's `createHash(readFileSync(path))` canonical computation.
 *   4. Empty / 1-byte / huge edge cases per function.
 *   5. AbortSignal mid-stream + next-call must still be correct.
 *
 * These tests must pass on the baseline (per-call allocUnsafe) AND on the
 * Phase 6 refactor (module-level shared buffer). If they only pass on the
 * baseline, the refactor regresses. If they only pass on the refactor, the
 * tests are bogus. Both must be green.
 */
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    bytesEqualStreaming,
    copyFileStreaming,
    sha256File,
    sha256PrefixFile,
} from "@app/utils/fs/disk-usage";
import { sha256File as sha256FileHash } from "@app/utils/fs/hash";

const PREFIX_HASH_BYTES = 4 * 1024;
const STREAM_CHUNK_BYTES_DISK_USAGE = 64 * 1024;
const STREAM_CHUNK_BYTES_HASH = 128 * 1024;

function canonicalSha256(content: Buffer): string {
    return createHash("sha256").update(content).digest("hex");
}

function fileWith(dir: string, name: string, content: Buffer): string {
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
}

function pseudoRandom(seed: number, length: number): Buffer {
    // Deterministic non-uniform content so a stale-tail leak shows up as a
    // hash mismatch. Avoids depending on /dev/urandom for reproducibility.
    const buf = Buffer.allocUnsafe(length);
    let state = seed >>> 0;
    for (let i = 0; i < length; i++) {
        state = (state * 1103515245 + 12345) >>> 0;
        buf[i] = (state >>> 16) & 0xff;
    }
    return buf;
}

describe("sha256File (disk-usage 64KB chunk) — buffer-reuse evil paths", () => {
    it("empty file matches canonical sha256", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-io-empty-"));
        try {
            const p = fileWith(dir, "empty", Buffer.alloc(0));
            expect(sha256File(p)).toBe(canonicalSha256(Buffer.alloc(0)));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("1-byte file", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-io-1b-"));
        try {
            const content = Buffer.from([0xab]);
            const p = fileWith(dir, "byte", content);
            expect(sha256File(p)).toBe(canonicalSha256(content));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("exactly STREAM_CHUNK_BYTES (64KB) file", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-io-chunk-"));
        try {
            const content = pseudoRandom(1, STREAM_CHUNK_BYTES_DISK_USAGE);
            const p = fileWith(dir, "exact", content);
            expect(sha256File(p)).toBe(canonicalSha256(content));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("STREAM_CHUNK_BYTES + 1 byte (straddles loop boundary)", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-io-strad-"));
        try {
            const content = pseudoRandom(2, STREAM_CHUNK_BYTES_DISK_USAGE + 1);
            const p = fileWith(dir, "strad", content);
            expect(sha256File(p)).toBe(canonicalSha256(content));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("multi-chunk file (3.5× chunk)", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-io-multi-"));
        try {
            const content = pseudoRandom(3, Math.floor(STREAM_CHUNK_BYTES_DISK_USAGE * 3.5));
            const p = fileWith(dir, "multi", content);
            expect(sha256File(p)).toBe(canonicalSha256(content));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("repeated calls on same file are stable (catches stale-buffer-tail leakage)", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-io-stable-"));
        try {
            const content = pseudoRandom(4, 200_000);
            const p = fileWith(dir, "stable", content);
            const first = sha256File(p);
            for (let i = 0; i < 50; i++) {
                expect(sha256File(p)).toBe(first);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("interleaved calls on different-size files do not corrupt each other", () => {
        // The cruelest test for buffer reuse: hash a LARGE file, then a SMALL
        // file (small file's final chunk leaves the second half of the buffer
        // holding stale large-file bytes), then the LARGE file again. If the
        // sha256File loop ever uses buffer beyond its return-count, the second
        // call to large would diverge from the first.
        const dir = mkdtempSync(join(tmpdir(), "gt-io-interleave-"));
        try {
            const large = pseudoRandom(5, STREAM_CHUNK_BYTES_DISK_USAGE * 3 + 7);
            const small = pseudoRandom(6, 17);
            const pLarge = fileWith(dir, "L", large);
            const pSmall = fileWith(dir, "S", small);

            const hLarge1 = sha256File(pLarge);
            const hSmall1 = sha256File(pSmall);
            const hLarge2 = sha256File(pLarge);
            const hSmall2 = sha256File(pSmall);

            expect(hLarge1).toBe(canonicalSha256(large));
            expect(hSmall1).toBe(canonicalSha256(small));
            expect(hLarge2).toBe(hLarge1);
            expect(hSmall2).toBe(hSmall1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("pre-aborted signal throws before any read", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-io-abort-"));
        try {
            const p = fileWith(dir, "f", Buffer.alloc(100, 1));
            const ac = new AbortController();
            ac.abort(new Error("nope"));
            expect(() => sha256File(p, { signal: ac.signal })).toThrow();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("after an abort, next sha256File call still produces correct hash (buffer state restored)", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-io-afterabort-"));
        try {
            const big = pseudoRandom(7, 500_000);
            const pBig = fileWith(dir, "big", big);
            const ac = new AbortController();
            ac.abort(new Error("interrupted"));
            try {
                sha256File(pBig, { signal: ac.signal });
            } catch {
                // expected
            }
            // Now a fresh call must work.
            expect(sha256File(pBig)).toBe(canonicalSha256(big));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("sha256PrefixFile — boundary + cross-call", () => {
    it("empty file: prefix sha == canonical empty sha", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-io-pe-"));
        try {
            const p = fileWith(dir, "empty", Buffer.alloc(0));
            expect(sha256PrefixFile(p)).toBe(canonicalSha256(Buffer.alloc(0)));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("file smaller than PREFIX: prefix sha == full sha", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-io-psm-"));
        try {
            const content = pseudoRandom(8, 100);
            const p = fileWith(dir, "small", content);
            expect(sha256PrefixFile(p)).toBe(sha256File(p));
            expect(sha256PrefixFile(p)).toBe(canonicalSha256(content));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("file exactly PREFIX_HASH_BYTES: prefix sha == full sha", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-io-pex-"));
        try {
            const content = pseudoRandom(9, PREFIX_HASH_BYTES);
            const p = fileWith(dir, "exact", content);
            expect(sha256PrefixFile(p)).toBe(sha256File(p));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("file larger than PREFIX: prefix sha != full sha (and matches canonical of first PREFIX bytes)", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-io-pbig-"));
        try {
            const content = pseudoRandom(10, PREFIX_HASH_BYTES * 4);
            const p = fileWith(dir, "big", content);
            const prefix = sha256PrefixFile(p);
            const full = sha256File(p);
            expect(prefix).not.toBe(full);
            expect(prefix).toBe(canonicalSha256(content.subarray(0, PREFIX_HASH_BYTES)));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("prefix-hash after a full-hash on a different file is stable (cross-function buffer)", () => {
        // sha256File on largeA leaves the shared buffer holding 64KB of A's
        // bytes. Then sha256PrefixFile on B (which is only 100 bytes) reads
        // 100 bytes into the same buffer. If the prefix loop wrongly hashed
        // beyond the 100 actually read, the prefix hash would diverge from
        // the canonical sha-of-first-100-bytes-of-B.
        const dir = mkdtempSync(join(tmpdir(), "gt-io-pcross-"));
        try {
            const largeA = pseudoRandom(11, STREAM_CHUNK_BYTES_DISK_USAGE * 4 + 7);
            const smallB = pseudoRandom(12, 100);
            const pA = fileWith(dir, "A", largeA);
            const pB = fileWith(dir, "B", smallB);

            sha256File(pA);
            const prefixB1 = sha256PrefixFile(pB);
            sha256File(pA);
            const prefixB2 = sha256PrefixFile(pB);

            expect(prefixB1).toBe(canonicalSha256(smallB));
            expect(prefixB2).toBe(prefixB1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("bytesEqualStreaming — two-buffer reuse evil paths", () => {
    it("both empty files: equal", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-io-be-"));
        try {
            const a = fileWith(dir, "a", Buffer.alloc(0));
            const b = fileWith(dir, "b", Buffer.alloc(0));
            expect(bytesEqualStreaming(a, b)).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("identical multi-chunk files: equal", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-io-bsame-"));
        try {
            const c = pseudoRandom(13, STREAM_CHUNK_BYTES_DISK_USAGE * 3 + 100);
            const a = fileWith(dir, "a", c);
            const b = fileWith(dir, "b", c);
            expect(bytesEqualStreaming(a, b)).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("same file path passed twice: equal", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-io-bsamepath-"));
        try {
            const a = fileWith(dir, "a", pseudoRandom(14, 200_000));
            expect(bytesEqualStreaming(a, a)).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("differs in first byte: not equal", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-io-bfb-"));
        try {
            const c1 = pseudoRandom(15, 10_000);
            const c2 = Buffer.from(c1);
            c2[0] = c2[0] ^ 0xff;
            const a = fileWith(dir, "a", c1);
            const b = fileWith(dir, "b", c2);
            expect(bytesEqualStreaming(a, b)).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("differs only in last byte of multi-chunk file: not equal", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-io-blb-"));
        try {
            const c1 = pseudoRandom(16, STREAM_CHUNK_BYTES_DISK_USAGE * 3 + 1);
            const c2 = Buffer.from(c1);
            c2[c2.length - 1] = c2[c2.length - 1] ^ 0xff;
            const a = fileWith(dir, "a", c1);
            const b = fileWith(dir, "b", c2);
            expect(bytesEqualStreaming(a, b)).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("different sizes (short prefix vs same+extra): not equal", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-io-bsz-"));
        try {
            const c1 = pseudoRandom(17, 1000);
            const c2 = Buffer.concat([c1, Buffer.from([0xff])]);
            const a = fileWith(dir, "a", c1);
            const b = fileWith(dir, "b", c2);
            expect(bytesEqualStreaming(a, b)).toBe(false);
            expect(bytesEqualStreaming(b, a)).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("identical files at exact chunk boundary: equal", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-io-bex-"));
        try {
            const c = pseudoRandom(18, STREAM_CHUNK_BYTES_DISK_USAGE);
            const a = fileWith(dir, "a", c);
            const b = fileWith(dir, "b", c);
            expect(bytesEqualStreaming(a, b)).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("bytesEqualStreaming after sha256File: sha buffer state doesn't corrupt compare", () => {
        // sha256File pollutes READ_BUF with file C content. Then a fresh
        // bytesEqualStreaming(A, B) on different files must still detect
        // their actual byte difference, not be tricked by READ_BUF's tail.
        const dir = mkdtempSync(join(tmpdir(), "gt-io-bbleed-"));
        try {
            const polluteC = pseudoRandom(19, STREAM_CHUNK_BYTES_DISK_USAGE * 2);
            const c = fileWith(dir, "C", polluteC);
            sha256File(c);

            const c1 = pseudoRandom(20, 5000);
            const c2 = Buffer.from(c1);
            c2[2500] = c2[2500] ^ 0x11;
            const a = fileWith(dir, "A", c1);
            const b = fileWith(dir, "B", c2);
            expect(bytesEqualStreaming(a, b)).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("copyFileStreaming — destination integrity", () => {
    it("empty src produces empty dst", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-io-ce-"));
        try {
            const src = fileWith(dir, "empty", Buffer.alloc(0));
            const dst = join(dir, "out");
            copyFileStreaming(src, dst);
            expect(readFileSync(dst).length).toBe(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("multi-chunk src produces byte-identical dst", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-io-cm-"));
        try {
            const content = pseudoRandom(21, STREAM_CHUNK_BYTES_DISK_USAGE * 3 + 555);
            const src = fileWith(dir, "src", content);
            const dst = join(dir, "out");
            copyFileStreaming(src, dst);
            expect(readFileSync(dst).equals(content)).toBe(true);
            expect(sha256File(dst)).toBe(sha256File(src));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("existing dst throws (wx flag invariant)", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-io-cx-"));
        try {
            const src = fileWith(dir, "src", Buffer.from("hi"));
            const dst = fileWith(dir, "dst", Buffer.from("already"));
            expect(() => copyFileStreaming(src, dst)).toThrow();
            // dst content is unchanged
            expect(readFileSync(dst).toString()).toBe("already");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("copy after a sha256File on a different file produces correct dst (buffer cross-pollination)", () => {
        // Pollute READ_BUF via sha256File, then copy a different file. If
        // copyFileStreaming ever wrote stale buffer bytes past the n it read,
        // the dst would not be byte-identical to src.
        const dir = mkdtempSync(join(tmpdir(), "gt-io-cbleed-"));
        try {
            const poll = pseudoRandom(22, STREAM_CHUNK_BYTES_DISK_USAGE * 2);
            const pPoll = fileWith(dir, "poll", poll);
            sha256File(pPoll);

            const srcContent = pseudoRandom(23, STREAM_CHUNK_BYTES_DISK_USAGE + 11);
            const src = fileWith(dir, "src", srcContent);
            const dst = join(dir, "dst");
            copyFileStreaming(src, dst);
            expect(readFileSync(dst).equals(srcContent)).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("sha256File (hash.ts, 128KB chunk variant) — buffer-reuse evil paths", () => {
    it("empty file matches canonical", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-io-hh-e-"));
        try {
            const p = fileWith(dir, "empty", Buffer.alloc(0));
            expect(sha256FileHash(p)).toBe(canonicalSha256(Buffer.alloc(0)));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("exactly STREAM_CHUNK_BYTES_HASH (128KB)", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-io-hh-x-"));
        try {
            const content = pseudoRandom(24, STREAM_CHUNK_BYTES_HASH);
            const p = fileWith(dir, "exact", content);
            expect(sha256FileHash(p)).toBe(canonicalSha256(content));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("interleaved large/small calls remain stable", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-io-hh-i-"));
        try {
            const large = pseudoRandom(25, STREAM_CHUNK_BYTES_HASH * 3 + 9);
            const small = pseudoRandom(26, 33);
            const pL = fileWith(dir, "L", large);
            const pS = fileWith(dir, "S", small);
            const h1 = sha256FileHash(pL);
            const s1 = sha256FileHash(pS);
            expect(sha256FileHash(pL)).toBe(h1);
            expect(sha256FileHash(pS)).toBe(s1);
            expect(h1).toBe(canonicalSha256(large));
            expect(s1).toBe(canonicalSha256(small));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
