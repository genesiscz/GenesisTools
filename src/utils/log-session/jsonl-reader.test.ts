import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterFromSeq, filterLineRecords, lastNLines, readJsonlFile } from "./jsonl-reader";

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs) {
        rmSync(d, { recursive: true, force: true });
    }
});

function writeFixture(dir: string): string {
    const path = join(dir, "s.jsonl");
    const lines = [
        '{"type":"meta","session":"s"}',
        '{"type":"line","seq":1,"out":"stdout","ts":1,"text":"a"}',
        '{"type":"line","seq":2,"out":"stderr","ts":2,"text":"b"}',
        '{"type":"line","seq":3,"out":"stdout","ts":3,"text":"c"}',
        '{"type":"line","seq":4,"out":"stdout","ts":4,"text":"d"}',
        '{"type":"line","seq":5,"out":"stderr","ts":5,"text":"e"}',
    ];
    writeFileSync(path, `${lines.join("\n")}\n`);
    return path;
}

describe("JsonlReader", () => {
    it("reads all records from file", async () => {
        const dir = mkdtempSync(join(tmpdir(), "jr-"));
        dirs.push(dir);
        const path = writeFixture(dir);
        const records = await readJsonlFile(path);
        expect(records.length).toBe(6);
    });

    it("filterFromSeq returns seq 3 onward", async () => {
        const dir = mkdtempSync(join(tmpdir(), "jr-"));
        dirs.push(dir);
        const path = writeFixture(dir);
        const records = await readJsonlFile(path);
        const lines = filterLineRecords(records);
        const filtered = filterFromSeq(lines, 3);
        expect(filtered.map((l) => l.seq)).toEqual([3, 4, 5]);
    });

    it("lastNLines returns last N by seq", async () => {
        const dir = mkdtempSync(join(tmpdir(), "jr-"));
        dirs.push(dir);
        const path = writeFixture(dir);
        const records = await readJsonlFile(path);
        const lines = filterLineRecords(records);
        const tail = lastNLines(lines, 2);
        expect(tail.map((l) => l.seq)).toEqual([4, 5]);
    });
});
