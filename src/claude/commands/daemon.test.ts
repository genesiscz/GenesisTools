import { describe, expect, test } from "bun:test";
import { LEGACY_USAGE_TASK_NAME, USAGE_TASK_NAME, validateRetentionMin } from "./daemon";

describe("claude daemon alias", () => {
    // `tools claude daemon` now mounts the all-provider commands (decision D11), so the
    // task it registers must be the new one and the old name must still be known to it.
    test("re-exports the all-provider task names", () => {
        expect(USAGE_TASK_NAME).toBe("ai-usage-poll");
        expect(LEGACY_USAGE_TASK_NAME).toBe("claude-usage-poll");
    });
});

describe("claude daemon retention CLI validation", () => {
    test("rejects --retention-min 0", () => {
        expect(validateRetentionMin("0")).toBeNull();
    });

    test("accepts --retention-min 1", () => {
        expect(validateRetentionMin("1")).toBe(1);
    });
});
