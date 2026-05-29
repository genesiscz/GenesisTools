import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countJsonlLineRecords } from "./count-line-records";

describe("countJsonlLineRecords", () => {
    it("returns 0 for a missing file", async () => {
        expect(await countJsonlLineRecords(join(tmpdir(), "genesis-tools-missing-count.jsonl"))).toBe(0);
    });

    it("counts only line records, ignoring meta + exit", async () => {
        const dir = mkdtempSync(join(tmpdir(), "count-jsonl-"));
        try {
            const path = join(dir, "s.jsonl");
            const body = [
                '{"type":"meta","session":"s","command":"echo"}',
                '{"type":"line","seq":1,"out":"stdout","ts":1,"text":"a"}',
                '{"type":"line","seq":2,"out":"stdout","ts":2,"text":"b"}',
                '{"type":"line","seq":3,"out":"stderr","ts":3,"text":"c"}',
                '{"type":"exit","code":0,"durationMs":10,"ts":"now"}',
            ].join("\n");
            writeFileSync(path, `${body}\n`);

            expect(await countJsonlLineRecords(path)).toBe(3);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("returns 0 for an empty file", async () => {
        const dir = mkdtempSync(join(tmpdir(), "count-jsonl-"));
        try {
            const path = join(dir, "empty.jsonl");
            writeFileSync(path, "");
            expect(await countJsonlLineRecords(path)).toBe(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
