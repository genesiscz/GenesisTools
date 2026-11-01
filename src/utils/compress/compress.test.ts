import { dlopen, FFIType } from "bun:ffi";
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import {
    chmodSync,
    closeSync,
    existsSync,
    fstatSync,
    linkSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    renameSync,
    rmSync,
    statSync,
    symlinkSync,
    truncateSync,
    unlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import {
    readFirstLines,
    readLastLines,
    readLines,
    readLinesBackwardSync,
    readLinesSync,
    readTextChunks,
    readWholeTextSync,
    storedFilePath,
} from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { createDailyFileStream } from "@genesiscz/utils/logger";
import { startDailyCompressionOnce } from "@genesiscz/utils/logger/daily-trigger";
import {
    dayLogDigestsDir,
    dayLogName,
    dayLogPath,
    dayOfPlainDayLog,
    isSealedDayLog,
    listDayLogs,
    parseDayLogName,
} from "@genesiscz/utils/logger/day-logs";
import { isObject } from "@genesiscz/utils/object";
import { ripgrepBinary } from "@genesiscz/utils/ripgrep";
import { atomicWriteIo } from "@genesiscz/utils/storage/atomic-file";
import { withTimeZone } from "@genesiscz/utils/test/timezone";
import { dailyPassLockPath, planDailyCompression, runDailyCompression } from "./daily";
import { compressFile, decompressFile, digestZstdContent, verifyCompressedFile } from "./file";
import { searchLedger } from "./ledger";
import { compressPath, expandPath, planCompressPath, sampleFolder, verifyPath } from "./operations";
import { PRESET_NAMES, PRESETS, resolvePreset, sniffSample } from "./presets";
import {
    applyFolderRetention,
    applyOldFileCompression,
    planFolderRetention,
    planOldFileCompression,
} from "./retention";
import { ripgrepDigestPath, ripgrepFiles, ripgrepFilesCached } from "./search";
import {
    assertArchiveOutsideSource,
    listArchive,
    packDirectory,
    unpackArchive,
    verifyArchiveAgainstFolder,
} from "./tar";
import { compressStream, createVerifiedZstdBatch, createVerifiedZstdWriter, ZstdVerificationError } from "./verified";
import { readSeekTable, readZstdFramesSync, SeekableZstdWriter, walkFrames, zstdFrames } from "./zstd";

const root = mkdtempSync(join(tmpdir(), "compress-test-"));
let counter = 0;
const scratch = (label: string) => {
    const dir = join(root, `${label}-${counter++}`);
    mkdirSync(dir, { recursive: true });
    return dir;
};

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

/** Text with varied lines, so frames neither repeat nor compress to nothing. */
function logText(lines: number): string {
    return Array.from(
        { length: lines },
        (_, index) => `{"n":${index},"msg":"line ${index} ${"x".repeat(index % 50)}"}`
    ).join("\n");
}

function framesOf(path: string) {
    const fd = openSync(path, "r");

    try {
        const size = fstatSync(fd).size;
        return { table: readSeekTable(fd, size), walked: walkFrames(fd, size), frames: zstdFrames(fd, size) };
    } finally {
        closeSync(fd);
    }
}

describe("seekable zstd", () => {
    it("writes independent line-aligned frames, a seek table every decoder skips, and reads every frame back", async () => {
        const dir = scratch("seekable");
        const text = `${logText(4000)}\n`;
        const chunks: Uint8Array[] = [];
        const writer = new SeekableZstdWriter({
            write: (bytes) => chunks.push(Uint8Array.from(bytes)),
            frameBytes: 16 * 1024,
            lineAligned: true,
            threads: 3,
        });

        for (let at = 0; at < text.length; at += 5000) {
            await writer.push(Buffer.from(text.slice(at, at + 5000)));
        }

        const stats = await writer.finish();
        const path = join(dir, "x.zst");
        writeFileSync(path, Buffer.concat(chunks));
        const { table, walked } = framesOf(path);

        expect(stats.frames).toBeGreaterThan(5);
        expect(table?.length).toBe(stats.frames);
        expect(walked.map((frame) => frame.offset)).toEqual(table!.map((frame) => frame.offset));
        // Bun's whole-buffer decoder reads every frame and skips the table (node:zlib on Bun 1.3.13 stops at frame 1).
        expect(Buffer.from(Bun.zstdDecompressSync(readFileSync(path))).toString()).toBe(text);

        const decoded = [...readZstdFramesSync(path)].map((frame) => Buffer.from(frame).toString());
        expect(decoded.join("")).toBe(text);
        expect(decoded.slice(0, -1).every((frame) => frame.endsWith("\n"))).toBe(true);
        expect(decoded.slice(0, -1).every((frame) => frame.length <= 16 * 1024)).toBe(true);
    });

    it("walks a file the zstd CLI would write (frames without a seek table, a skippable frame between)", () => {
        const dir = scratch("walk");
        const skippable = Buffer.alloc(12);
        skippable.writeUInt32LE(0x184d2a50, 0);
        skippable.writeUInt32LE(4, 4);
        const path = join(dir, "cli.zst");
        writeFileSync(
            path,
            Buffer.concat([
                Bun.zstdCompressSync(Buffer.from("one\n")),
                skippable,
                Bun.zstdCompressSync(Buffer.from("two\n")),
            ])
        );

        expect(framesOf(path).table).toBeNull();
        expect([...readZstdFramesSync(path)].map((frame) => Buffer.from(frame).toString())).toEqual(["one\n", "two\n"]);
    });
});

describe("line readers on .zst", () => {
    it("readLinesSync, readFirstLines and readLastLines give the same lines for a file and its .zst", async () => {
        const dir = scratch("lines");
        const plain = join(dir, "day.log");
        writeFileSync(plain, logText(3000));
        const result = await compressFile({ source: plain, frameBytes: 8 * 1024 });

        expect(result.frames).toBeGreaterThan(3);
        expect([...readLinesSync(result.target)]).toEqual([...readLinesSync(plain)]);

        for (const maxBytes of [100, 4096, 20_000, 10_000_000]) {
            expect(readLastLines(result.target, { maxBytes })).toEqual(readLastLines(plain, { maxBytes }));
            expect(readFirstLines(result.target, { maxBytes })).toEqual(readFirstLines(plain, { maxBytes }));
        }
    });
});

describe("compressFile", () => {
    it("keeps the source's mode, verifies, and a flipped byte fails verification", async () => {
        const dir = scratch("file");
        const plain = join(dir, "secret.jsonl");
        writeFileSync(plain, logText(500));
        chmodSync(plain, 0o600);
        const result = await compressFile({ source: plain });

        expect(statSync(result.target).mode & 0o777).toBe(0o600);
        expect(verifyCompressedFile(result.target, result)).toBe(true);
        expect(digestZstdContent(result.target).sha256).toBe(result.sha256);
        const restored = join(dir, "restored.jsonl");
        await decompressFile({ source: result.target, target: restored });
        expect(statSync(restored).mode & 0o777).toBe(0o600);
        expect(readFileSync(restored, "utf8")).toBe(logText(500));

        const bytes = readFileSync(result.target);
        bytes[Math.floor(bytes.length / 2)]! ^= 0xff;
        writeFileSync(result.target, bytes);
        expect(verifyCompressedFile(result.target, result)).toBe(false);
    });

    it("throws and leaves the target as it was when the source is cut while it is read", async () => {
        const dir = scratch("cut");
        const source = join(dir, "2026-10-10.log");
        // Over one 1 MiB read, so a read follows the cut.
        writeFileSync(source, logText(60_000));
        const target = `${source}.zst`;
        writeFileSync(target, "the verified copy");
        const write = atomicWriteIo.writeSync;
        let cut = false;
        // The first frame written is the moment another pass would cut the retired file to zero.
        const probe = spyOn(atomicWriteIo, "writeSync").mockImplementation((fd, bytes, offset, length) => {
            if (!cut) {
                cut = true;
                truncateSync(source, 0);
            }

            return write(fd, bytes, offset, length);
        });

        try {
            await expect(compressFile({ source, target, frameBytes: 64 * 1024 })).rejects.toThrow(
                "changed while it was compressed"
            );
        } finally {
            probe.mockRestore();
        }

        expect(cut).toBe(true);
        expect(readFileSync(target, "utf8")).toBe("the verified copy");
    });
});

describe("verified zstd writer", () => {
    /** One byte flipped in the first write to the file at `path`: a disk or a step that corrupts the output. */
    function corruptFirstWriteTo(path: string) {
        const write = atomicWriteIo.writeSync;
        const inode = statSync(path).ino;
        let corrupted = false;

        return spyOn(atomicWriteIo, "writeSync").mockImplementation((fd, bytes, offset, length) => {
            if (corrupted || fstatSync(fd).ino !== inode) {
                return write(fd, bytes, offset, length);
            }

            corrupted = true;
            const copy = Buffer.from(bytes);
            copy[offset + Math.floor(length / 2)]! ^= 0xff;
            return write(fd, copy, offset, length);
        });
    }

    async function collect(lines: AsyncIterable<string>): Promise<string[]> {
        const out: string[] = [];

        for await (const line of lines) {
            out.push(line);
        }

        return out;
    }

    const partials = (dir: string) => readdirSync(dir).filter((name) => name.endsWith(".partial"));

    it("commits a stream to a seekable .zst with its plain file's lines, no partial left, and a ledger entry", async () => {
        const dir = scratch("verified");
        const text = `${logText(3000)}\n{"text":"raw   and   stay inside"}\n`;
        const plain = join(dir, "day.log");
        writeFileSync(plain, text);
        const target = join(dir, "day.log.zst");
        async function* chunks() {
            for (let at = 0; at < text.length; at += 7000) {
                yield text.slice(at, at + 7000);
            }
        }

        const result = await compressStream(chunks(), {
            target,
            caller: "test-verified",
            source: plain,
            frameBytes: 8 * 1024,
            mode: 0o600,
        });

        expect(result.frames).toBeGreaterThan(3);
        expect(framesOf(target).table?.length).toBe(result.frames);
        expect(digestZstdContent(target)).toEqual({ bytes: Buffer.byteLength(text), sha256: result.sha256 });
        expect(statSync(target).mode & 0o777).toBe(0o600);
        expect(partials(dir)).toEqual([]);
        const lines = [...readLinesSync(plain)];
        expect(lines.at(-2)).toContain(" ");
        expect([...readLinesSync(target)]).toEqual(lines);
        expect(await collect(readLines(target))).toEqual(lines);
        const records = searchLedger({ caller: "test-verified", path: dir });
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            op: "compress",
            source: plain,
            target,
            sourceBytes: result.bytes,
            targetBytes: statSync(target).size,
            inputSha256: result.sha256,
            outputSha256: new Bun.CryptoHasher("sha256").update(readFileSync(target)).digest("hex"),
            preset: "text",
            removedOriginal: false,
        });
    });

    it("a read-back that fails leaves the existing target byte-identical, removes the partial and records nothing", async () => {
        const dir = scratch("verified-corrupt");
        const target = join(dir, "kept.jsonl.zst");
        writeFileSync(target, "the existing target");
        const writer = createVerifiedZstdWriter(target, { caller: "test-verified-corrupt", frameBytes: 4096 });
        const probe = corruptFirstWriteTo(writer.partialPath);

        try {
            await writer.push(logText(2000));
            expect(existsSync(writer.partialPath)).toBe(true);
            await expect(writer.commit()).rejects.toBeInstanceOf(ZstdVerificationError);
        } finally {
            probe.mockRestore();
        }

        expect(readFileSync(target, "utf8")).toBe("the existing target");
        expect(existsSync(writer.partialPath)).toBe(false);
        expect(writer.state).toBe("aborted");
        expect(searchLedger({ caller: "test-verified-corrupt", path: dir })).toEqual([]);
        await expect(writer.push("more")).rejects.toThrow("aborted");
    });

    it("abort() removes the partial and keeps the target; a source that throws aborts compressStream", async () => {
        const dir = scratch("verified-abort");
        const target = join(dir, "x.zst");
        writeFileSync(target, "old");
        const writer = createVerifiedZstdWriter(target, { caller: "test-verified-abort" });
        await writer.push("some bytes\n");
        expect(partials(dir)).toHaveLength(1);
        writer.abort();
        writer.abort();

        expect(existsSync(writer.partialPath)).toBe(false);
        expect(readFileSync(target, "utf8")).toBe("old");
        await expect(writer.commit()).rejects.toThrow("aborted");

        async function* failing() {
            yield "first\n";
            throw new Error("source broke");
        }

        await expect(compressStream(failing(), { target, caller: "test-verified-abort" })).rejects.toThrow(
            "source broke"
        );
        expect(readFileSync(target, "utf8")).toBe("old");
        expect(readdirSync(dir)).toEqual(["x.zst"]);
    });

    it("a batch with one output that fails to verify renames none and removes every partial", async () => {
        const dir = scratch("verified-batch-fail");
        const first = join(dir, "2026-10-30.jsonl.zst");
        const second = join(dir, "2026-10-31.jsonl.zst");
        const fresh = join(dir, "2026-11-01.jsonl.zst");
        writeFileSync(first, "old first");
        writeFileSync(second, "old second");
        const batch = createVerifiedZstdBatch({ caller: "test-verified-batch", frameBytes: 4096 });
        const writers = [first, second, fresh].map((target) => batch.add(target));
        const probe = corruptFirstWriteTo(writers[1]!.partialPath);
        let failure: unknown;

        try {
            for (const [index, writer] of writers.entries()) {
                await writer.push(logText(300 + index));
            }

            failure = await batch.commit().then(
                () => undefined,
                (err: unknown) => err
            );
        } finally {
            probe.mockRestore();
        }

        expect(failure).toBeInstanceOf(ZstdVerificationError);
        expect(failure instanceof ZstdVerificationError ? failure.targets : []).toEqual([second]);
        expect(readFileSync(first, "utf8")).toBe("old first");
        expect(readFileSync(second, "utf8")).toBe("old second");
        expect(existsSync(fresh)).toBe(false);
        expect(writers.map((writer) => writer.state)).toEqual(["aborted", "aborted", "aborted"]);
        expect(readdirSync(dir).sort()).toEqual(["2026-10-30.jsonl.zst", "2026-10-31.jsonl.zst"]);
        expect(searchLedger({ caller: "test-verified-batch", path: dir })).toEqual([]);
    });

    it("a batch whose outputs all verify renames each and records each, a writer finished early too", async () => {
        const dir = scratch("verified-batch-ok");
        const first = join(dir, "a.jsonl.zst");
        const second = join(dir, "b.jsonl.zst");
        writeFileSync(first, "old first");
        const batch = createVerifiedZstdBatch({ caller: "test-verified-batch-ok" });
        const [one, two] = [batch.add(first), batch.add(second)];
        expect(() => batch.add(first)).toThrow("already has a writer");
        await one!.push(logText(20));
        await one!.finish();
        // Finished early (its file closed and read back), and still not renamed: the batch has not committed.
        expect(one!.state).toBe("verified");
        expect(readFileSync(first, "utf8")).toBe("old first");
        await expect(one!.push("late")).rejects.toThrow("verified");
        await two!.push(logText(30));
        await expect(one!.commit()).rejects.toThrow("commit the batch");

        const results = await batch.commit();

        expect(results.map((result) => result.target)).toEqual([first, second]);
        expect([...readLinesSync(first)]).toEqual(logText(20).split("\n"));
        expect([...readLinesSync(second)]).toEqual(logText(30).split("\n"));
        expect(partials(dir)).toEqual([]);
        expect(searchLedger({ caller: "test-verified-batch-ok", path: dir }).map((record) => record.target)).toEqual([
            first,
            second,
        ]);
    });
});

describe("folder archives", () => {
    function makeTree(dir: string): string {
        const tree = join(dir, "tree");
        mkdirSync(join(tree, "a", "b"), { recursive: true });
        writeFileSync(join(tree, "top.txt"), "top\n");
        writeFileSync(join(tree, "a", "b", `${"long-name-".repeat(12)}.json`), logText(200));
        writeFileSync(join(tree, "a", "empty"), "");
        symlinkSync("top.txt", join(tree, "link"));
        return tree;
    }

    it("packs to <folder>.zst, lists every entry with sizes, verifies by content, and unpacks byte for byte", async () => {
        const dir = scratch("pack");
        const tree = makeTree(dir);
        const packed = await packDirectory({ source: tree, frameBytes: 64 * 1024 });
        const listed = listArchive(packed.archive);

        expect(packed.archive).toBe(`${tree}.zst`);
        expect(listed.map((entry) => entry.path).sort()).toEqual(
            [
                "tree",
                "tree/a",
                "tree/a/b",
                `tree/a/b/${"long-name-".repeat(12)}.json`,
                "tree/a/empty",
                "tree/link",
                "tree/top.txt",
            ].sort()
        );
        expect(verifyArchiveAgainstFolder({ archive: packed.archive, source: tree }).ok).toBe(true);

        const out = join(dir, "restored");
        await unpackArchive({ archive: packed.archive, destination: out });
        expect(readFileSync(join(out, "tree", "a", "b", `${"long-name-".repeat(12)}.json`), "utf8")).toBe(logText(200));

        writeFileSync(join(tree, "top.txt"), "tip\n");
        const changed = verifyArchiveAgainstFolder({ archive: packed.archive, source: tree });
        expect(changed.ok).toBe(false);
        expect(changed.mismatched).toEqual(["tree/top.txt"]);
    });

    it("keeps restricted folder archives private from their first write", async () => {
        const dir = scratch("private-folder");
        const tree = makeTree(dir);
        chmodSync(tree, 0o700);
        chmodSync(join(tree, "top.txt"), 0o600);
        const modes: number[] = [];
        const write = atomicWriteIo.writeSync;
        const probe = spyOn(atomicWriteIo, "writeSync").mockImplementation((fd, bytes, offset, length) => {
            modes.push(fstatSync(fd).mode & 0o777);
            return write(fd, bytes, offset, length);
        });

        try {
            const packed = await packDirectory({ source: tree });
            expect(modes.length).toBeGreaterThan(0);
            expect(modes.every((mode) => (mode & 0o077) === 0)).toBe(true);
            expect(statSync(packed.archive).mode & 0o777).toBe(0o600);
            expect(verifyArchiveAgainstFolder({ archive: packed.archive, source: tree }).ok).toBe(true);
        } finally {
            probe.mockRestore();
        }
    });

    it("rejects an archive with entries deleted from its source", async () => {
        const dir = scratch("deleted-entry");
        const tree = makeTree(dir);
        const packed = await packDirectory({ source: tree });
        rmSync(join(tree, "top.txt"));
        const check = verifyArchiveAgainstFolder({ archive: packed.archive, source: tree });
        expect(check.extra).toEqual(["tree/top.txt"]);
        expect(check.ok).toBe(false);
        expect(verifyPath({ archive: packed.archive, against: tree }).ok).toBe(false);
    });

    it("refuses renamed and multi-root archives before touching any destination", async () => {
        const dir = scratch("restore-destinations");
        const tree = makeTree(dir);
        const renamed = join(dir, "renamed.zst");
        await packDirectory({ source: tree, archive: renamed });
        writeFileSync(join(tree, "top.txt"), "keep newer content");
        await expect(expandPath({ archive: renamed, caller: "test", removeArchive: true })).rejects.toThrow();
        expect(readFileSync(join(tree, "top.txt"), "utf8")).toBe("keep newer content");
        expect(existsSync(renamed)).toBe(true);
        expect(existsSync(join(dir, "renamed"))).toBe(false);

        const other = join(dir, "other");
        mkdirSync(other);
        writeFileSync(join(other, "keep.txt"), "archived content");
        const tar = Bun.spawnSync(["tar", "--no-xattrs", "-cf", "-", "-C", dir, "tree", "other"], {
            env: { ...env.getProcessEnv(), COPYFILE_DISABLE: "1" },
            stdout: "pipe",
            stderr: "pipe",
        });
        expect(tar.exitCode).toBe(0);
        const multi = join(dir, "tree.zst");
        writeFileSync(multi, Bun.zstdCompressSync(tar.stdout));
        rmSync(tree, { recursive: true });
        writeFileSync(join(other, "keep.txt"), "keep existing content");
        await expect(expandPath({ archive: multi, caller: "test", removeArchive: true })).rejects.toThrow();
        expect(readFileSync(join(other, "keep.txt"), "utf8")).toBe("keep existing content");
        expect(existsSync(tree)).toBe(false);
        expect(existsSync(multi)).toBe(true);
    });

    it("unpackArchive never replaces an existing file", async () => {
        const dir = scratch("unpack-existing");
        const tree = makeTree(dir);
        const packed = await packDirectory({ source: tree });
        writeFileSync(join(tree, "top.txt"), "keep existing content");
        // Some tar implementations report skipped files as an error, others exit successfully.
        await unpackArchive({ archive: packed.archive, destination: dir }).catch((error: Error) => {
            expect(error.message).toContain("tar failed unpacking");
        });
        expect(readFileSync(join(tree, "top.txt"), "utf8")).toBe("keep existing content");
    });

    it("normalizes trailing separators and refuses archives inside the source, including symlink aliases", async () => {
        const dir = scratch("placement");
        const tree = makeTree(dir);
        const plan = await planCompressPath({ source: `${tree}/` });
        expect(plan.target).toBe(`${tree}.zst`);
        const alias = join(dir, "alias");
        symlinkSync(tree, alias);

        for (const target of [join(tree, "nested", "out.zst"), join(alias, "nested", "out.zst")]) {
            await expect(compressPath({ source: tree, target, caller: "test", removeOriginal: true })).rejects.toThrow(
                "outside the source"
            );
            await expect(packDirectory({ source: tree, archive: target })).rejects.toThrow("outside the source");
            expect(existsSync(target)).toBe(false);
            expect(existsSync(tree)).toBe(true);
        }

        const packed = await packDirectory({ source: `${tree}/` });
        expect(packed.archive).toBe(`${tree}.zst`);
        expect(verifyArchiveAgainstFolder({ archive: packed.archive, source: tree }).ok).toBe(true);
    });

    it("checks the archive's parent without following the output symlink", async () => {
        const dir = scratch("output-symlink");
        const tree = makeTree(dir);
        const outside = join(dir, "outside.txt");
        writeFileSync(outside, "keep outside");
        const inside = join(tree, "out.zst");
        symlinkSync(outside, inside);
        const before = readdirSync(tree);

        expect(() => assertArchiveOutsideSource(tree, inside)).toThrow("outside the source");
        await expect(planCompressPath({ source: tree, target: inside })).rejects.toThrow("outside the source");
        await expect(packDirectory({ source: tree, archive: inside })).rejects.toThrow("outside the source");
        expect(readlinkSync(inside)).toBe(outside);
        expect(readFileSync(outside, "utf8")).toBe("keep outside");
        expect(readdirSync(tree)).toEqual(before);

        // Replacing a sibling symlink is safe: its target inside the source is not written through.
        const sibling = join(dir, "tree.zst");
        symlinkSync(join(tree, "top.txt"), sibling);
        expect(() => assertArchiveOutsideSource(tree, sibling)).not.toThrow();
        await packDirectory({ source: tree, archive: sibling });
        expect(verifyArchiveAgainstFolder({ archive: sibling, source: tree }).ok).toBe(true);
        expect(readFileSync(outside, "utf8")).toBe("keep outside");
    });

    it("compares a hardlink's stored content and size with the current file", async () => {
        const dir = scratch("hardlinks");
        const tree = join(dir, "tree");
        mkdirSync(tree);
        writeFileSync(join(tree, "first"), "same");
        linkSync(join(tree, "first"), join(tree, "second"));
        const packed = await packDirectory({ source: tree });
        const linked = listArchive(packed.archive).find((entry) => entry.type === "hardlink")!;
        expect(linked).toBeDefined();
        expect(verifyArchiveAgainstFolder({ archive: packed.archive, source: tree }).ok).toBe(true);
        const replacement = join(dir, "replacement");
        writeFileSync(replacement, "else");
        renameSync(replacement, join(dir, linked.path));
        expect(verifyArchiveAgainstFolder({ archive: packed.archive, source: tree }).mismatched).toEqual([linked.path]);
        writeFileSync(join(dir, linked.path), "longer");
        expect(
            verifyArchiveAgainstFolder({ archive: packed.archive, source: tree, content: false }).mismatched
        ).toEqual([linked.path]);
    });

    it("rejects incomplete tar headers, bodies, padding, end markers and invalid headers", async () => {
        const dir = scratch("truncated-tar");
        const header = Buffer.alloc(512);
        header.write("tree/file");
        header.write("00000000004\0", 124);
        header.write("0", 156);
        header.write("ustar\0", 257);
        const checksum = (block: Buffer) => {
            block.fill(32, 148, 156);
            block.write(
                `${block
                    .reduce((sum, byte) => sum + byte, 0)
                    .toString(8)
                    .padStart(6, "0")}\0 `,
                148
            );
        };
        checksum(header);
        const valid = Buffer.concat([header, Buffer.from("data"), Buffer.alloc(508 + 1024)]);
        const archive = join(dir, "tree.zst");
        writeFileSync(archive, Bun.zstdCompressSync(valid));
        expect(verifyPath({ archive }).ok).toBe(true);

        for (const length of [300, 514, 517, 1024, 1536]) {
            writeFileSync(archive, Bun.zstdCompressSync(valid.subarray(0, length)));
            expect(() => listArchive(archive, { hash: true })).toThrow();
            expect(() => verifyPath({ archive })).toThrow();
        }

        const badChecksum = Buffer.from(valid);
        badChecksum[0] = 88;
        writeFileSync(archive, Bun.zstdCompressSync(badChecksum));
        expect(() => verifyPath({ archive })).toThrow();
        const badSize = Buffer.from(valid);
        badSize.write("invalid-size", 124);
        checksum(badSize.subarray(0, 512));
        writeFileSync(archive, Bun.zstdCompressSync(badSize));
        expect(() => verifyPath({ archive })).toThrow();
    });

    it("restores files and folders into missing nested destinations", async () => {
        const dir = scratch("new-destination");
        const tree = makeTree(dir);
        const packed = await packDirectory({ source: tree });
        const folderInto = join(dir, "new", "folder");
        await expandPath({ archive: packed.archive, into: folderInto, caller: "test" });
        expect(readFileSync(join(folderInto, "tree", "top.txt"), "utf8")).toBe("top\n");
        const plain = join(dir, "plain.txt");
        writeFileSync(plain, "plain text");
        const file = await compressFile({ source: plain });
        const fileInto = join(dir, "new", "file");
        await expandPath({ archive: file.target, into: fileInto, caller: "test" });
        expect(readFileSync(join(fileInto, "plain.txt"), "utf8")).toBe("plain text");
    });

    it("uses the shared environment snapshot for tar sampling and packing", async () => {
        const dir = scratch("spawn-env");
        const tree = makeTree(dir);
        const snapshot = spyOn(env, "getProcessEnv");

        try {
            await sampleFolder(tree);
            await packDirectory({ source: tree });
            expect(snapshot).toHaveBeenCalledTimes(2);
        } finally {
            snapshot.mockRestore();
        }
    });

    it("compressPath keeps the original unless asked, records the ledger, and expandPath restores the folder", async () => {
        const dir = scratch("ops");
        const tree = makeTree(dir);
        const result = await compressPath({ source: tree, caller: "test", preset: PRESETS.tree });

        expect(existsSync(tree)).toBe(true);
        expect(result.record.op).toBe("pack");
        expect(searchLedger({ path: tree }).map((record) => record.target)).toContain(`${tree}.zst`);
        expect(verifyPath({ archive: `${tree}.zst`, against: tree }).ok).toBe(true);

        rmSync(tree, { recursive: true });
        await expandPath({ archive: `${tree}.zst`, caller: "test" });
        expect(readFileSync(join(tree, "top.txt"), "utf8")).toBe("top\n");
        await expect(expandPath({ archive: `${tree}.zst`, caller: "test" })).rejects.toThrow("already exists");
    });
});

describe("presets", () => {
    it("sniffs signatures, text and random bytes, and refuses already-compressed data", async () => {
        const dir = scratch("presets");
        const random = join(dir, "random.bin");
        writeFileSync(random, crypto.getRandomValues(new Uint8Array(256 * 1024)));
        const text = join(dir, "notes.log");
        writeFileSync(text, logText(2000));

        expect(sniffSample(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])).reason).toBe("jpeg");
        expect(sniffSample(Buffer.from("SQLite format 3\0rest")).kind).toBe("database");
        expect(resolvePreset(text).preset.name).toBe("text");

        const choice = resolvePreset(random);
        expect(choice.preset.name).toBe("media");
        expect(choice.warning).toContain("already compressed");
        await expect(compressPath({ source: random, caller: "test" })).rejects.toThrow("--force");
    });

    it("plans without writing: skips under the 30% minimum with the measured numbers, and --force or a lower minimum lifts it", async () => {
        const dir = scratch("plan");
        const half = join(dir, "half.bin");
        // Half random bytes, half zeros: a trial saves about 50%.
        writeFileSync(
            half,
            Buffer.concat([crypto.getRandomValues(new Uint8Array(128 * 1024)), Buffer.alloc(128 * 1024)])
        );
        const noisy = join(dir, "noisy.bin");
        // Mostly random: saves about 10%, under the default minimum.
        writeFileSync(
            noisy,
            Buffer.concat([crypto.getRandomValues(new Uint8Array(230 * 1024)), Buffer.alloc(26 * 1024)])
        );

        const plain = await planCompressPath({ source: half, preset: PRESETS.binary });
        const skipped = await planCompressPath({ source: noisy, preset: PRESETS.binary });

        expect(plain.refusal).toBeUndefined();
        expect(plain.trialSaving).toBeGreaterThan(0.4);
        expect(skipped.refusal).toContain("under the 30% minimum");
        expect(skipped.refusal).toContain(".mov 1.1%");
        expect(
            (await planCompressPath({ source: noisy, preset: PRESETS.binary, minSaving: 0.05 })).refusal
        ).toBeUndefined();
        expect(
            (await planCompressPath({ source: noisy, preset: PRESETS.binary, force: true })).refusal
        ).toBeUndefined();
        expect(readdirSync(dir).sort()).toEqual(["half.bin", "noisy.bin"]);
    });

    it("pins each preset's measured level (scripts/benchmarks/compress/levels.ts, README.md Presets)", () => {
        const levels = Object.fromEntries(
            PRESET_NAMES.map((name) => [name, `${PRESETS[name].level}${PRESETS[name].long ? " long" : ""}`])
        );

        expect(levels).toEqual({
            text: "22",
            tree: "19 long",
            binary: "9 long",
            database: "19",
            media: "1",
            fast: "1",
            max: "22 long",
        });
    });

    it("a file or folder written without settings gets its preset's level, and every reader returns the same bytes", async () => {
        const dir = scratch("levels");
        const plain = join(dir, "day.log");
        const text = logText(4000);
        writeFileSync(plain, text);
        const frameBytes = 64 * 1024;
        const unset = await compressFile({ source: plain, target: join(dir, "unset.zst"), frameBytes });
        const preset = await compressFile({
            source: plain,
            target: join(dir, "preset.zst"),
            ...PRESETS.text,
            frameBytes,
        });
        const level3 = await compressFile({ source: plain, target: join(dir, "level3.zst"), level: 3, frameBytes });

        expect(preset.frames).toBeGreaterThan(2);
        expect(readFileSync(unset.target).equals(readFileSync(preset.target))).toBe(true);
        // Level 3 writes other bytes, so the equality above cannot hold by accident.
        expect(readFileSync(unset.target).equals(readFileSync(level3.target))).toBe(false);
        expect(Buffer.concat([...readZstdFramesSync(preset.target)]).toString()).toBe(text);
        expect(digestZstdContent(preset.target).sha256).toBe(preset.sha256);
        expect([...readLinesSync(preset.target)]).toEqual([...readLinesSync(plain)]);
        expect(readLastLines(preset.target)).toEqual(readLastLines(plain));
        expect(readFirstLines(preset.target)).toEqual(readFirstLines(plain));

        const rg = ripgrepBinary();

        if (rg) {
            const args = ["--no-config", "--no-filename", "-F", "-e", '"n":3242,'];
            const fromZst = await ripgrepFiles({ rg, args, files: [preset.target] });
            expect(fromZst.stdout).toBe((await ripgrepFiles({ rg, args, files: [plain] })).stdout);
            expect(fromZst.stdout).toContain('"n":3242,');
        }

        const tree = join(dir, "tree");
        mkdirSync(tree);
        writeFileSync(join(tree, "a.json"), text);
        const packedUnset = await packDirectory({ source: tree, archive: join(dir, "unset-tree.zst") });
        const packedPreset = await packDirectory({
            source: tree,
            archive: join(dir, "preset-tree.zst"),
            ...PRESETS.tree,
        });
        const packed3 = await packDirectory({ source: tree, archive: join(dir, "level3-tree.zst"), level: 3 });

        expect(readFileSync(packedUnset.archive).equals(readFileSync(packedPreset.archive))).toBe(true);
        expect(readFileSync(packedUnset.archive).equals(readFileSync(packed3.archive))).toBe(false);
        expect(verifyArchiveAgainstFolder({ archive: packedPreset.archive, source: tree }).ok).toBe(true);
        // Six writes at levels 19 and 22: CPU-bound by design, so a loaded machine gets room.
    }, 30_000);
});

describe("retention", () => {
    it("keeps the newest folders, packs the older ones, drops past the cap, and the plan writes nothing", async () => {
        const dir = scratch("retention");
        const day = 86_400_000;
        const now = new Date("2026-10-13T12:00:00Z");

        for (const [name, age] of [
            ["r1", 1],
            ["r2", 2],
            ["r3", 3],
            ["r4", 40],
        ] as const) {
            mkdirSync(join(dir, name));
            writeFileSync(join(dir, name, "data.jsonl"), logText(100));
            const seconds = (now.getTime() - age * day) / 1000;
            utimesSync(join(dir, name), seconds, seconds);
        }

        const before = readdirSync(dir).sort();
        const plan = planFolderRetention({ root: dir, keep: 2, maxArchiveAgeDays: 30, now });

        expect(readdirSync(dir).sort()).toEqual(before);
        expect(plan.kept.map((path) => path.split("/").pop())).toEqual(["r1", "r2"]);
        expect(plan.pack.map((item) => item.folder.split("/").pop())).toEqual(["r3"]);
        expect(plan.drop.map((path) => path.split("/").pop())).toEqual(["r4"]);

        const retired: string[] = [];
        const report = await applyFolderRetention(plan, {
            caller: "test",
            minFreeBytes: 0,
            retire: (path) => {
                retired.push(path.split("/").pop()!);
                rmSync(path, { recursive: true, force: true });
            },
        });

        expect(report.packed.map((item) => item.archive.split("/").pop())).toEqual(["r3.zst"]);
        expect(retired).toEqual(["r3", "r4"]);
        expect(readdirSync(dir).sort()).toEqual(["r1", "r2", "r3.zst"]);
        // A pinned folder stays whatever its rank (a running process executes a retired app bundle).
        expect(
            planFolderRetention({ root: dir, keep: 0, pin: (name) => name === "r2", now }).kept.map((path) =>
                path.split("/").pop()
            )
        ).toEqual(["r2"]);
        // A kept folder older than keepMaxAgeDays is packed anyway (cloned backup runs free nothing one by one).
        expect(
            planFolderRetention({ root: dir, keep: 2, keepMaxAgeDays: 1.5, now }).pack.map((item) =>
                item.folder.split("/").pop()
            )
        ).toEqual(["r2"]);
        expect(listArchive(join(dir, "r3.zst")).some((entry) => entry.path === "r3/data.jsonl")).toBe(true);
    });

    it("compresses old day files in place, leaves today's and recently written ones plain", async () => {
        const dir = scratch("days");
        const now = new Date("2026-10-13T12:00:00");
        const old = (now.getTime() - 3 * 3_600_000) / 1000;

        for (const name of [
            "2026-10-11.log",
            "2026-10-12-profiling.log",
            "2026-10-12.log",
            "2026-10-13.log",
            "notes.log",
        ]) {
            writeFileSync(join(dir, name), logText(300));
            utimesSync(join(dir, name), old, old);
        }

        const fresh = now.getTime() / 1000 - 60;
        utimesSync(join(dir, "2026-10-12.log"), fresh, fresh);
        const dayOf = (relative: string) => /^(\d{4}-\d{2}-\d{2})(?:-profiling)?\.log$/.exec(relative)?.[1];
        const plan = planOldFileCompression({ root: dir, dayOf, firstPlainDay: "2026-10-13", now });

        expect(plan.compress.map((item) => item.path.split("/").pop()).sort()).toEqual([
            "2026-10-11.log",
            "2026-10-12-profiling.log",
        ]);

        const report = await applyOldFileCompression(plan, { caller: "test", releaseGraceMs: 0 });
        expect(report.failed).toEqual([]);
        expect(readdirSync(dir).sort()).toEqual(
            [
                "2026-10-11.log.zst",
                "2026-10-12-profiling.log.zst",
                "2026-10-12.log",
                "2026-10-13.log",
                "notes.log",
            ].sort()
        );
        expect([...readLinesSync(join(dir, "2026-10-11.log.zst"))].join("\n")).toBe(logText(300));
    });
});

describe("old day files", () => {
    it("frees a removed file's blocks while another process still holds it open, and never cuts a moved one", async () => {
        const now = new Date("2026-10-13T12:00:00");
        const old = new Date("2026-10-10T12:00:00").getTime() / 1000;
        const dayOf = (relative: string) => /^(\d{4}-\d{2}-\d{2})\.log$/.exec(relative)?.[1];
        const run = async (retire?: (path: string) => void) => {
            const dir = scratch("release");
            const path = join(dir, "2026-10-10.log");
            writeFileSync(path, logText(300));
            utimesSync(path, old, old);
            const holder = openSync(path, "r");
            const plan = planOldFileCompression({ root: dir, dayOf, firstPlainDay: "2026-10-12", now });
            const report = await applyOldFileCompression(plan, { caller: "test", retire, releaseGraceMs: 0 });
            const held = fstatSync(holder);
            closeSync(holder);
            return { dir, path, report, held };
        };

        const removed = await run();
        expect(removed.report.compressed.map((item) => item.path)).toEqual([removed.path]);
        expect(existsSync(removed.path)).toBe(false);
        expect([removed.held.nlink, removed.held.size]).toEqual([0, 0]);
        expect([...readLinesSync(`${removed.path}.zst`)].join("\n")).toBe(logText(300));

        const trash = join(scratch("trash"), "kept.log");
        const moved = await run((path) => renameSync(path, trash));
        expect([moved.held.nlink, moved.held.size]).toEqual([1, Buffer.byteLength(logText(300))]);
        expect(readFileSync(trash, "utf8")).toBe(logText(300));
    });

    it("frees each removed file's blocks after its own grace, while the later files still compress", async () => {
        const now = new Date("2026-10-13T12:00:00");
        const old = new Date("2026-10-10T12:00:00").getTime() / 1000;
        const dayOf = (relative: string) => /^(\d{4}-\d{2}-\d{2})\.log$/.exec(relative)?.[1];
        const dir = scratch("release-each");
        const holders = new Map<string, number>();

        for (const name of ["2026-10-09.log", "2026-10-10.log", "2026-10-11.log"]) {
            const path = join(dir, name);
            writeFileSync(path, logText(300));
            utimesSync(path, old, old);
            holders.set(path, openSync(path, "r"));
        }

        const retired: string[] = [];
        const earlierSizes: number[] = [];
        const retire = (path: string) => {
            earlierSizes.push(...retired.map((earlier) => fstatSync(holders.get(earlier)!).size));
            retired.push(path);
            unlinkSync(path);
        };
        const plan = planOldFileCompression({ root: dir, dayOf, firstPlainDay: "2026-10-12", now });

        try {
            const report = await applyOldFileCompression(plan, { caller: "test", retire, releaseGraceMs: 0 });
            expect(report.compressed).toHaveLength(3);
        } finally {
            for (const fd of holders.values()) {
                closeSync(fd);
            }
        }

        // The first file is already cut when the second is removed, and both when the third is.
        expect(earlierSizes).toEqual([0, 0, 0]);
    });

    it("two passes over one file keep its verified .zst, and only one daily pass runs per logs folder", async () => {
        const now = new Date("2026-10-13T12:00:00");
        const old = new Date("2026-10-10T12:00:00").getTime() / 1000;
        const dayOf = (relative: string) => /^(\d{4}-\d{2}-\d{2})\.log$/.exec(relative)?.[1];
        const day = (dir: string) => {
            const path = join(dir, "2026-10-10.log");
            writeFileSync(path, logText(20_000));
            utimesSync(path, old, old);
            return path;
        };

        // Both plans are made before either pass retires the file, as two passes started together would.
        const raced = scratch("race");
        const racedPath = day(raced);
        const plans = [0, 1].map(() =>
            planOldFileCompression({ root: raced, dayOf, firstPlainDay: "2026-10-12", now })
        );
        await Promise.all(plans.map((plan) => applyOldFileCompression(plan, { caller: "test", releaseGraceMs: 0 })));
        expect(existsSync(racedPath)).toBe(false);
        expect([...readLinesSync(`${racedPath}.zst`)].join("\n")).toBe(logText(20_000));

        const locked = scratch("daily-lock");
        const lockedPath = day(locked);
        const pass = () =>
            runDailyCompression({ now: new Date("2026-10-20T12:00:00"), logsDir: locked, releaseGraceMs: 0 });
        const runs = await Promise.all([pass(), pass()]);
        expect(runs.filter((run) => run === null)).toHaveLength(1);
        expect(
            runs.find((run) => run !== null)?.find(({ target }) => target.name === "logs")?.report.compressed
        ).toEqual([expect.objectContaining({ path: lockedPath })]);
        expect(existsSync(dailyPassLockPath(locked))).toBe(false);
        expect([...readLinesSync(`${lockedPath}.zst`)].join("\n")).toBe(logText(20_000));
    });
});

describe("day logs", () => {
    it("lists plain and compressed days newest first, a plain file winning while both exist", async () => {
        const dir = scratch("daylogs");
        writeFileSync(join(dir, "2026-10-12.log"), "a\n");
        writeFileSync(join(dir, "2026-10-11.log"), "b\n");
        await compressFile({ source: join(dir, "2026-10-11.log") });
        writeFileSync(join(dir, "2026-10-10.log.zst"), Bun.zstdCompressSync(Buffer.from("c\n")));
        writeFileSync(join(dir, "2026-10-10-profiling.log"), "p\n");
        writeFileSync(join(dir, "continuity-watch.log"), "x\n");

        expect(listDayLogs({ dir }).map((file) => [file.day, file.compressed])).toEqual([
            ["2026-10-12", false],
            ["2026-10-11", false],
            ["2026-10-10", true],
        ]);
        expect(listDayLogs({ dir, profiling: true }).map((file) => file.day)).toEqual(["2026-10-10"]);
        expect(dayLogPath("2026-10-10", { dir })).toBe(join(dir, "2026-10-10.log.zst"));
        expect(dayLogPath("2026-10-09", { dir })).toBeUndefined();

        const chunks: string[] = [];

        for await (const chunk of readTextChunks(join(dir, "2026-10-10.log.zst"))) {
            chunks.push(Buffer.from(chunk).toString());
        }

        expect(chunks.join("")).toBe("c\n");
    });

    it("finds every kind of day file, failures included, in either form through one table", async () => {
        const dir = scratch("daykinds");
        writeFileSync(join(dir, "2026-10-12-failures.jsonl"), '{"v":1}\n');
        writeFileSync(join(dir, "2026-10-11-failures.jsonl"), '{"v":1}\n');
        await compressFile({ source: join(dir, "2026-10-11-failures.jsonl") });
        unlinkSync(join(dir, "2026-10-11-failures.jsonl"));
        writeFileSync(join(dir, "2026-10-11.log"), "a\n");
        writeFileSync(join(dir, "2026-10-11-profiling.log.zst"), Bun.zstdCompressSync(Buffer.from("p\n")));

        expect(listDayLogs({ dir, kind: "failures" }).map((file) => [file.day, file.compressed, file.kind])).toEqual([
            ["2026-10-12", false, "failures"],
            ["2026-10-11", true, "failures"],
        ]);
        expect(listDayLogs({ dir }).map((file) => file.day)).toEqual(["2026-10-11"]);
        expect(listDayLogs({ dir, kind: "profiling" }).map((file) => file.path)).toEqual(
            listDayLogs({ dir, profiling: true }).map((file) => file.path)
        );
        expect(dayLogPath("2026-10-11", { dir, kind: "failures" })).toBe(join(dir, "2026-10-11-failures.jsonl.zst"));
        expect(dayLogName("2026-10-11", "failures")).toBe("2026-10-11-failures.jsonl");
        expect(
            ["2026-10-11-failures.jsonl", "2026-10-11-profiling.log", "2026-10-11.log", "2026-10-11.log.zst"].map(
                dayOfPlainDayLog
            )
        ).toEqual(["2026-10-11", "2026-10-11", "2026-10-11", undefined]);
        expect(parseDayLogName("app-perf.log")).toBeUndefined();
        expect(storedFilePath(join(dir, "2026-10-11-failures.jsonl"))).toBe(join(dir, "2026-10-11-failures.jsonl.zst"));
        expect(storedFilePath(join(dir, "2026-10-09.log"))).toBeUndefined();
    });

    it("every reader opens a plain name whose file the daily pass replaced by its .zst", async () => {
        const dir = scratch("twin");
        const plain = join(dir, "2026-10-10.log");
        writeFileSync(plain, logText(50));
        await compressFile({ source: plain, frameBytes: 1024 });
        unlinkSync(plain);
        const lines = logText(50).split("\n");

        expect([...readLinesSync(plain)]).toEqual(lines);
        expect(readWholeTextSync(plain)).toBe(logText(50));
        expect(readFirstLines(plain).lines).toEqual(lines);
        expect(readLastLines(plain, { maxBytes: 200 }).lines).toEqual(
            readLastLines(`${plain}.zst`, { maxBytes: 200 }).lines
        );
        expect([...readLinesBackwardSync(plain)].reverse()).toEqual(lines);
        const chunks: Buffer[] = [];

        for await (const chunk of readTextChunks(plain)) {
            chunks.push(Buffer.from(chunk));
        }

        expect(Buffer.concat(chunks).toString()).toBe(logText(50));
        expect(() => [...readLinesSync(join(dir, "2026-10-09.log"))]).toThrow("ENOENT");

        if (ripgrepBinary()) {
            const run = await ripgrepFiles({
                rg: ripgrepBinary()!,
                args: ["--no-config", "--no-filename", "-F", '"n":7,'],
                files: [plain],
            });
            expect([run.code, run.stdout]).toEqual([0, `${lines[7]}\n`]);
        }
    });

    it("the logger closes its day file when the day ends, and no program it execs inherits the file", async () => {
        const dir = scratch("rollover");
        const midnight = new Date(2026, 9, 13, 24, 0, 0, 0).getTime();
        let clock = midnight - 150;
        const stream = createDailyFileStream(() => dir, { now: () => clock });
        const file = join(dir, "2026-10-13.log");
        // The fds of this process that hold `path` (/dev/fd is this process's table on macOS and Linux).
        const holders = (path: string) => {
            const ino = statSync(path).ino;
            return readdirSync("/dev/fd").filter((name) => {
                try {
                    return fstatSync(Number(name)).ino === ino;
                } catch {
                    return false;
                }
            });
        };

        expect(holders(file)).toHaveLength(1);

        if (process.platform === "darwin") {
            const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", {
                fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
            });
            const F_GETFD = 1;
            const FD_CLOEXEC = 1;
            expect(symbols.fcntl(Number(holders(file)[0]), F_GETFD) & FD_CLOEXEC).toBe(FD_CLOEXEC);
        }

        await Bun.sleep(400);
        expect(holders(file)).toEqual([]);

        clock = midnight + 1000;
        await new Promise<void>((resolve, reject) => stream.write("next\n", (err) => (err ? reject(err) : resolve())));
        expect(readFileSync(join(dir, "2026-10-14.log"), "utf8")).toBe("next\n");
        expect(holders(join(dir, "2026-10-14.log"))).toHaveLength(1);
        stream.destroy();
    });

    it("the daily pass keeps two days of day files, failures included, and of transcripts plain, and never starts from a test process", () => {
        const dir = scratch("daily");
        const now = new Date("2026-10-13T12:00:00");
        const targets = planDailyCompression({ now, logsDir: dir }).map(({ target }) => [
            target.name,
            target.firstPlainDay,
        ]);

        expect(targets).toEqual([
            ["logs", "2026-10-12"],
            ["ai-proxy-transcripts", new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10)],
            ["app-hangs", "2026-10-12"],
        ]);
        const hangs = planDailyCompression({ now, logsDir: dir }).find(
            ({ target }) => target.name === "app-hangs"
        )!.target;
        expect(
            [
                "hang-2026-10-11-050739.txt",
                "stack-2026-10-11-050739.txt",
                "hang-2026-10-11-050739.txt.zst",
                "app-perf.log",
            ].map((name) => hangs.dayOf(name))
        ).toEqual(["2026-10-11", "2026-10-11", undefined, undefined]);
        const logs = planDailyCompression({ now, logsDir: dir }).find(({ target }) => target.name === "logs")!.target;
        expect(
            ["2026-10-11.log", "2026-10-11-profiling.log", "2026-10-11-failures.jsonl", "2026-10-11.log.zst"].map(
                (name) => logs.dayOf(name)
            )
        ).toEqual(["2026-10-11", "2026-10-11", "2026-10-11", undefined]);
        // The day after the spring clock change, just after midnight: yesterday is one calendar day back, not 24 hours.
        withTimeZone("Europe/Prague", () => {
            expect(
                planDailyCompression({ now: new Date(2026, 2, 30, 0, 30), logsDir: dir }).find(
                    ({ target }) => target.name === "logs"
                )!.target.firstPlainDay
            ).toBe("2026-03-29");
        });
        expect(startDailyCompressionOnce(dir, "2026-10-13")).toBe(false);
        expect(readdirSync(dir)).toEqual([]);
    });

    it.skipIf(!ripgrepBinary())(
        "a cached search keeps a finished day's lines while the file is unchanged, and the pass carries them to the .zst",
        async () => {
            const dir = scratch("digest");
            const sealed = join(dir, "2026-10-10.log");
            const today = join(dir, "2026-10-13.log");
            writeFileSync(sealed, logText(400));
            writeFileSync(today, logText(30));
            const old = new Date("2026-10-10T12:00:00").getTime() / 1000;
            utimesSync(sealed, old, old);
            const args = ["--no-config", "--no-filename", "--no-line-number", "-F", "-e", '"n":7,'];
            const digest = {
                name: "t",
                dir: dayLogDigestsDir(dir),
                sealed: (file: string) => isSealedDayLog(file, "2026-10-13"),
            };
            const search = (files: string[], rg = ripgrepBinary()!) => ripgrepFilesCached({ rg, args, files, digest });
            const lines = (stdout: string) => stdout.split("\n").filter(Boolean).sort();

            const first = await search([sealed, today]);
            expect([first.code, first.keptFiles, lines(first.stdout).length]).toEqual([0, 0, 2]);
            const saved: unknown = SafeJSON.parse(readFileSync(ripgrepDigestPath({ ...digest, args }), "utf8"), {
                strict: true,
            });
            expect(isObject(saved) && isObject(saved.entries) ? Object.keys(saved.entries) : saved).toEqual([sealed]);

            // No rg runs for a kept day: a missing binary would fail the search.
            const kept = await search([sealed], join(dir, "no-rg"));
            expect([kept.code, kept.keptFiles, kept.stdout]).toEqual([0, 1, `${logText(400).split("\n")[7]}\n`]);

            await runDailyCompression({ now: new Date("2026-10-20T12:00:00"), logsDir: dir, releaseGraceMs: 0 });
            expect(existsSync(`${sealed}.zst`)).toBe(true);
            const carried = await search([`${sealed}.zst`], join(dir, "no-rg"));
            expect([carried.code, carried.keptFiles, carried.stdout]).toEqual([0, 1, kept.stdout]);

            writeFileSync(join(dir, "2026-10-10.log"), logText(400));
            await compressFile({ source: join(dir, "2026-10-10.log") });
            const changed = await search([`${sealed}.zst`]);
            expect([changed.code, changed.keptFiles]).toEqual([0, 0]);
        }
    );

    it.skipIf(!ripgrepBinary())("ripgrepFiles finds the same lines in a .zst as in its plain twin", async () => {
        const dir = scratch("rg");
        const plain = join(dir, "a.log");
        writeFileSync(plain, logText(5000));
        const twin = join(dir, "b.log");
        writeFileSync(twin, logText(5000));
        await compressFile({ source: twin, frameBytes: 16 * 1024 });
        const args = ["--no-config", "--no-filename", "--no-line-number", "-F", "-e", '"n":42,', "-e", "line 4999"];

        const plainRun = await ripgrepFiles({ rg: ripgrepBinary()!, args, files: [plain] });
        const zstRun = await ripgrepFiles({ rg: ripgrepBinary()!, args, files: [`${twin}.zst`] });
        const both = await ripgrepFiles({ rg: ripgrepBinary()!, args, files: [plain, `${twin}.zst`] });
        const absent = await ripgrepFiles({
            rg: ripgrepBinary()!,
            args: ["--no-config", "-F", "absent"],
            files: [`${twin}.zst`],
        });

        expect(zstRun.code).toBe(0);
        expect(zstRun.stdout).toBe(plainRun.stdout);
        expect(zstRun.stdout.split("\n").filter(Boolean)).toHaveLength(2);
        expect(both.stdout).toBe(plainRun.stdout + zstRun.stdout);
        const streamed: string[] = [];
        const lineRun = await ripgrepFiles({
            rg: ripgrepBinary()!,
            args,
            files: [plain, `${twin}.zst`],
            onLine: (line) => streamed.push(line),
        });
        expect(lineRun.stdout).toBe("");
        expect(streamed.sort()).toEqual(both.stdout.split("\n").filter(Boolean).sort());
        expect(absent.code).toBe(1);
    });
});
