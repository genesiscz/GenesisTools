import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHeadTail, readHeadTailLines, readTailBytes } from "./session.utils";

describe("readTailBytes", () => {
    let dir: string;

    async function writeTmpFile(name: string, content: string): Promise<string> {
        const p = join(dir, name);
        await Bun.write(p, content);
        return p;
    }

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "readtail-"));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("returns no lines for a transcript that no longer exists", async () => {
        expect(await readTailBytes(join(dir, "gone.jsonl"), 8192)).toEqual([]);
    });

    it("returns all lines when file is smaller than byte budget", async () => {
        const path = await writeTmpFile("small.jsonl", '{"a":1}\n{"b":2}\n{"c":3}\n');
        const lines = await readTailBytes(path, 8192);
        expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    });

    it("drops partial first line when slicing mid-line", async () => {
        // Build a file where slicing the last 30 bytes cuts a line in half
        const line1 = '{"id":"aaaaaaaaaaaaaaaaaaa"}';
        const line2 = '{"id":"bbb"}';
        const line3 = '{"id":"ccc"}';
        const content = `${line1}\n${line2}\n${line3}\n`;
        const path = await writeTmpFile("midline.jsonl", content);

        // Slice enough to get lines 2+3 but cut into line1
        const byteBudget = line2.length + line3.length + 5;
        const lines = await readTailBytes(path, byteBudget);
        expect(lines).toEqual([line2, line3]);
    });

    it("preserves first line when slice starts exactly on a line boundary", async () => {
        const line1 = '{"id":"first"}';
        const line2 = '{"id":"second"}';
        const line3 = '{"id":"third"}';
        const content = `${line1}\n${line2}\n${line3}\n`;
        const path = await writeTmpFile("boundary.jsonl", content);

        // Slice exactly the last two lines + their newlines
        const tailContent = `${line2}\n${line3}\n`;
        const lines = await readTailBytes(path, tailContent.length);

        // BUG: currently drops line2 even though it's complete
        expect(lines).toEqual([line2, line3]);
    });
});

describe("readHeadTail", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "readheadtail-"));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    async function file(count: number): Promise<string> {
        const p = join(dir, "s.jsonl");
        await Bun.write(p, `${Array.from({ length: count }, (_, i) => `{"n":${i}}`).join("\n")}\n\n`);
        return p;
    }

    it("returns the head and tail of a long file with the total count of non-blank lines", async () => {
        const result = await readHeadTail(await file(10), 2, 3);

        expect(result.lines).toEqual(['{"n":0}', '{"n":1}', '{"n":7}', '{"n":8}', '{"n":9}']);
        expect(result.total).toBe(10);
    });

    it("a zero tail returns only the head, not the whole file", async () => {
        const path = await file(10);

        expect(await readHeadTailLines(path, 3, 0)).toEqual(['{"n":0}', '{"n":1}', '{"n":2}']);
        expect((await readHeadTail(path, 3, 0)).total).toBe(10);
    });

    it("a short file comes back whole", async () => {
        expect(await readHeadTail(await file(4), 2, 3)).toEqual({
            lines: ['{"n":0}', '{"n":1}', '{"n":2}', '{"n":3}'],
            total: 4,
        });
    });
});
