import { describe, expect, it } from "bun:test";
import { formatValueWithRef, parseRef, preview, type RefStore, truncateList } from "./refs.ts";

describe("formatValueWithRef", () => {
    const big = "x".repeat(50) + " tail ".repeat(300);

    it("prints small values inline with no ref bookkeeping", () => {
        const store: RefStore = {};
        const result = formatValueWithRef(store, "n1.cont", "short value");

        expect(result.text).toBe("short value");
        expect(result.ref).toBeUndefined();
        expect(store["n1.cont"]).toBeUndefined();
    });

    it("prints a large value in full exactly once, then preview-only", () => {
        const store: RefStore = {};
        const first = formatValueWithRef(store, "n1.cont", big);

        expect(first.emittedFull).toBe(true);
        expect(first.text).toContain(big);
        expect(first.text).toContain("[ref:n1.cont]");

        const second = formatValueWithRef(store, "n1.cont", big);
        expect(second.emittedFull).toBe(false);
        expect(second.text).toStartWith("[ref:n1.cont]");
        expect(second.text).toContain(`(${big.length} chars)`);
        expect(second.text.length).toBeLessThan(400);
    });

    it("--full bypasses the ref system entirely", () => {
        const store: RefStore = { "n1.cont": { preview: "p", size: 1, shown: true } };
        const result = formatValueWithRef(store, "n1.cont", big, { full: true });

        expect(result.emittedFull).toBe(true);
        expect(result.text).toBe(big);
    });

    it("honors a per-call threshold override", () => {
        const store: RefStore = {};
        const result = formatValueWithRef(store, "n2.cont", "0123456789", { threshold: 5 });

        expect(result.text).toContain("[ref:n2.cont]");
    });
});

describe("parseRef", () => {
    it("derivable ids parse back to their parts", () => {
        expect(parseRef("n14.ctx")).toEqual({ prefix: "n", index: 14, field: "ctx" });
        expect(parseRef("n5")).toEqual({ prefix: "n", index: 5, field: undefined });
        expect(parseRef("not a ref")).toBeUndefined();
    });
});

describe("truncateList / preview", () => {
    it("never drops silently", () => {
        expect(truncateList(["a", "b", "c"], 5)).toEqual(["a", "b", "c"]);
        expect(truncateList(["a", "b", "c", "d"], 2)).toEqual(["a", "b", "… +2 more"]);
    });

    it("preview cuts on a natural break and flattens whitespace", () => {
        const flat = preview("word ".repeat(100), 40);
        expect(flat.length).toBeLessThanOrEqual(41);
        expect(flat.endsWith("…")).toBe(true);
    });
});
