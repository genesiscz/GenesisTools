import { dlopen, FFIType } from "bun:ffi";
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
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
    writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createZstdCompress, constants as zlibConstants } from "node:zlib";
import { env } from "@genesiscz/utils/env";
import { fileFlags, SF_DATALESS } from "@genesiscz/utils/fs/cloud-placeholder";
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
import { compressFile, decompressFile, digestZstdContent, sourceUnchanged, verifyCompressedFile } from "./file";
import { recordCompression, searchLedger } from "./ledger";
import { CompressRefusal, compressPath, expandPath, planCompressPath, sampleFolder, verifyPath } from "./operations";
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
    TarLister,
    unpackArchive,
    verifyArchiveAgainstFolder,
} from "./tar";
import { compressStream, createVerifiedZstdBatch, createVerifiedZstdWriter, ZstdVerificationError } from "./verified";
import { readSeekTable, readZstdFrames, readZstdFramesSync, SeekableZstdWriter, walkFrames, zstdFrames } from "./zstd";

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

interface TarEntryFixture {
    name: string;
    flag: string;
    data?: string | Uint8Array;
    linkName?: string;
}

/** Text with varied lines, so frames neither repeat nor compress to nothing. */
function logText(lines: number): string {
    return Array.from(
        { length: lines },
        (_, index) => `{"n":${index},"msg":"line ${index} ${"x".repeat(index % 50)}"}`
    ).join("\n");
}

/** One zstd frame with a 2 GiB window and no content size: what `zstd --long=31` writes from a pipe. */
function longWindowZstd(data: Uint8Array): Promise<Buffer> {
    const encoder = createZstdCompress({
        params: {
            [zlibConstants.ZSTD_c_windowLog]: 31,
            [zlibConstants.ZSTD_c_enableLongDistanceMatching]: 1,
        },
    });
    const chunks: Buffer[] = [];
    encoder.on("data", (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<Buffer>((resolve, reject) => {
        encoder.on("end", () => resolve(Buffer.concat(chunks)));
        encoder.on("error", reject);
    });
    encoder.end(data);
    return done;
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

    it("replacing a target without a mode keeps the target's mode from the partial's first write", async () => {
        const dir = scratch("verified-mode");
        const target = join(dir, "private.jsonl.zst");
        const shared = join(dir, "shared.jsonl.zst");
        writeFileSync(target, "old private");
        chmodSync(target, 0o600);
        writeFileSync(shared, "old shared");
        chmodSync(shared, 0o640);
        const modes: number[] = [];
        const write = atomicWriteIo.writeSync;
        const probe = spyOn(atomicWriteIo, "writeSync").mockImplementation((fd, bytes, offset, length) => {
            modes.push(fstatSync(fd).mode & 0o777);
            return write(fd, bytes, offset, length);
        });

        try {
            await compressStream([logText(200)], { target, caller: "test-verified-mode" });
        } finally {
            probe.mockRestore();
        }

        expect(modes.length).toBeGreaterThan(0);
        expect(modes.every((mode) => mode === 0o600)).toBe(true);
        expect(statSync(target).mode & 0o777).toBe(0o600);
        await compressStream([logText(20)], { target: shared, caller: "test-verified-mode" });
        expect(statSync(shared).mode & 0o777).toBe(0o640);
        const umaskDefault = join(dir, "umask-default");
        writeFileSync(umaskDefault, "");
        const fresh = join(dir, "fresh.jsonl.zst");
        await compressStream([logText(20)], { target: fresh, caller: "test-verified-mode" });
        expect(statSync(fresh).mode & 0o777).toBe(statSync(umaskDefault).mode & 0o777);
    });

    const enospc = (call: string) =>
        Object.assign(new Error(`ENOSPC: no space left on device, ${call}`), { code: "ENOSPC" });

    /** A full disk on the file at `path` only: every write to it throws ENOSPC, every other file is written. */
    function failWritesTo(path: string) {
        const inode = statSync(path).ino;
        const write = atomicWriteIo.writeSync;

        return spyOn(atomicWriteIo, "writeSync").mockImplementation((fd, bytes, offset, length) => {
            if (fstatSync(fd).ino === inode) {
                throw enospc("write");
            }

            return write(fd, bytes, offset, length);
        });
    }

    /** The fsync of the file at `path` throws ENOSPC; every other fsync runs. */
    function failFsyncOf(path: string) {
        const inode = statSync(path).ino;
        const fsync = atomicWriteIo.fsyncSync;

        return spyOn(atomicWriteIo, "fsyncSync").mockImplementation((fd) => {
            if (fstatSync(fd).ino === inode) {
                throw enospc("fsync");
            }

            fsync(fd);
        });
    }

    it("a write or an fsync that fails removes the partial, keeps the existing target and records nothing", async () => {
        const dir = scratch("verified-io-fail");
        const target = join(dir, "kept.jsonl.zst");
        writeFileSync(target, "the existing target");
        const failWrite = createVerifiedZstdWriter(target, {
            caller: "test-verified-io",
            frameBytes: 4096,
            threads: 1,
        });
        const writeProbe = failWritesTo(failWrite.partialPath);

        try {
            await expect(failWrite.push(logText(2000))).rejects.toThrow("ENOSPC");
        } finally {
            writeProbe.mockRestore();
        }

        const failSync = createVerifiedZstdWriter(target, { caller: "test-verified-io", frameBytes: 4096 });
        await failSync.push(logText(2000));
        const syncProbe = failFsyncOf(failSync.partialPath);

        try {
            await expect(failSync.commit()).rejects.toThrow("ENOSPC");
        } finally {
            syncProbe.mockRestore();
        }

        expect([failWrite.state, failSync.state]).toEqual(["aborted", "aborted"]);
        expect(readdirSync(dir)).toEqual(["kept.jsonl.zst"]);
        expect(readFileSync(target, "utf8")).toBe("the existing target");
        expect(searchLedger({ caller: "test-verified-io", path: dir })).toEqual([]);
    });

    it("a batch member whose fsync fails renames no output of the batch and removes every partial", async () => {
        const dir = scratch("verified-batch-fsync");
        const first = join(dir, "a.jsonl.zst");
        const second = join(dir, "b.jsonl.zst");
        writeFileSync(first, "old first");
        writeFileSync(second, "old second");
        const batch = createVerifiedZstdBatch({ caller: "test-verified-batch-fsync", frameBytes: 4096 });
        const writers = [first, second].map((target) => batch.add(target));
        const probe = failFsyncOf(writers[1]!.partialPath);
        let failure: unknown;

        try {
            for (const writer of writers) {
                await writer.push(logText(300));
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
        expect(readdirSync(dir).sort()).toEqual(["a.jsonl.zst", "b.jsonl.zst"]);
        expect(searchLedger({ caller: "test-verified-batch-fsync", path: dir })).toEqual([]);
    });

    it("a rename that fails after the batch verified keeps the earlier outputs renamed and removes the rest", async () => {
        const dir = scratch("verified-batch-rename");
        const gone = join(dir, "gone");
        mkdirSync(gone);
        const first = join(dir, "2026-10-30.jsonl.zst");
        const second = join(gone, "2026-10-31.jsonl.zst");
        const third = join(dir, "2026-11-01.jsonl.zst");
        writeFileSync(first, "old first");
        writeFileSync(third, "old third");
        const batch = createVerifiedZstdBatch({ caller: "test-verified-rename", frameBytes: 4096 });
        const writers = [first, second, third].map((target) => batch.add(target));

        for (const [index, writer] of writers.entries()) {
            await writer.push(logText(300 + index));
            await writer.finish();
        }

        // Every output verified, none renamed yet; then the second one's folder goes before the batch renames.
        expect(readFileSync(first, "utf8")).toBe("old first");
        rmSync(gone, { recursive: true });
        const failure = await batch.commit().then(
            () => undefined,
            (err: unknown) => err
        );

        expect(failure instanceof Error ? failure.message : String(failure)).toBe(
            `${second} could not be renamed after the batch verified; renamed: ${first}`
        );
        expect([...readLinesSync(first)]).toEqual(logText(300).split("\n"));
        expect(readFileSync(third, "utf8")).toBe("old third");
        expect(writers.map((writer) => writer.state)).toEqual(["committed", "aborted", "aborted"]);
        expect(readdirSync(dir).sort()).toEqual(["2026-10-30.jsonl.zst", "2026-11-01.jsonl.zst"]);
        expect(searchLedger({ caller: "test-verified-rename", path: dir }).map((record) => record.target)).toEqual([
            first,
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

    /** One tar entry: a ustar header with its checksum, then the data padded to a block. */
    function tarEntry({ name, flag, data = "", linkName = "" }: TarEntryFixture): Buffer {
        const body = Buffer.from(data);
        const header = Buffer.alloc(512);
        header.write(name);
        header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
        header.write(flag, 156);
        header.write(linkName, 157);
        header.write("ustar\0", 257);
        header.fill(32, 148, 156);
        const sum = header.reduce((total, byte) => total + byte, 0);
        header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
        return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
    }

    /** A pax `x` header for the next entry, each record `<length> <key>=<value>\n`. */
    function paxEntry(records: Record<string, string>): Buffer {
        const text = Object.entries(records)
            .map(([key, value]) => {
                const line = ` ${key}=${value}\n`;
                let length = line.length + 1;

                while (`${length}${line}`.length !== length) {
                    length++;
                }

                return `${length}${line}`;
            })
            .join("");
        return tarEntry({ name: "PaxHeader/entry", flag: "x", data: text });
    }

    it("lists a GNU sparse 1.0 file under its real name and size, hashes it with zeros in the holes, and refuses a bad map", () => {
        // The form bsdtar writes for a file with holes (measured on macOS 26, bsdtar 3.5.3): the real name and size in
        // pax keys, a stand-in ustar name, and a map of data segments ahead of the data.
        const first = Buffer.from(Array.from({ length: 600 }, (_, index) => (index * 7) % 251));
        const second = Buffer.from("x".repeat(300));
        const content = Buffer.concat([Buffer.alloc(1000), first, Buffer.alloc(3400), second, Buffer.alloc(4700)]);
        const sparseArchive = (map: string, records: Record<string, string> = {}) => {
            const mapBlock = Buffer.concat([Buffer.from(map), Buffer.alloc(512 - map.length)]);
            return Buffer.concat([
                tarEntry({ name: "tree", flag: "5" }),
                paxEntry({
                    "GNU.sparse.major": "1",
                    "GNU.sparse.minor": "0",
                    "GNU.sparse.name": "tree/holes.bin",
                    "GNU.sparse.realsize": String(content.length),
                    ...records,
                }),
                tarEntry({
                    name: "tree/GNUSparseFile.0/holes.bin",
                    flag: "0",
                    data: Buffer.concat([mapBlock, first, second]),
                }),
                tarEntry({ name: "tree/holes-link.bin", flag: "1", linkName: "tree/holes.bin" }),
                Buffer.alloc(1024),
            ]);
        };
        const list = (tar: Buffer, chunk: number) => {
            const lister = new TarLister({ hash: true });

            for (let at = 0; at < tar.length; at += chunk) {
                lister.push(tar.subarray(at, at + chunk));
            }

            expect(lister.finished).toBe(true);
            return lister.entries;
        };
        const valid = sparseArchive("3\n1000\n600\n5000\n300\n10000\n0\n");

        for (const chunk of [7, 512, valid.length]) {
            expect(list(valid, chunk)).toEqual([
                { path: "tree", type: "directory", size: 0 },
                {
                    path: "tree/holes.bin",
                    type: "file",
                    size: 10000,
                    sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
                },
                { path: "tree/holes-link.bin", type: "hardlink", size: 0, linkTarget: "tree/holes.bin" },
            ]);
        }

        expect(() => list(sparseArchive("3\n1000\n600\n5000\n301\n10000\n0\n"), 512)).toThrow("does not match");
        expect(() => list(sparseArchive("3\n1000\n600\n900\n300\n10000\n0\n"), 512)).toThrow("overlap");
        expect(() =>
            list(sparseArchive("3\n1000\n600\n5000\n300\n10000\n0\n", { "GNU.sparse.minor": "1" }), 512)
        ).toThrow("unsupported GNU sparse format 1.1");
    });

    it("packs a macOS folder with sparse files, real ._ files and an xattr, verifies it, and unpacks it identically", async () => {
        const dir = scratch("mac-folder");
        const tree = join(dir, "tree");
        mkdirSync(join(tree, "empty"), { recursive: true });
        writeFileSync(join(tree, "plain.txt"), "plain\n");
        writeFileSync(join(tree, "real"), "real\n");
        writeFileSync(join(tree, "._real"), "a real file of the user, not AppleDouble data\n");
        writeFileSync(join(tree, "._orphan"), "a ._ file without a partner\n");
        // A data block then a hole, and a file that is all hole: APFS keeps both sparse, so bsdtar writes GNU sparse.
        // The second name is not ASCII, so bsdtar adds a pax `path` beside `GNU.sparse.name`.
        writeFileSync(join(tree, "holes.bin"), Buffer.alloc(70_000, 7));
        truncateSync(join(tree, "holes.bin"), 2 * 1024 * 1024);
        writeFileSync(join(tree, "naïve hole.bin"), "");
        truncateSync(join(tree, "naïve hole.bin"), 1024 * 1024);
        linkSync(join(tree, "holes.bin"), join(tree, "holes-link.bin"));
        linkSync(join(tree, "plain.txt"), join(tree, "plain-link.txt"));
        symlinkSync("plain.txt", join(tree, "link"));

        if (process.platform === "darwin") {
            const tag = Bun.spawnSync(["xattr", "-w", "com.example.tag", "red", join(tree, "plain.txt")], {
                env: process.env,
            });
            expect(tag.exitCode).toBe(0);
        }

        const packed = await packDirectory({ source: tree });
        const raw = Buffer.concat([...readZstdFramesSync(packed.archive)]).toString("latin1");
        expect(raw.includes("GNU.sparse.major=1")).toBe(process.platform === "darwin");
        expect(raw.includes("._plain.txt")).toBe(false);
        const check = verifyArchiveAgainstFolder({ archive: packed.archive, source: tree });
        expect(check).toEqual({ ok: true, entries: 11, missing: [], mismatched: [], extra: [] });

        const out = join(dir, "restored");
        await unpackArchive({ archive: packed.archive, destination: out });
        // bsdtar on macOS writes every extracted name in NFD, so the NFC name keeps its letters but not its bytes
        // (APFS opens it by either form). The archive keeps the source's form; restoring it is a separate change.
        const names = (folder: string) =>
            readdirSync(folder)
                .map((name) => name.normalize("NFC"))
                .sort();
        expect(names(join(out, "tree"))).toEqual(names(tree));

        for (const name of [
            "plain.txt",
            "plain-link.txt",
            "real",
            "._real",
            "._orphan",
            "holes.bin",
            "naïve hole.bin",
        ]) {
            expect(readFileSync(join(out, "tree", name)).equals(readFileSync(join(tree, name)))).toBe(true);
        }

        expect(statSync(join(out, "tree", "holes-link.bin")).ino).toBe(statSync(join(out, "tree", "holes.bin")).ino);
        expect(statSync(join(out, "tree", "plain-link.txt")).ino).toBe(statSync(join(out, "tree", "plain.txt")).ino);
        expect(readlinkSync(join(out, "tree", "link"))).toBe("plain.txt");
        expect(readdirSync(join(out, "tree", "empty"))).toEqual([]);

        // A byte written into a hole changes the rebuilt content, so the check still fails on it.
        const fd = openSync(join(tree, "holes.bin"), "r+");
        writeSync(fd, "!", 1024 * 1024);
        closeSync(fd);
        expect(verifyArchiveAgainstFolder({ archive: packed.archive, source: tree }).mismatched.sort()).toEqual([
            "tree/holes-link.bin",
            "tree/holes.bin",
        ]);
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

    it("verifies, unpacks and reads an archive with a 2 GiB window (zstd -19 --long=31 from a pipe)", async () => {
        const dir = scratch("long-window");
        const tree = makeTree(dir);
        const tar = Bun.spawnSync(["tar", "--no-xattrs", "-cf", "-", "-C", dir, "tree"], {
            env: { ...process.env, COPYFILE_DISABLE: "1" },
        });
        expect(tar.exitCode).toBe(0);
        // The zstd CLI writes a 2 GiB window and no content size when it reads a pipe; node's stream encoder with
        // windowLog 31 writes the same frame header, so the test runs where the CLI is missing too.
        const archives = [await longWindowZstd(tar.stdout)];

        if (Bun.which("zstd")) {
            const cli = Bun.spawnSync(["zstd", "-q", "-19", "--long=31", "-c"], {
                stdin: tar.stdout,
                env: process.env,
            });
            expect(cli.exitCode).toBe(0);
            archives.push(cli.stdout);
        }

        for (const [index, bytes] of archives.entries()) {
            expect({ singleSegment: (bytes[4]! >> 5) & 1, windowLog: 10 + (bytes[5]! >> 3) }).toEqual({
                singleSegment: 0,
                windowLog: 31,
            });
            const archive = join(dir, `long-${index}`, "tree.tar.zst");
            mkdirSync(join(dir, `long-${index}`));
            writeFileSync(archive, bytes);

            expect(Buffer.concat([...readZstdFramesSync(archive)]).equals(tar.stdout)).toBe(true);
            const streamed: Uint8Array[] = [];

            for await (const frame of readZstdFrames(archive)) {
                streamed.push(frame);
            }

            expect(Buffer.concat(streamed).equals(tar.stdout)).toBe(true);
            expect(verifyPath({ archive, against: tree }).ok).toBe(true);
            const into = join(dir, `restored-${index}`);
            await expandPath({ archive, into, caller: "test" });
            expect(readFileSync(join(into, "tree", "top.txt"), "utf8")).toBe("top\n");
        }
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

    it.skipIf(process.platform !== "darwin")(
        "refuses cloud placeholders by name before reading them, and --include-placeholders packs them as they are",
        async () => {
            const dir = scratch("placeholders");
            const tree = makeTree(dir);
            const stubs = Array.from({ length: 21 }, (_, index) => `stub-${String(index).padStart(2, "0")}.note`);

            for (const stub of stubs) {
                writeFileSync(join(tree, stub), Buffer.alloc(8192));
            }

            // One call marks every stub the way the Dropbox app marked an online-only file before File Provider.
            const marked = Bun.spawnSync(
                ["xattr", "-w", "com.dropbox.placeholder", "1", ...stubs.map((stub) => join(tree, stub))],
                { env: process.env }
            );
            expect(marked.exitCode).toBe(0);
            // Bytes in 0 blocks without the dataless flag: the content is here, so it is not a placeholder.
            writeFileSync(join(tree, "hole.bin"), "");
            truncateSync(join(tree, "hole.bin"), 64 * 1024);
            expect(statSync(join(tree, "hole.bin")).blocks).toBe(0);
            expect((fileFlags(join(tree, "hole.bin")) ?? 0) & SF_DATALESS).toBe(0);
            const normal = ["top.txt", "link", "hole.bin"];

            // A decmpfs file (UF_COMPRESSED) keeps its content in its xattrs: a normal file too.
            if (Bun.which("ditto")) {
                writeFileSync(join(dir, "plain.txt"), "line of text that repeats\n".repeat(2000));
                const ditto = Bun.spawnSync(
                    ["ditto", "--hfsCompression", join(dir, "plain.txt"), join(tree, "compressed.txt")],
                    { env: process.env }
                );
                expect(ditto.exitCode).toBe(0);
                expect((fileFlags(join(tree, "compressed.txt")) ?? 0) & 0x20).toBe(0x20);
                normal.push("compressed.txt");
            }

            const refusal = compressPath({ source: tree, force: true, caller: "test" });
            await expect(refusal).rejects.toBeInstanceOf(CompressRefusal);
            await expect(refusal).rejects.toThrow(
                /holds 21 cloud placeholders .*stub-00\.note, .*stub-19\.note and 1 more/
            );
            await expect(refusal).rejects.toThrow("cloud copy");
            expect(existsSync(`${tree}.zst`)).toBe(false);
            await expect(
                compressPath({ source: join(tree, "stub-00.note"), force: true, caller: "test" })
            ).rejects.toThrow("stub-00.note");
            // A symlink given as the source is read through, so its target is the file that is checked.
            const link = join(dir, "stub-link.note");
            symlinkSync(join(tree, "stub-00.note"), link);
            await expect(compressPath({ source: link, force: true, caller: "test" })).rejects.toThrow(
                `${link} holds 1 cloud placeholder (1 with the com.dropbox.placeholder xattr`
            );
            expect(existsSync(`${link}.zst`)).toBe(false);

            // The normal files beside the stubs pack without the flag.
            const listed = await compressPath({ source: tree, files: normal, force: true, caller: "test" });
            expect(listed.record.files).toBe(normal.length);
            rmSync(`${tree}.zst`);

            const { record } = await compressPath({
                source: tree,
                includePlaceholders: true,
                removeOriginal: true,
                force: true,
                caller: "test",
            });
            expect(record.removedOriginal).toBe(true);
            expect(existsSync(tree)).toBe(false);
            const stored = listArchive(`${tree}.zst`, { hash: true }).find(
                (entry) => entry.path === "tree/stub-00.note"
            );
            expect(stored?.size).toBe(8192);
            expect(stored?.sha256).toBe(new Bun.CryptoHasher("sha256").update(Buffer.alloc(8192)).digest("hex"));
        }
    );

    it("packs only the listed files of a folder under its name, verifies them, and removes only those", async () => {
        const dir = scratch("files-from");
        const tree = makeTree(dir);
        writeFileSync(join(tree, "a", "other.txt"), logText(50));
        const files = ["top.txt", "link", "a/empty"];
        const listed = await packDirectory({ source: tree, archive: join(dir, "listed.zst"), files });
        // The files, their parent folders and the top folder, nothing else: `tools compress unpack` takes the shape.
        expect(
            listArchive(listed.archive)
                .map((entry) => entry.path)
                .sort()
        ).toEqual(["tree", "tree/a", "tree/a/empty", "tree/link", "tree/top.txt"]);
        expect(verifyArchiveAgainstFolder({ archive: listed.archive, source: tree, files }).ok).toBe(true);
        expect(verifyPath({ archive: listed.archive, against: tree, files }).ok).toBe(true);
        expect(verifyPath({ archive: listed.archive, against: tree }).detail).toBe("3 missing, 0 different, 0 extra");
        writeFileSync(join(tree, "a", "other.txt"), "an unlisted file may change");
        expect(verifyArchiveAgainstFolder({ archive: listed.archive, source: tree, files }).ok).toBe(true);
        writeFileSync(join(tree, "top.txt"), "tip\n");
        expect(verifyArchiveAgainstFolder({ archive: listed.archive, source: tree, files }).mismatched).toEqual([
            "tree/top.txt",
        ]);
        writeFileSync(join(tree, "top.txt"), "top\n");

        const { record } = await compressPath({
            source: tree,
            files: [...files, "a/b/../empty", join(tree, "top.txt")],
            removeOriginal: true,
            force: true,
            caller: "test",
        });
        expect(record.files).toBe(3);
        expect(record.removedOriginal).toBe(true);
        expect(readdirSync(tree).sort()).toEqual(["a"]);
        expect(readdirSync(join(tree, "a")).sort()).toEqual(["b", "other.txt"]);
        const into = join(dir, "restored");
        await expandPath({ archive: `${tree}.zst`, into, caller: "test" });
        expect(readFileSync(join(into, "tree", "top.txt"), "utf8")).toBe("top\n");
        expect(readlinkSync(join(into, "tree", "link"))).toBe("top.txt");
        expect(readdirSync(join(into, "tree", "a"))).toEqual(["empty"]);

        mkdirSync(join(tree, "real"));
        symlinkSync("real", join(tree, "alias"));
        writeFileSync(join(tree, "real", "inside.txt"), "inside\n");

        for (const [list, refusal] of [
            [["../outside.txt"], "not inside"],
            [["a"], "is a folder"],
            [["missing.txt"], "does not exist"],
            [["alias/inside.txt"], "not a folder"],
            [[], "lists no files"],
        ] as const) {
            const target = join(dir, "refused.zst");
            await expect(
                compressPath({ source: tree, files: [...list], target, force: true, caller: "test" })
            ).rejects.toThrow(refusal);
            expect(existsSync(target)).toBe(false);
        }
    });

    it("keeps a backslash in a listed name on macOS and Linux, where it is part of the name, not a separator", async () => {
        const dir = scratch("files-backslash");
        const tree = makeTree(dir);

        if (process.platform === "win32") {
            // A backslash is the separator here, and no file name holds one.
            const plan = await planCompressPath({ source: tree, files: ["a\\empty"], force: true });
            expect(plan.files).toEqual(["a/empty"]);
            return;
        }

        // `a\empty` beside the folder `a` that holds `empty`: the list names the first, so only it is packed and removed.
        writeFileSync(join(tree, "a\\empty"), "backslash\n");
        const { record } = await compressPath({
            source: tree,
            files: ["a\\empty"],
            removeOriginal: true,
            force: true,
            caller: "test",
        });
        expect(record.files).toBe(1);
        expect(
            listArchive(record.target)
                .map((entry) => entry.path)
                .sort()
        ).toEqual(["tree", "tree/a\\empty"]);
        expect(existsSync(join(tree, "a\\empty"))).toBe(false);
        expect(existsSync(join(tree, "a", "empty"))).toBe(true);
        const into = join(dir, "restored");
        await expandPath({ archive: record.target, into, caller: "test" });
        expect(readFileSync(join(into, "tree", "a\\empty"), "utf8")).toBe("backslash\n");
    });

    it("records a pack's tar stream sha256, and unpack checks it against the newest record of the archive", async () => {
        const dir = scratch("pack-sha");
        const tree = makeTree(dir);
        const { record } = await compressPath({ source: tree, force: true, caller: "test" });
        const archive = `${tree}.zst`;
        // Bun's whole-file decoder, not the frame walker the writer and the readers share.
        const stream = Bun.zstdDecompressSync(readFileSync(archive));
        expect(record.inputSha256).toBe(new Bun.CryptoHasher("sha256").update(stream).digest("hex"));
        expect(record.outputSha256).not.toBe(record.inputSha256);

        const restored = await expandPath({ archive, into: join(dir, "restored"), caller: "test" });
        expect(restored.outputSha256).toBe(record.inputSha256);

        const { id: _id, inputSha256: _sha, ...oldShape } = record;
        recordCompression({ ...oldShape, inputSha256: "0".repeat(64) });
        const into = join(dir, "tampered");
        await expect(expandPath({ archive, into, caller: "test" })).rejects.toThrow("another sha256");
        expect(existsSync(join(into, "tree"))).toBe(false);

        // A pack recorded before the stream hash (no inputSha256) is the newest record again and does not block.
        recordCompression(oldShape);
        await expandPath({ archive, into: join(dir, "old-shape"), caller: "test" });
        expect(readFileSync(join(dir, "old-shape", "tree", "top.txt"), "utf8")).toBe("top\n");
    });

    it("unpack finds the pack record of an archive named by a relative or aliased path, and records -o absolute", async () => {
        const dir = scratch("pack-relative");
        makeTree(dir);
        const cwd = process.cwd();

        try {
            // The working folder is the resolved path (/private/var/... on macOS), while `dir` keeps tmpdir()'s alias.
            process.chdir(dir);
            const { record } = await compressPath({ source: "tree", target: "tree.zst", force: true, caller: "test" });
            expect(record.target).toBe(resolve("tree.zst"));

            const { id: _id, ...shape } = record;
            recordCompression({ ...shape, inputSha256: "0".repeat(64) });
            await expect(expandPath({ archive: "tree.zst", into: "relative", caller: "test" })).rejects.toThrow(
                "another sha256"
            );
            await expect(
                expandPath({ archive: join(dir, "tree.zst"), into: join(dir, "aliased"), caller: "test" })
            ).rejects.toThrow("another sha256");
            expect(existsSync(join(dir, "relative", "tree"))).toBe(false);

            recordCompression(shape);
            const restored = await expandPath({ archive: "tree.zst", into: "relative", caller: "test" });
            expect(restored.source).toBe(resolve("tree.zst"));
            expect(restored.outputSha256).toBe(record.inputSha256);
            expect(readFileSync(join(dir, "relative", "tree", "top.txt"), "utf8")).toBe("top\n");
        } finally {
            process.chdir(cwd);
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
            text: "9",
            tree: "9 long",
            binary: "9 long",
            database: "9",
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

    it("a skipped pack keeps the older archive and the drop it outranked, and a later pack retires them", async () => {
        const dir = scratch("retention-skipped");
        const day = 86_400_000;
        const now = new Date("2026-10-13T12:00:00Z");
        const age = (name: string, days: number) => {
            const seconds = (now.getTime() - days * day) / 1000;
            utimesSync(join(dir, name), seconds, seconds);
        };

        for (const [name, days] of [
            ["r1", 3],
            ["r2", 5],
        ] as const) {
            mkdirSync(join(dir, name));
            writeFileSync(join(dir, name, "data.jsonl"), logText(20));
            age(name, days);
        }

        writeFileSync(join(dir, "r0.zst"), "an older packed run");
        age("r0.zst", 40);
        const names = (paths: string[]) => paths.map((path) => path.split("/").pop());
        const options = { root: dir, keep: 0, maxArchives: 1, now };
        const plan = planFolderRetention(options);

        expect(names(plan.pack.map((item) => item.folder))).toEqual(["r1"]);
        expect(names(plan.drop)).toEqual(["r2"]);
        expect(names(plan.deleteArchives)).toEqual(["r0.zst"]);

        // No free space: r1 stays a folder, so it pushes out neither r2 nor r0.zst.
        const skipped = await applyFolderRetention(plan, { caller: "test", minFreeBytes: Number.MAX_SAFE_INTEGER });

        expect(names(skipped.skippedLowDisk)).toEqual(["r1"]);
        expect(skipped.removed).toEqual([]);
        expect(names(skipped.spared)).toEqual(["r2", "r0.zst"]);
        expect(readdirSync(dir).sort()).toEqual(["r0.zst", "r1", "r2"]);

        // With room, r1 is packed and takes the one place: the drop and the older archive go as planned.
        const packed = await applyFolderRetention(planFolderRetention(options), { caller: "test", minFreeBytes: 0 });

        expect(names(packed.removed)).toEqual(["r2", "r0.zst"]);
        expect(packed.spared).toEqual([]);
        expect(readdirSync(dir).sort()).toEqual(["r1.zst"]);
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
        // A small day: the race and the lock do not depend on its size, and the text preset compresses at level 22.
        const now = new Date("2026-10-13T12:00:00");
        const old = new Date("2026-10-10T12:00:00").getTime() / 1000;
        const dayOf = (relative: string) => /^(\d{4}-\d{2}-\d{2})\.log$/.exec(relative)?.[1];
        const day = (dir: string) => {
            const path = join(dir, "2026-10-10.log");
            writeFileSync(path, logText(2_000));
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
        expect([...readLinesSync(`${racedPath}.zst`)].join("\n")).toBe(logText(2_000));

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
        expect([...readLinesSync(`${lockedPath}.zst`)].join("\n")).toBe(logText(2_000));
    });

    it("keeps a file that another one replaced during the compression, a same-length copy with the old mtime too", async () => {
        const now = new Date("2026-10-13T12:00:00");
        const old = new Date("2026-10-10T12:00:00").getTime() / 1000;
        const dayOf = (relative: string) => /^(\d{4}-\d{2}-\d{2})\.log$/.exec(relative)?.[1];
        const dir = scratch("replaced");
        const path = join(dir, "2026-10-10.log");
        writeFileSync(path, logText(300));
        utimesSync(path, old, old);
        const before = statSync(path);
        const swapped = logText(300).replaceAll("x", "y");
        const fsync = atomicWriteIo.fsyncSync;
        let replaced = false;
        // The source is read when the `.zst` is synced; then another process renames its own copy over the name.
        const probe = spyOn(atomicWriteIo, "fsyncSync").mockImplementation((fd) => {
            if (!replaced) {
                replaced = true;
                const next = join(dir, "next.part");
                writeFileSync(next, swapped);
                utimesSync(next, old, old);
                renameSync(next, path);
            }

            return fsync(fd);
        });
        const plan = planOldFileCompression({ root: dir, dayOf, firstPlainDay: "2026-10-12", now });

        try {
            const report = await applyOldFileCompression(plan, { caller: "test", releaseGraceMs: 0 });
            expect(report.failed).toEqual([{ path, reason: "the file changed while it was compressed" }]);
        } finally {
            probe.mockRestore();
        }

        expect(replaced).toBe(true);
        expect([statSync(path).size, statSync(path).mtimeMs]).toEqual([before.size, before.mtimeMs]);
        expect(readFileSync(path, "utf8")).toBe(swapped);
        expect(existsSync(`${path}.zst`)).toBe(false);
        expect(sourceUnchanged(path, before)).toBe(false);
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

    it("readTextChunks and ripgrepFiles read the .zst of a plain file the daily pass retires just after they looked", async () => {
        const dir = scratch("twin-race");
        const plain = join(dir, "2026-10-10.log");
        const today = join(dir, "2026-10-13.log");
        writeFileSync(today, `${logText(30)}\ntoday only\n`);
        const lines = logText(50).split("\n");
        const exists = fs.existsSync;
        // The daily pass (another process) removes the plain file the moment after a reader found it.
        const retiredAfterLookup = async <T>(read: () => Promise<T>): Promise<T> => {
            writeFileSync(plain, logText(50));
            await compressFile({ source: plain, frameBytes: 1024 });
            const probe = spyOn(fs, "existsSync").mockImplementation((path) => {
                const found = exists(path);

                if (found && path === plain) {
                    unlinkSync(plain);
                }

                return found;
            });

            try {
                return await read();
            } finally {
                probe.mockRestore();
            }
        };

        const text = await retiredAfterLookup(async () => {
            const chunks: Buffer[] = [];

            for await (const chunk of readTextChunks(plain)) {
                chunks.push(Buffer.from(chunk));
            }

            return Buffer.concat(chunks).toString();
        });
        expect(text).toBe(logText(50));

        const rg = ripgrepBinary();

        if (!rg) {
            return;
        }

        const search = (pattern: string, onLine?: (line: string) => void) =>
            retiredAfterLookup(() =>
                ripgrepFiles({
                    rg,
                    args: ["--no-config", "--no-filename", "-F", "-e", pattern],
                    files: [plain, today],
                    onLine,
                })
            );
        const result = (run: { code: number; stdout: string; stderr: string }) => [run.code, run.stdout, run.stderr];

        expect(result(await search('"n":42,'))).toEqual([0, `${lines[42]}\n`, ""]);
        // Only the file that stayed matches: rg's exit 2 for the retired one must not hide that match.
        expect(result(await search("today only"))).toEqual([0, "today only\n", ""]);
        expect(result(await search("absent"))).toEqual([1, "", ""]);
        const streamed: string[] = [];
        expect(result(await search('"n":42,', (line) => streamed.push(line)))).toEqual([0, "", ""]);
        expect(streamed).toEqual([lines[42]]);
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

    it.skipIf(!ripgrepBinary())(
        "a .zst that does not decode fails the search with exit 2, and a cached search keeps nothing for it",
        async () => {
            const dir = scratch("rg-broken");
            const plain = join(dir, "2026-10-10.log");
            writeFileSync(plain, logText(2000));
            const { target } = await compressFile({ source: plain, frameBytes: 4096 });
            unlinkSync(plain);
            // A frame in the middle no longer passes its checksum: rg would count only the lines before it.
            const fd = openSync(target, "r+");
            writeSync(fd, Buffer.alloc(64, 0x41), 0, 64, Math.floor(statSync(target).size / 2));
            closeSync(fd);
            const args = ["--no-config", "--no-filename", "-c", "-F", "line"];

            const run = await ripgrepFiles({ rg: ripgrepBinary()!, args, files: [target] });
            expect([run.code, run.signal]).toEqual([2, null]);
            expect(run.stderr).toContain(target);

            const digest = { name: "t", dir: dayLogDigestsDir(dir), sealed: () => true };
            const cached = await ripgrepFilesCached({ rg: ripgrepBinary()!, args, files: [target], digest });
            expect([cached.code, cached.keptFiles]).toEqual([2, 0]);
            const digestPath = ripgrepDigestPath({ ...digest, args });
            const saved: unknown = existsSync(digestPath)
                ? SafeJSON.parse(readFileSync(digestPath, "utf8"), { strict: true })
                : { entries: {} };
            expect(isObject(saved) && isObject(saved.entries) ? Object.keys(saved.entries) : saved).toEqual([]);
        }
    );
});
