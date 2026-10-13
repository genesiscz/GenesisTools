import { afterAll, describe, expect, it } from "bun:test";
import {
    chmodSync,
    closeSync,
    existsSync,
    fstatSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFirstLines, readLastLines, readLinesSync } from "@genesiscz/utils/fs/read-lines";
import { compressFile, digestZstdContent, verifyCompressedFile } from "./file";
import { searchLedger } from "./ledger";
import { compressPath, expandPath, verifyPath } from "./operations";
import { PRESETS, resolvePreset, sniffSample } from "./presets";
import {
    applyFolderRetention,
    applyOldFileCompression,
    planFolderRetention,
    planOldFileCompression,
} from "./retention";
import { listArchive, packDirectory, unpackArchive, verifyArchiveAgainstFolder } from "./tar";
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

        const bytes = readFileSync(result.target);
        bytes[Math.floor(bytes.length / 2)]! ^= 0xff;
        writeFileSync(result.target, bytes);
        expect(verifyCompressedFile(result.target, result)).toBe(false);
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
    it("sniffs signatures, text and random bytes, and refuses already-compressed data", () => {
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
        expect(compressPath({ source: random, caller: "test" })).rejects.toThrow("--force");
    });
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

        const report = await applyOldFileCompression(plan, { caller: "test" });
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
