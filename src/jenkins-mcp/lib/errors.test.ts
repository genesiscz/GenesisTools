import { describe, expect, it } from "bun:test";
import { extractErrors } from "./errors";

describe("extractErrors", () => {
    it("finds FAIL lines with ±5 context for short logs", () => {
        const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
        lines[14] = "FAIL packages/foo/foo.test.ts";
        const errs = extractErrors(lines.join("\n"));
        expect(errs).toHaveLength(1);
        expect(errs[0].matched).toContain("FAIL packages/foo");
        expect(errs[0].line).toBe(15);
        expect(errs[0].window).toHaveLength(11);
    });

    it("uses ±3 window for long logs (>100 lines)", () => {
        const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
        lines[150] = "Error: something exploded";
        const errs = extractErrors(lines.join("\n"));
        expect(errs).toHaveLength(1);
        expect(errs[0].window).toHaveLength(7);
    });

    it("respects custom pattern", () => {
        const text = "line 1\nCUSTOMFAIL boom\nline 3";
        const errs = extractErrors(text, { pattern: /CUSTOMFAIL/ });
        expect(errs).toHaveLength(1);
    });

    it("caps results at maxBlocks", () => {
        const blocks: string[] = [];

        for (let i = 0; i < 20; i++) {
            blocks.push(`FAIL ${i}`);
            // separator to prevent window merging
            blocks.push("ok");
            blocks.push("ok");
            blocks.push("ok");
            blocks.push("ok");
            blocks.push("ok");
            blocks.push("ok");
            blocks.push("ok");
            blocks.push("ok");
            blocks.push("ok");
            blocks.push("ok");
            blocks.push("ok");
        }

        const errs = extractErrors(blocks.join("\n"), { maxBlocks: 3 });
        expect(errs).toHaveLength(3);
    });

    it("merges overlapping windows from adjacent matches", () => {
        const text = `ok\nFAIL one\nFAIL two\nok\n${"ok\n".repeat(20)}`;
        const errs = extractErrors(text);
        expect(errs).toHaveLength(1);
        expect(errs[0].matched).toContain("FAIL one");
    });

    it("does not skip matches when caller passes a /g regex (resets lastIndex)", () => {
        const lines = ["alpha bravo", "charlie bravo", "delta bravo"];
        const errs = extractErrors(lines.join("\n"), { pattern: /bravo/g });
        expect(errs.length).toBeGreaterThan(0);
        // All three lines match — without re.lastIndex reset, the /g state would skip lines 2/3.
        expect(errs[0].matched).toContain("alpha");
    });
});

describe("extractErrors (agnostic patterns)", () => {
    it.each([
        ["BUILD FAILED in 2m 14s"],
        ["FAILURE: Build failed with an exception."],
        ["Execution failed for task ':app:bundleRelease'."],
        ["* What went wrong:"],
        ["Caused by: java.io.FileNotFoundException"],
    ])("matches '%s'", (line) => {
        const text = `line a\nline b\n${line}\nline d`;
        const errs = extractErrors(text);
        expect(errs.length).toBeGreaterThan(0);
        expect(errs[0].matched).toContain(line.slice(0, 10));
    });
});
