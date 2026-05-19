import { describe, expect, it } from "bun:test";
import { printReadmeAndExit } from "./readme";

describe("printReadmeAndExit", () => {
    // Plan Task 12 asserted `handleReadme`; the real, 33-caller transitional
    // export is `handleReadmeFlag(importMetaUrl)` — assert that one is kept.
    it("is exported as a callable (prints + exits); handleReadmeFlag kept transitional", async () => {
        const mod = await import("./readme");
        expect(typeof printReadmeAndExit).toBe("function");
        expect(typeof (mod as Record<string, unknown>).handleReadmeFlag).toBe("function");
    });
});
