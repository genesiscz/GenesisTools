import { describe, expect, test } from "bun:test";
import { validateRetentionMin } from "./daemon";

describe("claude daemon retention CLI validation", () => {
    test("rejects --retention-min 0", () => {
        expect(validateRetentionMin("0")).toBeNull();
    });

    test("accepts --retention-min 1", () => {
        expect(validateRetentionMin("1")).toBe(1);
    });
});
