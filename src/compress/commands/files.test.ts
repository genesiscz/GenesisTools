import { afterAll, describe, expect, it } from "bun:test";
import { linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCat } from "./files";

const root = mkdtempSync(join(tmpdir(), "compress-cat-test-"));

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("tools compress cat", () => {
    it("refuses an output that is the input itself (its path, a hard link, a symlink), and the input keeps its bytes", async () => {
        const source = join(root, "2026-10-10.log");
        const text = "line one\nline two\n";
        writeFileSync(source, text);
        const hard = join(root, "hard.log");
        linkSync(source, hard);
        const soft = join(root, "soft.log");
        symlinkSync(source, soft);

        for (const output of [source, hard, soft]) {
            await expect(runCat(source, { output })).rejects.toThrow("itself");
            expect(readFileSync(source, "utf8")).toBe(text);
        }

        const copy = join(root, "copy.log");
        await runCat(source, { output: copy });
        expect(readFileSync(copy, "utf8")).toBe(text);
    });
});
