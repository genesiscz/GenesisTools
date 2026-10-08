import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRecordsAppendOnly } from "./record-cache";

const root = mkdtempSync(join(tmpdir(), "gt-record-cache-"));
const line = (n: number) => `{"type":"event","n":${n},"text":"${"x".repeat(n % 7)}"}`;
const read = (path: string) => readRecordsAppendOnly(path, { minCacheBytes: 0 });

describe("readRecordsAppendOnly", () => {
    test("appends, an unfinished last line and its completion read like a fresh file", () => {
        const path = join(root, "growing.jsonl");
        writeFileSync(path, `${line(1)}\n${line(2)}\n`);
        expect(read(path).map((record) => record.n)).toEqual([1, 2]);

        appendFileSync(path, `${line(3)}\n{"type":"event","n":4`);
        // The half-written record is not a record yet, and is not kept.
        expect(read(path).map((record) => record.n)).toEqual([1, 2, 3]);

        appendFileSync(path, `,"text":""}\n${line(5)}`);
        // A last line with no newline yet still counts, as a full read counts it.
        expect(read(path).map((record) => record.n)).toEqual([1, 2, 3, 4, 5]);
        appendFileSync(path, `\n${line(6)}\n`);
        expect(read(path).map((record) => record.n)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    test("a rewrite in place, a replaced file and a missing file start over", () => {
        const path = join(root, "rewritten.jsonl");
        writeFileSync(path, `${line(1)}\n${line(2)}\n`);
        expect(read(path).map((record) => record.n)).toEqual([1, 2]);
        writeFileSync(path, `${line(7)}\n${line(8)}\n${line(9)}\n`);
        expect(read(path).map((record) => record.n)).toEqual([7, 8, 9]);

        const other = join(root, "other.jsonl");
        writeFileSync(other, `${line(10)}\n`);
        renameSync(other, path);
        expect(read(path).map((record) => record.n)).toEqual([10]);
        expect(read(join(root, "missing.jsonl"))).toEqual([]);
    });
});
