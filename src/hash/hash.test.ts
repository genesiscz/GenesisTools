import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALGOS, createHasher, type HashAlgo } from "./lib/algorithms";
import {
    type ChecksumEntry,
    formatChecksumLine,
    parseChecksumFile,
    summarizeVerify,
    type VerifyResult,
} from "./lib/checksum-file";
import { hashBuffer, hashChunks } from "./lib/hash-stream";

describe("algorithms", () => {
    it("ALGOS lists exactly the five supported algorithms", () => {
        expect([...ALGOS]).toEqual(["md5", "sha1", "sha256", "sha512", "blake3"]);
    });

    it("createHasher returns a usable hasher for each algo", async () => {
        for (const algo of ALGOS) {
            const hasher = await createHasher(algo);
            hasher.init();
            hasher.update("abc");
            const hex = hasher.digest("hex");
            expect(typeof hex).toBe("string");
            expect(hex.length).toBeGreaterThan(0);
        }
    });
});

const KNOWN_ABC: Record<HashAlgo, string> = {
    md5: "900150983cd24fb0d6963f7d28e17f72",
    sha1: "a9993e364706816aba3e25717850c26c9cd0d89d",
    sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    sha512:
        "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a" +
        "2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
    blake3: "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85",
};

describe("hashBuffer (known vectors for 'abc')", () => {
    for (const [algo, expected] of Object.entries(KNOWN_ABC)) {
        it(`${algo}("abc") matches the published digest`, async () => {
            const hex = await hashBuffer(algo as HashAlgo, new TextEncoder().encode("abc"));
            expect(hex).toBe(expected);
        });
    }
});

describe("hashChunks streaming", () => {
    it("produces the same digest whether fed in one chunk or many", async () => {
        const data = new TextEncoder().encode("the quick brown fox jumps over the lazy dog");
        const oneShot = await hashChunks({ algo: "sha256", chunks: [data] });

        const small: Uint8Array[] = [];
        for (let i = 0; i < data.length; i += 3) {
            small.push(data.subarray(i, i + 3));
        }
        const chunked = await hashChunks({ algo: "sha256", chunks: small });

        expect(chunked).toBe(oneShot);
    });

    it("hashes an empty stream to the algorithm's empty-input digest", async () => {
        const empty = await hashChunks({ algo: "sha256", chunks: [] });
        expect(empty).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    });

    it("accepts an async iterable of chunks", async () => {
        async function* gen(): AsyncGenerator<Uint8Array> {
            yield new TextEncoder().encode("ab");
            yield new TextEncoder().encode("c");
        }

        const hex = await hashChunks({ algo: "sha256", chunks: gen() });
        expect(hex).toBe(KNOWN_ABC.sha256);
    });
});

describe("formatChecksumLine", () => {
    it("emits coreutils '<hex>  <path>' with exactly two spaces", () => {
        expect(formatChecksumLine("deadbeef", "a.txt")).toBe("deadbeef  a.txt");
    });
});

describe("parseChecksumFile", () => {
    it("parses standard two-space lines", () => {
        const entries = parseChecksumFile("deadbeef  a.txt\ncafef00d  sub/b.txt\n");
        expect(entries).toEqual([
            { hex: "deadbeef", path: "a.txt" },
            { hex: "cafef00d", path: "sub/b.txt" },
        ]);
    });

    it("skips blank lines and '#' comments", () => {
        const entries = parseChecksumFile("# header\n\ndeadbeef  a.txt\n\n");
        expect(entries).toEqual([{ hex: "deadbeef", path: "a.txt" }]);
    });

    it("tolerates a single space and the GNU '*' binary marker", () => {
        const entries = parseChecksumFile("deadbeef a.txt\ncafef00d *bin.dat\n");
        expect(entries).toEqual([
            { hex: "deadbeef", path: "a.txt" },
            { hex: "cafef00d", path: "bin.dat" },
        ]);
    });

    it("preserves spaces inside the path", () => {
        const entries = parseChecksumFile("deadbeef  my file.txt\n");
        expect(entries).toEqual([{ hex: "deadbeef", path: "my file.txt" }]);
    });

    it("lowercases uppercase hex", () => {
        const entries = parseChecksumFile("DEADBEEF  a.txt\n");
        expect(entries).toEqual([{ hex: "deadbeef", path: "a.txt" }]);
    });
});

describe("summarizeVerify", () => {
    it("counts total and failed", () => {
        const results: VerifyResult[] = [
            { path: "a", ok: true },
            { path: "b", ok: false },
            { path: "c", ok: false, unreadable: true },
        ];
        expect(summarizeVerify(results)).toEqual({ total: 3, failed: 2 });
    });
});

async function verifyEntries(dir: string, algo: HashAlgo, entries: ChecksumEntry[]): Promise<VerifyResult[]> {
    const results: VerifyResult[] = [];
    for (const entry of entries) {
        try {
            const bytes = new Uint8Array(await Bun.file(join(dir, entry.path)).arrayBuffer());
            const actual = await hashBuffer(algo, bytes);
            results.push({ path: entry.path, ok: actual === entry.hex });
        } catch {
            results.push({ path: entry.path, ok: false, unreadable: true });
        }
    }

    return results;
}

describe("end-to-end verify against tmp files", () => {
    it("reports OK for matching files and FAILED for tampered/missing ones", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-hash-"));
        try {
            writeFileSync(join(dir, "a.txt"), "alpha");
            writeFileSync(join(dir, "b.txt"), "bravo");

            const hexA = await hashBuffer("sha256", new TextEncoder().encode("alpha"));
            const hexB = await hashBuffer("sha256", new TextEncoder().encode("bravo"));

            const checksumText =
                `${formatChecksumLine(hexA, "a.txt")}\n` +
                `${formatChecksumLine("0".repeat(hexB.length), "b.txt")}\n` +
                `${formatChecksumLine(hexA, "c.txt")}\n`;

            const entries = parseChecksumFile(checksumText);
            const results = await verifyEntries(dir, "sha256", entries);

            expect(results.find((r) => r.path === "a.txt")?.ok).toBe(true);
            expect(results.find((r) => r.path === "b.txt")?.ok).toBe(false);
            const cResult = results.find((r) => r.path === "c.txt");
            expect(cResult?.ok).toBe(false);
            expect(cResult?.unreadable).toBe(true);

            const summary = summarizeVerify(results);
            expect(summary).toEqual({ total: 3, failed: 2 });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
