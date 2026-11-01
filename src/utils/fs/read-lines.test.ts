import { afterAll, describe, expect, it } from "bun:test";
import { appendFileSync, createReadStream, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { compressBytes } from "@genesiscz/utils/compress/zstd";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    readFirstLines,
    readLastLines,
    readLines,
    readLinesBackwardSync,
    readLinesSync,
    readWholeTextSync,
    splitLines,
    splitLinesSync,
} from "./read-lines";

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

    it("reads only what was appended after an earlier walk's end, the line at that offset whole", () => {
        const path = file("backward-from.txt", "old\nkept\n");
        let end = -1;
        expect([...readLinesBackwardSync(path, { onSource: (value) => (end = value) })]).toEqual(["kept", "old"]);
        appendFileSync(path, "new one\nnewest\n");

        for (const chunkBytes of [1, 3, 1024]) {
            const walk = readLinesBackwardSync(path, { chunkBytes, fromOffset: end });
            const seen: string[] = [];
            let next = walk.next();

            while (!next.done) {
                seen.push(next.value);
                next = walk.next();
            }

            expect(seen).toEqual(["newest", "new one"]);
            expect(next.value).toMatchObject({ reason: "offset", position: end, bytesRead: 15 });
        }

        // Nothing appended since: nothing is read, and it is still a clean end.
        expect(readLinesBackwardSync(path, { fromOffset: statSync(path).size }).next()).toMatchObject({
            done: true,
            value: { reason: "offset", bytesRead: 0 },
        });
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

describe("compressed files (Codex 0.164 compresses its old rollouts to .jsonl.zst)", () => {
    const text = 'old\n{"a":1}\nžluťoučký kůň\n\nsplit across frames\nnewest without newline';
    const plain = file("rollout.jsonl", text);
    // Codex writes one frame; the repo's own writer writes many. Two frames cut mid-line test the carry.
    const single = file("rollout-single.jsonl.zst", "");
    writeFileSync(single, compressBytes(text));
    const cut = text.indexOf("across");
    const multi = file("rollout-multi.jsonl.zst", "");
    writeFileSync(multi, Buffer.concat([compressBytes(text.slice(0, cut)), compressBytes(text.slice(cut))]));

    it("reads the same lines backwards as the plain file, from one frame and across frames", () => {
        const expected = [...readLinesBackwardSync(plain)];

        expect(expected[0]).toBe("newest without newline");
        expect([...readLinesBackwardSync(single)]).toEqual(expected);
        expect([...readLinesBackwardSync(multi)]).toEqual(expected);
    });

    it("reports the plain file's byte offsets and stops at the same maxBytes, counted in decompressed bytes", () => {
        const walk = (path: string, maxBytes?: number) => {
            const offsets: number[] = [];
            const lines: string[] = [];
            const reader = readLinesBackwardSync(path, { maxBytes, onLine: (offset) => offsets.push(offset) });
            let next = reader.next();

            while (!next.done) {
                lines.push(next.value);
                next = reader.next();
            }

            return { lines, offsets, end: next.value };
        };

        expect(walk(plain, 30).end.reason).toBe("maxBytes");

        for (const maxBytes of [undefined, 30, 45]) {
            const expected = walk(plain, maxBytes);
            expect(walk(single, maxBytes)).toEqual(expected);
            expect(walk(multi, maxBytes)).toEqual(expected);
        }
    });

    it("readWholeTextSync gives the plain text of either form", () => {
        expect(readWholeTextSync(plain)).toBe(text);
        expect(readWholeTextSync(single)).toBe(text);
        expect(readWholeTextSync(multi)).toBe(text);
    });
});

async function collect(lines: AsyncIterable<string>): Promise<string[]> {
    const out: string[] = [];

    for await (const line of lines) {
        out.push(line);
    }

    return out;
}

/** The same content as a plain file, a one-frame `.zst`, and a `.zst` of 3-byte frames (lines and characters cut). */
function threeForms(name: string, content: string): string[] {
    const bytes = Buffer.from(content);
    const pieces: Buffer[] = [];

    for (let at = 0; at < bytes.length; at += 3) {
        pieces.push(Buffer.from(compressBytes(bytes.subarray(at, at + 3))));
    }

    const single = file(`${name}-single.zst`, "");
    writeFileSync(single, compressBytes(bytes));
    const multi = file(`${name}-multi.zst`, "");
    writeFileSync(multi, Buffer.concat(pieces));
    return [file(name, content), single, multi];
}

describe("lines are cut at \\n only (readLines, readLinesSync, splitLines)", () => {
    it("keeps a JSON string with raw U+2028 and U+2029 on one line, plain and .zst, where node:readline cuts it", async () => {
        const record = SafeJSON.stringify({ text: "before between after" }, { strict: true });
        // JSON.stringify leaves both characters raw, which is what made readline cut 144 hook-log records in two.
        expect(record).toContain(" ");
        const content = `${record}\n${record}\n`;
        const expected = [record, record, ""];

        for (const path of threeForms("separators.jsonl", content)) {
            expect([...readLinesSync(path)]).toEqual(expected);
            expect(await collect(readLines(path))).toEqual(expected);
        }

        const plain = join(dir, "separators.jsonl");
        expect(await collect(splitLines(createReadStream(plain, { highWaterMark: 5 })))).toEqual(expected);
        // The regression anchor: readline also ends a line at U+2028 and U+2029, so no reader here may use it.
        const viaReadline = await collect(createInterface({ input: createReadStream(plain), crlfDelay: Infinity }));
        const pieces = ['{"text":"before', "between", 'after"}'];
        expect(viaReadline).toEqual([...pieces, ...pieces]);
    });

    it('gives a .zst and its plain file the same lines as text.split("\\n"), sync and async, at every chunk size', async () => {
        const cases: Record<string, string> = {
            trailingNewline: "a\nb\n",
            noTrailingNewline: "a\nb",
            emptyLastLines: "a\n\n\n",
            empty: "",
            crlf: "a\r\nb\r\n\r\nc",
            multiByte: "žluťoučký\nkůň\n🙂 end",
        };

        for (const [name, content] of Object.entries(cases)) {
            const expected = content.split("\n");

            for (const path of threeForms(`${name}.txt`, content)) {
                expect([...readLinesSync(path)]).toEqual(expected);
                expect(await collect(readLines(path))).toEqual(expected);
            }

            const plain = join(dir, `${name}.txt`);

            for (const chunkBytes of [1, 2, 5]) {
                expect([...readLinesSync(plain, { chunkBytes })]).toEqual(expected);
                const stream = createReadStream(plain, { highWaterMark: chunkBytes });
                expect(await collect(splitLines(stream))).toEqual(expected);
            }

            expect([...splitLinesSync(content.match(/[\s\S]{1,2}/gu) ?? [])]).toEqual(expected);
        }
    });

    it("readLines throws for a missing file", async () => {
        await expect(collect(readLines(join(dir, "missing.txt")))).rejects.toThrow();
    });
});
