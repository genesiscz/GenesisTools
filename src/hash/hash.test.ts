import { afterAll, beforeAll, describe, expect, it, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALGOS, algoForHexLength, algoForTag, createHasher, type HashAlgo, HEX_LENGTH } from "./lib/algorithms";
import { formatChecksumLine, parseChecksumFile, parseChecksumLines } from "./lib/checksum-file";
import { describeReadError, hashBuffer, hashChunks, hashFile } from "./lib/hash-stream";
import { expandInputs } from "./lib/inputs";
import { type VerifyOptions, verifyChecksums } from "./lib/verify";

const INDEX = join(import.meta.dir, "index.ts");
const encode = (text: string) => new TextEncoder().encode(text);

describe("algorithms", () => {
    it("ALGOS lists exactly the five supported algorithms", () => {
        expect([...ALGOS]).toEqual(["md5", "sha1", "sha256", "sha512", "blake3"]);
    });

    it("createHasher returns a usable hasher for each algo, with a digest of the declared length", async () => {
        for (const algo of ALGOS) {
            const hasher = await createHasher(algo);
            hasher.update(encode("abc"));
            expect(hasher.digestHex()).toHaveLength(HEX_LENGTH[algo]);
        }
    });

    it("infers an algorithm from a digest length, calling 64 digits sha256 because blake3 shares it", () => {
        expect(algoForHexLength(32)).toBe("md5");
        expect(algoForHexLength(40)).toBe("sha1");
        expect(algoForHexLength(64)).toBe("sha256");
        expect(algoForHexLength(128)).toBe("sha512");
        expect(algoForHexLength(56)).toBeUndefined();
    });

    it("reads the algorithm out of a BSD tag, in any letter case", () => {
        expect(algoForTag("SHA256")).toBe("sha256");
        expect(algoForTag("md5")).toBe("md5");
        expect(algoForTag("BLAKE3")).toBe("blake3");
        expect(algoForTag("SHA3")).toBeUndefined();
    });
});

const ABC: Record<HashAlgo, string> = {
    md5: "900150983cd24fb0d6963f7d28e17f72",
    sha1: "a9993e364706816aba3e25717850c26c9cd0d89d",
    sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    sha512:
        "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a" +
        "2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
    // The BLAKE3 repository's test_vectors.json holds no "abc" case (its inputs are a repeating byte pattern).
    // This digest is the same in the Rust blake3 crate, the cryptopp-modern docs and hash-wasm.
    blake3: "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85",
};

const EMPTY: Record<HashAlgo, string> = {
    md5: "d41d8cd98f00b204e9800998ecf8427e",
    sha1: "da39a3ee5e6b4b0d3255bfef95601890afd80709",
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    sha512:
        "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce" +
        "47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e",
    // BLAKE3 test_vectors.json (github.com/BLAKE3-team/BLAKE3), case input_len 0, first 32 bytes of the hash.
    blake3: "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262",
};

describe("known digests", () => {
    for (const algo of ALGOS) {
        it(`${algo}("abc") matches the published digest`, async () => {
            expect(await hashBuffer(algo, encode("abc"))).toBe(ABC[algo]);
        });

        it(`${algo}("") matches the published digest`, async () => {
            expect(await hashBuffer(algo, new Uint8Array(0))).toBe(EMPTY[algo]);
        });
    }
});

// BLAKE3 test_vectors.json (github.com/BLAKE3-team/BLAKE3, test_vectors/test_vectors.json), plain-hash output, first
// 32 bytes. Every input is the byte sequence 0, 1, ..., 250 repeated to input_len bytes. The lengths straddle the
// 1024-byte chunk boundary and a multi-chunk tree, which is where a streaming mistake would show.
const BLAKE3_OFFICIAL: Array<[number, string]> = [
    [1, "2d3adedff11b61f14c886e35afa036736dcd87a74d27b5c1510225d0f592e213"],
    [1023, "10108970eeda3eb932baac1428c7a2163b0e924c9a9e25b35bba72b28f70bd11"],
    [1024, "42214739f095a406f3fc83deb889744ac00df831c10daa55189b5d121c855af7"],
    [1025, "d00278ae47eb27b34faecf67b4fe263f82d5412916c1ffd97c8cb7fb814b8444"],
    [2048, "e776b6028c7cd22a4d0ba182a8bf62205d2ef576467e838ed6f2529b85fba24a"],
    [2049, "5f4d72f40d7a5f82b15ca2b2e44b1de3c2ef86c426c95c1af0b6879522563030"],
    [8192, "aae792484c8efe4f19e2ca7d371d8c467ffb10748d8a5a1ae579948f718a2a63"],
    [102400, "bc3e3d41a1146b069abffad3c0d44860cf664390afce4d9661f7902e7943e085"],
];

function officialInput(length: number): Uint8Array {
    return Uint8Array.from({ length }, (_, index) => index % 251);
}

describe("blake3 against the official vectors", () => {
    for (const [length, expected] of BLAKE3_OFFICIAL) {
        it(`input_len ${length}, one chunk and fed in 700-byte pieces`, async () => {
            const data = officialInput(length);
            expect(await hashBuffer("blake3", data)).toBe(expected);

            const pieces: Uint8Array[] = [];
            for (let offset = 0; offset < data.length; offset += 700) {
                pieces.push(data.subarray(offset, offset + 700));
            }

            expect(await hashChunks({ algo: "blake3", chunks: pieces })).toBe(expected);
        });
    }
});

describe("hashChunks streaming", () => {
    it("produces the same digest whether fed in one chunk or many", async () => {
        const data = encode("the quick brown fox jumps over the lazy dog");
        const oneShot = await hashChunks({ algo: "sha256", chunks: [data] });

        const small: Uint8Array[] = [];
        for (let i = 0; i < data.length; i += 3) {
            small.push(data.subarray(i, i + 3));
        }

        expect(await hashChunks({ algo: "sha256", chunks: small })).toBe(oneShot);
    });

    it("hashes an empty stream to the algorithm's empty-input digest", async () => {
        expect(await hashChunks({ algo: "sha256", chunks: [] })).toBe(EMPTY.sha256);
    });

    it("accepts an async iterable of chunks", async () => {
        async function* gen(): AsyncGenerator<Uint8Array> {
            yield encode("ab");
            yield encode("c");
        }

        expect(await hashChunks({ algo: "sha256", chunks: gen() })).toBe(ABC.sha256);
    });
});

describe("hashFile", () => {
    const MIB = 1024 * 1024;
    let dir: string;

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), "gt-hash-file-"));
    });

    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    function randomBytes(length: number): Uint8Array {
        const bytes = new Uint8Array(length);
        for (let offset = 0; offset < length; offset += 65536) {
            crypto.getRandomValues(bytes.subarray(offset, Math.min(length, offset + 65536)));
        }

        return bytes;
    }

    // Sizes around the 1 MiB read buffer: empty, one byte, just under, exactly, just over, and several buffers.
    for (const size of [0, 1, MIB - 1, MIB, MIB + 1, 3 * MIB + 17]) {
        it(`matches an in-memory hash for a ${size}-byte file, for every algorithm`, async () => {
            const bytes = randomBytes(size);
            const path = join(dir, `sized-${size}.bin`);
            writeFileSync(path, bytes);

            for (const algo of ALGOS) {
                const reference =
                    algo === "blake3"
                        ? await hashBuffer("blake3", bytes)
                        : createHash(algo).update(bytes).digest("hex");
                expect(await hashFile(algo, path)).toBe(reference);
            }
        });
    }

    it("matches the official BLAKE3 vector when the file is read from disk", async () => {
        const [length, expected] = BLAKE3_OFFICIAL[BLAKE3_OFFICIAL.length - 1];
        const path = join(dir, "official.bin");
        writeFileSync(path, officialInput(length));
        expect(await hashFile("blake3", path)).toBe(expected);
    });

    it("rejects a missing file with ENOENT and a directory with EISDIR", async () => {
        await expect(hashFile("sha256", join(dir, "no-such-file"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(hashFile("sha256", dir)).rejects.toMatchObject({ code: "EISDIR" });
    });

    it("words read errors the way coreutils does", async () => {
        const missing = await hashFile("sha256", join(dir, "no-such-file")).catch((error: unknown) => error);
        expect(describeReadError(missing)).toBe("No such file or directory");
        expect(describeReadError(Object.assign(new Error("x"), { code: "EACCES" }))).toBe("Permission denied");
        expect(describeReadError(Object.assign(new Error("x"), { code: "EISDIR" }))).toBe("Is a directory");
        expect(describeReadError(new Error("disk on fire"))).toBe("disk on fire");
    });
});

describe("formatChecksumLine", () => {
    it("emits coreutils '<hex>  <path>' with exactly two spaces", () => {
        expect(formatChecksumLine("deadbeef", "a.txt")).toBe("deadbeef  a.txt");
        expect(formatChecksumLine("deadbeef", "my file.txt")).toBe("deadbeef  my file.txt");
    });

    it("escapes a backslash and a newline in the path and marks the line with a leading backslash", () => {
        expect(formatChecksumLine("deadbeef", "a\\b.txt")).toBe("\\deadbeef  a\\\\b.txt");
        expect(formatChecksumLine("deadbeef", "new\nline.txt")).toBe("\\deadbeef  new\\nline.txt");
    });
});

describe("parseChecksumFile", () => {
    it("parses standard two-space lines and records the line number", () => {
        expect(parseChecksumFile("deadbeef  a.txt\ncafef00d  sub/b.txt\n")).toEqual([
            { hex: "deadbeef", path: "a.txt", line: 1 },
            { hex: "cafef00d", path: "sub/b.txt", line: 2 },
        ]);
    });

    it("skips '#' comment lines at the start of a line, and counts a blank line as improper", () => {
        const parsed = parseChecksumLines("# header\n\ndeadbeef  a.txt\n");
        expect(parsed).toEqual([
            { kind: "improper", line: 2 },
            { kind: "entry", entry: { hex: "deadbeef", path: "a.txt", line: 3 } },
        ]);
    });

    it("reads the GNU '*' binary marker, and a tab as the separator", () => {
        expect(parseChecksumFile("deadbeef *bin.dat\ncafef00d\t*tab.dat\n")).toEqual([
            { hex: "deadbeef", path: "bin.dat", line: 1 },
            { hex: "cafef00d", path: "tab.dat", line: 2 },
        ]);
    });

    it("treats a path that starts with '*' in text mode as a path, not a marker", () => {
        expect(parseChecksumFile("deadbeef  *star.txt\n")).toEqual([{ hex: "deadbeef", path: "*star.txt", line: 1 }]);
    });

    it("rejects a single space before the path, as shasum -c does", () => {
        expect(parseChecksumLines("deadbeef a.txt\n")).toEqual([{ kind: "improper", line: 1 }]);
    });

    it("preserves spaces inside the path and lowercases uppercase hex", () => {
        expect(parseChecksumFile("DEADBEEF  my file.txt\n")).toEqual([
            { hex: "deadbeef", path: "my file.txt", line: 1 },
        ]);
    });

    it("keeps the carriage return of a CRLF file in the path, as shasum -c does", () => {
        expect(parseChecksumFile("deadbeef  a.txt\r\n")).toEqual([{ hex: "deadbeef", path: "a.txt\r", line: 1 }]);
    });

    it("parses the last line without a trailing newline", () => {
        expect(parseChecksumFile("deadbeef  a.txt")).toEqual([{ hex: "deadbeef", path: "a.txt", line: 1 }]);
    });

    it("unescapes a backslash-marked path", () => {
        expect(parseChecksumFile("\\deadbeef  a\\\\b\\nc.txt\n")).toEqual([
            { hex: "deadbeef", path: "a\\b\nc.txt", line: 1 },
        ]);
    });

    it("reads BSD tag lines with the algorithm they name, and rejects a tag with the wrong digest length", () => {
        const sha256 = "a".repeat(64);
        const parsed = parseChecksumLines(
            `SHA256 (a b.txt) = ${sha256}\nMD5 (x) = ${"b".repeat(64)}\nFOO (x) = ${sha256}\n`
        );
        expect(parsed).toEqual([
            { kind: "entry", entry: { hex: sha256, path: "a b.txt", line: 1, algo: "sha256" } },
            { kind: "improper", line: 2 },
            { kind: "improper", line: 3 },
        ]);
    });
});

describe("verifyChecksums, behaving as shasum -c does", () => {
    let dir: string;
    const sha = (algo: string, text: string) => createHash(algo).update(text).digest("hex");

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), "gt-hash-verify-"));
        writeFileSync(join(dir, "a.txt"), "alpha");
        writeFileSync(join(dir, "my file.txt"), "bravo");
        writeFileSync(join(dir, "empty.bin"), "");
        writeFileSync(join(dir, "a\\b.txt"), "backslash");
        mkdirSync(join(dir, "adir"));
    });

    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    async function verify(text: string, overrides: Partial<VerifyOptions> = {}) {
        const lines: string[] = [];
        const messages: string[] = [];
        const report = await verifyChecksums(text, {
            label: "list.sums",
            quiet: false,
            status: false,
            strict: false,
            warn: false,
            ignoreMissing: false,
            hashPath: (algo, path) => hashFile(algo, join(dir, path)),
            onLine: (line) => lines.push(line),
            onMessage: (message) => messages.push(message),
            ...overrides,
        });

        return { lines, messages, report };
    }

    const A = sha("sha256", "alpha");
    const B = sha("sha256", "bravo");
    const ZERO = "0".repeat(64);

    it("prints OK per file and exits 0 when everything matches, including an empty file and a path with spaces", async () => {
        const { lines, messages, report } = await verify(
            `${A}  a.txt\n${B}  my file.txt\n${sha("sha256", "")}  empty.bin\n`
        );
        expect(lines).toEqual(["a.txt: OK", "my file.txt: OK", "empty.bin: OK"]);
        expect(messages).toEqual([]);
        expect(report).toEqual({ exitCode: 0, checked: 3, ok: 3 });
    });

    it("accepts the '*' binary marker", async () => {
        const { lines, report } = await verify(`${A} *a.txt\n`);
        expect(lines).toEqual(["a.txt: OK"]);
        expect(report.exitCode).toBe(0);
    });

    it("reports a mismatch and a missing file, keeps going, and exits 1", async () => {
        const { lines, messages, report } = await verify(`${A}  a.txt\n${A}  nofile.txt\n${ZERO}  a.txt\n`);
        expect(lines).toEqual(["a.txt: OK", "nofile.txt: FAILED open or read", "a.txt: FAILED"]);
        expect(messages).toEqual([
            "hash: nofile.txt: No such file or directory",
            "hash: WARNING: 1 listed file could not be read",
            "hash: WARNING: 1 computed checksum did NOT match",
        ]);
        expect(report.exitCode).toBe(1);
    });

    it("counts a listed directory as a file that could not be read", async () => {
        const { lines, messages } = await verify(`${A}  adir\n`);
        expect(lines).toEqual(["adir: FAILED open or read"]);
        expect(messages[0]).toBe("hash: adir: Is a directory");
    });

    it("--quiet hides OK lines only", async () => {
        const { lines } = await verify(`${A}  a.txt\n${ZERO}  my file.txt\n`, { quiet: true });
        expect(lines).toEqual(["my file.txt: FAILED"]);
    });

    it("--status prints no result lines and no warning counts, but still names an unreadable file", async () => {
        const { lines, messages, report } = await verify(`${A}  a.txt\n${A}  nofile.txt\n`, { status: true });
        expect(lines).toEqual([]);
        expect(messages).toEqual(["hash: nofile.txt: No such file or directory"]);
        expect(report.exitCode).toBe(1);
    });

    it("--ignore-missing skips an absent file, and fails when nothing at all was verified", async () => {
        const some = await verify(`${A}  a.txt\n${A}  nofile.txt\n`, { ignoreMissing: true });
        expect(some.lines).toEqual(["a.txt: OK"]);
        expect(some.report.exitCode).toBe(0);

        const none = await verify(`${A}  nofile.txt\n`, { ignoreMissing: true });
        expect(none.lines).toEqual([]);
        expect(none.messages).toEqual(["hash: list.sums: no file was verified"]);
        expect(none.report.exitCode).toBe(1);
    });

    it("tolerates improperly formatted lines unless --strict, and names them with --warn", async () => {
        const text = `${A} a.txt\n# comment\n\n${A}  a.txt\n`;

        const quiet = await verify(text);
        expect(quiet.lines).toEqual(["a.txt: OK"]);
        expect(quiet.messages).toEqual(["hash: WARNING: 2 lines are improperly formatted"]);
        expect(quiet.report.exitCode).toBe(0);

        const warned = await verify(text, { warn: true });
        expect(warned.messages).toEqual([
            "hash: list.sums: 1: improperly formatted checksum line",
            "hash: list.sums: 3: improperly formatted checksum line",
            "hash: WARNING: 2 lines are improperly formatted",
        ]);

        const strict = await verify(text, { strict: true });
        expect(strict.report.exitCode).toBe(1);
    });

    it("exits 1 for a file with no properly formatted line, empty or not", async () => {
        for (const text of ["", "hello world\nnot a checksum\n"]) {
            const { lines, messages, report } = await verify(text);
            expect(lines).toEqual([]);
            expect(messages).toContain("hash: list.sums: no properly formatted checksum lines found");
            expect(report.exitCode).toBe(1);
        }
    });

    it("takes each line's algorithm from its digest length, so sha1, sha512 and sha256 can share a file", async () => {
        const { lines, report } = await verify(
            `${sha("sha1", "alpha")}  a.txt\n${B}  my file.txt\n${sha("sha512", "")}  empty.bin\n`
        );
        expect(lines).toEqual(["a.txt: OK", "my file.txt: OK", "empty.bin: OK"]);
        expect(report.exitCode).toBe(0);
    });

    it("with an explicit algorithm, calls a line of another digest length improperly formatted", async () => {
        const { messages, report } = await verify(`${sha("md5", "alpha")}  a.txt\n`, { algo: "sha256" });
        expect(messages).toEqual(["hash: list.sums: no properly formatted checksum lines found"]);
        expect(report.exitCode).toBe(1);
    });

    it("verifies 64 digits as blake3 only when asked, and a BSD tag names its own algorithm", async () => {
        const blake3 = await hashBuffer("blake3", encode("alpha"));
        const asSha256 = await verify(`${blake3}  a.txt\n`);
        expect(asSha256.lines).toEqual(["a.txt: FAILED"]);

        const asBlake3 = await verify(`${blake3}  a.txt\n`, { algo: "blake3" });
        expect(asBlake3.lines).toEqual(["a.txt: OK"]);

        const tagged = await verify(`BLAKE3 (a.txt) = ${blake3}\n`);
        expect(tagged.lines).toEqual(["a.txt: OK"]);
    });

    it("finds an escaped path with a backslash in it", async () => {
        const { lines } = await verify(`\\${sha("sha256", "backslash")}  a\\\\b.txt\n`);
        expect(lines).toEqual(["a\\b.txt: OK"]);
    });

    it("matches an uppercase digest", async () => {
        const { lines } = await verify(`${A.toUpperCase()}  a.txt\n`);
        expect(lines).toEqual(["a.txt: OK"]);
    });
});

describe("expandInputs", () => {
    let dir: string;

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), "gt-hash-inputs-"));
        mkdirSync(join(dir, "tree/b"), { recursive: true });
        mkdirSync(join(dir, "tree/a"), { recursive: true });
        mkdirSync(join(dir, "tree/empty"));
        writeFileSync(join(dir, "tree/z.txt"), "z");
        writeFileSync(join(dir, "tree/a/1.txt"), "a1");
        writeFileSync(join(dir, "tree/b/2.txt"), "b2");
        symlinkSync(join(dir, "tree/z.txt"), join(dir, "tree/link-to-file"));
        symlinkSync(join(dir, "tree/a"), join(dir, "tree/link-to-dir"));
        writeFileSync(join(dir, "file[1].txt"), "bracket");
        writeFileSync(join(dir, "one.log"), "1");
        writeFileSync(join(dir, "two.log"), "2");
    });

    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    const at = (path: string) => join(dir, path);
    const paths = (inputs: Awaited<ReturnType<typeof expandInputs>>) =>
        inputs.map((input) => (input.kind === "stdin" ? "-" : input.path));

    it("hashes a directory file by file, sorted, following a symlinked file and not a symlinked directory", async () => {
        expect(paths(await expandInputs([at("tree")]))).toEqual([
            at("tree/a/1.txt"),
            at("tree/b/2.txt"),
            at("tree/link-to-file"),
            at("tree/z.txt"),
        ]);
    });

    it("does not double the slash after a directory written with a trailing slash", async () => {
        expect((await expandInputs([`${at("tree")}/`]))[0]).toEqual({ kind: "file", path: at("tree/a/1.txt") });
    });

    it("keeps the order of the arguments, treats '-' as stdin, and drops a repeat", async () => {
        const inputs = await expandInputs([at("two.log"), "-", at("one.log"), at("two.log"), "-"]);
        expect(paths(inputs)).toEqual([at("two.log"), "-", at("one.log")]);
    });

    it("expands a glob, sorted", async () => {
        expect(paths(await expandInputs([at("*.log")]))).toEqual([at("one.log"), at("two.log")]);
    });

    it("prefers a file that exists under the literal name over a glob reading of it", async () => {
        expect(paths(await expandInputs([at("file[1].txt")]))).toEqual([at("file[1].txt")]);
    });

    it("reports a missing file and an unmatched glob as errors, and still returns the others", async () => {
        const inputs = await expandInputs([at("one.log"), at("nofile.txt"), at("*.nothing")]);
        expect(inputs).toEqual([
            { kind: "file", path: at("one.log") },
            { kind: "error", path: at("nofile.txt"), message: "No such file or directory" },
            { kind: "error", path: at("*.nothing"), message: "No such file or directory" },
        ]);
    });

    it("returns nothing for a directory with no files", async () => {
        expect(await expandInputs([at("tree/empty")])).toEqual([]);
    });

    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
        "keeps the readable files and reports a nested directory it cannot read as an error",
        async () => {
            const locked = at("partial/locked");
            mkdirSync(locked, { recursive: true });
            writeFileSync(at("partial/a.txt"), "a");
            writeFileSync(join(locked, "hidden.txt"), "h");
            writeFileSync(at("partial/z.txt"), "z");
            chmodSync(locked, 0o000);

            try {
                expect(await expandInputs([at("partial")])).toEqual([
                    { kind: "file", path: at("partial/a.txt") },
                    { kind: "error", path: locked, message: "Permission denied" },
                    { kind: "file", path: at("partial/z.txt") },
                ]);
            } finally {
                chmodSync(locked, 0o755);
            }
        }
    );
});

describe("hash CLI", () => {
    let dir: string;
    let home: string;

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), "gt-hash-cli-"));
        home = mkdtempSync(join(tmpdir(), "gt-hash-home-"));
        writeFileSync(join(dir, "a.txt"), "alpha");
        writeFileSync(join(dir, "my file.txt"), "bravo");
        writeFileSync(join(dir, "empty.bin"), "");
        mkdirSync(join(dir, "tree"));
        writeFileSync(join(dir, "tree/one.txt"), "one");
    });

    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
    });

    async function tool(args: string[], stdin?: string) {
        const proc = Bun.spawn({
            cmd: ["bun", "run", INDEX, ...args],
            cwd: dir,
            env: { ...process.env, GENESIS_TOOLS_HOME: home, NO_COLOR: "1" },
            stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);

        return { stdout, stderr, exitCode };
    }

    const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

    // Regression test: #446 item 8 — a missing file printed the clear "could not
    // read" line, then a structured WARN dump with the full ENOENT stack trace.
    it("prints one clear line for a missing file, with no structured WARN or stack dump, and exits 1", async () => {
        const { stderr, exitCode } = await tool(["definitely-missing-file.bin"]);

        expect(exitCode).toBe(1);
        expect(stderr).toContain("hash: definitely-missing-file.bin: No such file or directory");
        expect(stderr).not.toContain("WARN");
        expect(stderr).not.toContain("ENOENT");
    });

    it("hashes several files, a directory and stdin in argument order, and keeps going past a missing file", async () => {
        const { stdout, stderr, exitCode } = await tool(["a.txt", "missing.txt", "tree", "-", "my file.txt"], "piped");

        expect(stdout.trim().split("\n")).toEqual([
            `${sha256("alpha")}  a.txt`,
            `${sha256("one")}  tree/one.txt`,
            `${sha256("piped")}  -`,
            `${sha256("bravo")}  my file.txt`,
        ]);
        expect(stderr).toContain("hash: missing.txt: No such file or directory");
        expect(exitCode).toBe(1);
    });

    it("hashes piped stdin when no file is given, with each algorithm", async () => {
        const { stdout, exitCode } = await tool(["-a", "sha1"], "abc");
        expect(stdout).toBe(`${ABC.sha1}  -\n`);
        expect(exitCode).toBe(0);

        const blake3 = await tool(["-a", "blake3"], "abc");
        expect(blake3.stdout).toBe(`${ABC.blake3}  -\n`);
    });

    it("verifies a checksum file: OK lines and exit 0, then FAILED lines and exit 1 after a change", async () => {
        const sums = join(dir, "SHA256SUMS");
        writeFileSync(sums, `${sha256("alpha")}  a.txt\n${sha256("bravo")} *my file.txt\n${sha256("")}  empty.bin\n`);

        const passing = await tool(["-c", "SHA256SUMS"]);
        expect(passing.stdout).toBe("a.txt: OK\nmy file.txt: OK\nempty.bin: OK\n");
        expect(passing.exitCode).toBe(0);

        writeFileSync(join(dir, "a.txt"), "tampered");
        try {
            const failing = await tool(["-c", "SHA256SUMS", "--quiet"]);
            expect(failing.stdout).toBe("a.txt: FAILED\n");
            expect(failing.stderr).toContain("hash: WARNING: 1 computed checksum did NOT match");
            expect(failing.exitCode).toBe(1);
        } finally {
            writeFileSync(join(dir, "a.txt"), "alpha");
        }
    });

    it("reads the checksum list from stdin with -c -", async () => {
        const { stdout, exitCode } = await tool(["-c", "-"], `${sha256("alpha")}  a.txt\n`);
        expect(stdout).toBe("a.txt: OK\n");
        expect(exitCode).toBe(0);
    });

    it("verifies a '-' entry against stdin, so what `tools hash` printed for piped data round-trips", async () => {
        const written = await tool([], "abc");
        writeFileSync(join(dir, "stdin.sums"), written.stdout);

        const matching = await tool(["-c", "stdin.sums"], "abc");
        expect(matching.stdout).toBe("-: OK\n");
        expect(matching.exitCode).toBe(0);

        const changed = await tool(["-c", "stdin.sums"], "abd");
        expect(changed.stdout).toBe("-: FAILED\n");
        expect(changed.exitCode).toBe(1);
    });

    it("fails a '-' entry when stdin already carried the checksum list", async () => {
        const { stdout, stderr, exitCode } = await tool(["-c", "-"], `${ABC.sha1}  -\n`);

        expect(stdout).toBe("-: FAILED open or read\n");
        expect(stderr).toContain("hash: -: standard input already holds the checksum list");
        expect(exitCode).toBe(1);
    });

    it("exits 1 and names the problem when the checksum file is missing or has no checksum lines", async () => {
        const missing = await tool(["-c", "no-such.sums"]);
        expect(missing.stderr).toContain("hash: no-such.sums: No such file or directory");
        expect(missing.exitCode).toBe(1);

        writeFileSync(join(dir, "garbage.sums"), "not a checksum\n");
        const garbage = await tool(["-c", "garbage.sums"]);
        expect(garbage.stderr).toContain("hash: garbage.sums: no properly formatted checksum lines found");
        expect(garbage.exitCode).toBe(1);
    });

    it("refuses files together with --check, and an unknown algorithm", async () => {
        const both = await tool(["-c", "SHA256SUMS", "a.txt"]);
        expect(both.exitCode).toBe(1);

        const unknown = await tool(["-a", "crc32", "a.txt"]);
        expect(unknown.exitCode).toBe(1);
    });

    it("--help lists every algorithm", async () => {
        const { stdout, exitCode } = await tool(["--help"]);
        for (const algo of ALGOS) {
            expect(stdout).toContain(algo);
        }

        expect(stdout).toContain("--check");
        expect(exitCode).toBe(0);
    });

    // A single comparison against the system tool: shasum ships with macOS and with Perl on Linux.
    test.skipIf(Bun.which("shasum") === null)("prints the same lines as shasum -a 256 for the same files", async () => {
        const names = ["a.txt", "my file.txt", "empty.bin"];
        const reference = Bun.spawnSync(["shasum", "-a", "256", ...names], { cwd: dir, env: process.env });
        const { stdout } = await tool(["-a", "sha256", ...names]);
        expect(stdout).toBe(reference.stdout.toString());
    });
});
