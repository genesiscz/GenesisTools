import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTailBytes } from "./session.utils";

describe("readTailBytes", () => {
    let dir: string;

    function writeTmpFile(name: string, content: string): string {
        const p = join(dir, name);
        writeFileSync(p, content);
        return p;
    }

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "readtail-"));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("returns all lines when file is smaller than byte budget", async () => {
        const path = writeTmpFile("small.jsonl", '{"a":1}\n{"b":2}\n{"c":3}\n');
        const lines = await readTailBytes(path, 8192);
        expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    });

    it("drops partial first line when slicing mid-line", async () => {
        // Build a file where slicing the last 30 bytes cuts a line in half
        const line1 = '{"id":"aaaaaaaaaaaaaaaaaaa"}';
        const line2 = '{"id":"bbb"}';
        const line3 = '{"id":"ccc"}';
        const content = `${line1}\n${line2}\n${line3}\n`;
        const path = writeTmpFile("midline.jsonl", content);

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
        const path = writeTmpFile("boundary.jsonl", content);

        // Slice exactly the last two lines + their newlines
        const tailContent = `${line2}\n${line3}\n`;
        const lines = await readTailBytes(path, tailContent.length);

        // BUG: currently drops line2 even though it's complete
        expect(lines).toEqual([line2, line3]);
    });
});
