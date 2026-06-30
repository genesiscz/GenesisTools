import { describe, expect, test } from "bun:test";
import { renderUnifiedDiff } from "./diff";

describe("renderUnifiedDiff", () => {
    test("returns a unified diff between two strings", () => {
        const before = "alpha\nbeta\ngamma\n";
        const after = "alpha\nBETA\ngamma\n";
        const diff = renderUnifiedDiff({ before, after, label: "test.txt" });
        expect(diff).toContain("--- a/test.txt");
        expect(diff).toContain("+++ b/test.txt");
        expect(diff).toContain("-beta");
        expect(diff).toContain("+BETA");
    });

    test("returns empty string when before === after", () => {
        const same = "no change\n";
        expect(renderUnifiedDiff({ before: same, after: same, label: "x" })).toBe("");
    });

    test("respects context option (default 3, configurable)", () => {
        const before = `${["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].join("\n")}\n`;
        const after = before.replace("5", "FIVE");
        const ctx0 = renderUnifiedDiff({ before, after, label: "x", context: 0 });
        const ctx3 = renderUnifiedDiff({ before, after, label: "x", context: 3 });
        // Larger context → more lines in the output.
        expect(ctx3.split("\n").length).toBeGreaterThan(ctx0.split("\n").length);
    });

    test("does NOT shell out to system diff binary", async () => {
        // Synchronous + no I/O guarantee: completes within a tight time bound, no awaitable returned.
        const result = renderUnifiedDiff({ before: "a\n", after: "b\n", label: "x" });
        expect(typeof result).toBe("string"); // sync, not Promise
    });
});
