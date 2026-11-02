import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressPath } from "@genesiscz/utils/compress/operations";
import { out } from "@genesiscz/utils/logger";
import { runCat, runVerify } from "./files";

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

describe("tools compress verify", () => {
    it("names a list that does not read and a refused list, and says 'does not decode' only for a broken archive", async () => {
        const dir = join(root, "verify");
        const folder = join(dir, "tree");
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, "a.txt"), "a\n");
        const { record } = await compressPath({ source: folder, force: true, caller: "test" });
        const outside = join(dir, "outside.list");
        writeFileSync(outside, "../outside.txt\n");
        const broken = join(dir, "broken.zst");
        writeFileSync(broken, "not zstd");
        const errors: string[] = [];
        const printed = spyOn(out, "error").mockImplementation((message: unknown) => {
            errors.push(String(message));
        });
        const exitCode = process.exitCode;

        try {
            runVerify(record.target, { against: folder, filesFrom: join(dir, "missing.list") });
            runVerify(record.target, { against: folder, filesFrom: outside });
            runVerify(broken, {});
        } finally {
            printed.mockRestore();
            process.exitCode = exitCode;
        }

        expect(errors).toEqual([
            expect.stringMatching(/missing\.list: the file list does not read \(ENOENT/),
            `${record.target}: ../outside.txt is not inside ${folder}`,
            expect.stringContaining(`${broken}: does not decode`),
        ]);
    });
});
