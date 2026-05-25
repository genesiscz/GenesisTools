import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterLineRecords, readJsonlFile } from "./jsonl-reader";
import { OrderedCaptureWriter } from "./ordered-capture-writer";

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs) {
        rmSync(d, { recursive: true, force: true });
    }
});

describe("OrderedCaptureWriter", () => {
    it("preserves enqueue order in jsonl seq when stdout/stderr pushed concurrently", async () => {
        const dir = mkdtempSync(join(tmpdir(), "ocw-"));
        dirs.push(dir);
        const w = new OrderedCaptureWriter({
            jsonlPath: join(dir, "s.jsonl"),
            stdoutPath: join(dir, "s.log"),
            stderrPath: join(dir, "s.err.log"),
            mode: "pipe",
        });

        w.enqueue("stdout", "a\n");
        w.enqueue("stderr", "b\n");
        w.enqueue("stdout", "c\n");
        await w.flush();

        const records = await readJsonlFile(join(dir, "s.jsonl"));
        const lines = filterLineRecords(records);
        expect(lines.map((l) => l.text)).toEqual(["a", "b", "c"]);
        expect(lines.map((l) => l.out)).toEqual(["stdout", "stderr", "stdout"]);
        expect(lines.map((l) => l.seq)).toEqual([1, 2, 3]);
    });

    it("pty mode writes all lines to stdout mirror only", async () => {
        const dir = mkdtempSync(join(tmpdir(), "ocw-"));
        dirs.push(dir);
        const w = new OrderedCaptureWriter({
            jsonlPath: join(dir, "s.jsonl"),
            stdoutPath: join(dir, "s.log"),
            stderrPath: join(dir, "s.err.log"),
            mode: "pty",
        });
        w.enqueue("stdout", "combined\n");
        await w.flush();
        expect(readFileSync(join(dir, "s.log"), "utf8")).toBe("combined\n");
        expect(readFileSync(join(dir, "s.err.log"), "utf8")).toBe("");
    });
});
