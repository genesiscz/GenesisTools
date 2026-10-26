import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFirstLines, readLastLines, readLinesBackwardSync } from "./read-lines";

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

describe("readLinesBackwardSync", () => {
    it("yields every line newest first across chunk borders, a missing last newline and blank lines skipped", () => {
        const lines = Array.from({ length: 50 }, (_, index) => `line ${index} ${"x".repeat(index % 7)}`);
        const path = file("backward.txt", `${lines.join("\n")}\n\npartial`);

        for (const chunkBytes of [1, 3, 16, 1024]) {
            expect([...readLinesBackwardSync(path, { chunkBytes })]).toEqual(["partial", ...lines.reverse()]);
            lines.reverse();
        }
    });

    it("reads no further back than the caller iterates", () => {
        const path = file("backward-stop.txt", "old\nmiddle\nnew\n");
        const seen: string[] = [];

        for (const line of readLinesBackwardSync(path, { chunkBytes: 4 })) {
            seen.push(line);

            if (line === "middle") {
                break;
            }
        }

        expect(seen).toEqual(["new", "middle"]);
        expect([...readLinesBackwardSync(file("empty.txt", ""))]).toEqual([]);
    });
});

describe("bounded backward reads", () => {
    it("caps physical reads inside an oversized row and discards its partial content", () => {
        const path = file("bounded-row.txt", `${"x".repeat(1024 * 1024)}\nnew\n`);
        const walk = readLinesBackwardSync(path, { chunkBytes: 7, maxBytes: 64 });
        expect(walk.next()).toMatchObject({ done: false, value: "new" });
        expect(walk.next()).toMatchObject({
            done: true,
            value: { reason: "maxBytes", bytesRead: 64, position: 1024 * 1024 + 5 - 64 },
        });
    });

    it("honors an abort before reading and between yields within one chunk", () => {
        const path = file("abort-backward.txt", "old\nnew\n");
        const controller = new AbortController();
        const walk = readLinesBackwardSync(path, { signal: controller.signal });
        expect(walk.next().value).toBe("new");
        controller.abort();
        expect(walk.next()).toMatchObject({ done: true, value: { reason: "aborted" } });
        expect(readLinesBackwardSync(path, { signal: controller.signal }).next()).toMatchObject({
            done: true,
            value: { reason: "aborted", bytesRead: 0 },
        });
    });

    it("reports stable absolute line offsets across appends and chunk boundaries", () => {
        const path = file("backward-offset.txt", "old\nnew\n");
        const offsets: number[] = [];
        expect([...readLinesBackwardSync(path, { chunkBytes: 2, onLine: (offset) => offsets.push(offset) })]).toEqual([
            "new",
            "old",
        ]);
        expect(offsets).toEqual([4, 0]);
    });
});

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
