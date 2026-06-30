import { describe, expect, test } from "bun:test";
import { renderDiff } from "./diff-render";

describe("renderDiff (delegates to @app/utils/diff renderUnifiedDiff)", () => {
    test("returns a string containing unified-diff headers", () => {
        const out = renderDiff({ before: "old\n", after: "new\n", label: "file.ts" });
        expect(out).toContain("--- a/file.ts");
        expect(out).toContain("+++ b/file.ts");
        expect(out).toContain("-old");
        expect(out).toContain("+new");
    });

    test("returns empty string when before === after", () => {
        const out = renderDiff({ before: "same\n", after: "same\n", label: "x" });
        expect(out).toBe("");
    });

    test("returns synchronously (no Promise, no subprocess)", () => {
        // Type-level assertion is more reliable than wall-clock timing under CI load.
        // If renderDiff ever returned a Promise (shelled out to git diff), this would fail.
        const out = renderDiff({ before: "a\n", after: "b\n", label: "x" });
        expect(typeof out).toBe("string");
    });
});
