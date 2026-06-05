import { describe, expect, test } from "bun:test";
import { logMatchScrollEffectKey } from "./use-scroll-to-first-log-match";

describe("logMatchScrollEffectKey", () => {
    test("changes when query or context lines change", () => {
        const base = { query: "error", contextLines: 2, frozen: false };
        const same = logMatchScrollEffectKey(base);
        expect(logMatchScrollEffectKey({ ...base, frozen: true })).toBe(same);
        expect(logMatchScrollEffectKey({ ...base, query: "warn" })).not.toBe(same);
        expect(logMatchScrollEffectKey({ ...base, contextLines: 0 })).not.toBe(same);
    });
});
