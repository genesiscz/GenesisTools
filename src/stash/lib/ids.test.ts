import { describe, expect, test } from "bun:test";
import { newStashId, shortId } from "./ids";

describe("ids", () => {
    test("newStashId returns 32 hex chars", () => {
        const id = newStashId();
        expect(id).toMatch(/^[a-f0-9]{32}$/);
    });

    test("shortId returns the trailing 6 hex chars (random suffix)", () => {
        // PR #222 t16: shortId now uses the random suffix, not the timestamp prefix, so two stashes
        // created within the same ~4.66h window don't collide.
        expect(shortId("3f2a8b7c1d4e5f6a7b8c9d0e1f2a3b4c")).toBe("2a3b4c");
    });

    test("newStashId is monotonically time-ordered (v7-ish)", () => {
        const a = newStashId();
        const b = newStashId();
        expect(a.slice(0, 12) <= b.slice(0, 12)).toBe(true);
    });

    test("shortId varies between two same-instant IDs (no timestamp-prefix collision)", () => {
        // Same ms timestamp prefix, different random suffix. Old `slice(0, 6)` returned same value
        // for both — new `slice(-6)` returns different values, proving the fix.
        const a = "019efb000000aaaaaaaaaaaaaaaaaaaa";
        const b = "019efb000000bbbbbbbbbbbbbbbbbbbb";
        expect(shortId(a)).not.toBe(shortId(b));
    });
});
