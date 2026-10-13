import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFirstLines, readLastLines } from "./read-lines";

const dir = mkdtempSync(join(tmpdir(), "read-lines-"));

function file(name: string, content: string): string {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
}

afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

for (const method of ["fs", "ffi"] as const) {
    describe(`readFirstLines (${method})`, () => {
        it("returns every line of a file shorter than the read, dropping empty lines and \\r", () => {
            const path = file("short.jsonl", "a\r\n\nb\nlast without newline");

            expect(readFirstLines(path, { method })).toEqual({
                lines: ["a", "b", "last without newline"],
                wholeFile: true,
            });
        });

        it("leaves out a line cut by the end of the read", () => {
            const path = file("cut.jsonl", "first\nsecond\nthird line that is cut\n");

            expect(readFirstLines(path, { maxBytes: 16, method })).toEqual({
                lines: ["first", "second"],
                wholeFile: false,
            });
        });

        it("knows a file of exactly maxBytes is whole", () => {
            const path = file("exact.jsonl", "12345\n6789\n");

            expect(readFirstLines(path, { maxBytes: 11, method })).toEqual({
                lines: ["12345", "6789"],
                wholeFile: true,
            });
        });

        it("gives no lines when the first line is longer than the read, and decodes multi-byte text", () => {
            expect(readFirstLines(file("long.jsonl", `${"x".repeat(100)}\n`), { maxBytes: 10, method }).lines).toEqual(
                []
            );
            expect(readFirstLines(file("utf8.jsonl", "žluťoučký kůň\n"), { method }).lines).toEqual(["žluťoučký kůň"]);
        });
    });

    describe(`readLastLines (${method})`, () => {
        it("returns the last whole lines and keeps an unfinished last line", () => {
            const path = file("tail.jsonl", "old line\nmiddle\nnewest\nhalf-written");

            expect(readLastLines(path, { maxBytes: 27, method })).toEqual({
                lines: ["middle", "newest", "half-written"],
                wholeFile: false,
            });
        });

        it("keeps the first line of the window when the byte before it is a newline", () => {
            const path = file("boundary.jsonl", "abc\ndef\n");

            expect(readLastLines(path, { maxBytes: 4, method })).toEqual({ lines: ["def"], wholeFile: false });
            expect(readLastLines(path, { maxBytes: 100, method })).toEqual({ lines: ["abc", "def"], wholeFile: true });
        });

        it("gives no lines when one line fills the whole window", () => {
            expect(readLastLines(file("one.jsonl", `${"y".repeat(50)}`), { maxBytes: 10, method }).lines).toEqual([]);
        });

        it("throws for a missing file", () => {
            expect(() => readLastLines(join(dir, "missing.jsonl"), { method })).toThrow();
        });
    });
}

describe("readLastLines window bound", () => {
    it.each(["fs", "ffi"] as const)(
        "keeps only lines inside the last maxBytes, also one byte short of the whole file (%s)",
        (method) => {
            const path = join(dir, `bound-${method}.txt`);
            writeFileSync(path, "abc\ndef\n");

            expect(readLastLines(path, { maxBytes: 7, method })).toEqual({ lines: ["def"], wholeFile: false });
            expect(readLastLines(path, { maxBytes: 6, method })).toEqual({ lines: ["def"], wholeFile: false });
            expect(readLastLines(path, { maxBytes: 8, method })).toEqual({ lines: ["abc", "def"], wholeFile: true });
            expect(readLastLines(path, { maxBytes: 4, method })).toEqual({ lines: ["def"], wholeFile: false });
        }
    );

    it("keeps the first line when the byte before the window is a newline", () => {
        const path = join(dir, "bound-newline.txt");
        writeFileSync(path, "\nabc\ndef\n");

        expect(readLastLines(path, { maxBytes: 8 })).toEqual({ lines: ["abc", "def"], wholeFile: false });
    });
});
