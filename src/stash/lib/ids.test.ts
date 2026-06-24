import { describe, expect, test } from "bun:test";
import { newStashId, shortId } from "./ids";

describe("ids", () => {
    test("newStashId returns 32 hex chars", () => {
        const id = newStashId();
        expect(id).toMatch(/^[a-f0-9]{32}$/);
    });

    test("shortId returns first 6 hex chars", () => {
        expect(shortId("3f2a8b7c1d4e5f6a7b8c9d0e1f2a3b4c")).toBe("3f2a8b");
    });

    test("newStashId is monotonically time-ordered (v7-ish)", () => {
        const a = newStashId();
        const b = newStashId();
        expect(a.slice(0, 12) <= b.slice(0, 12)).toBe(true);
    });
});
