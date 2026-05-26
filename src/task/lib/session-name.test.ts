import { describe, expect, it } from "bun:test";
import {
    buildTimestampedSessionName,
    formatSessionDatetimeSuffix,
    isRelatedSessionName,
} from "@app/task/lib/session-name";

describe("formatSessionDatetimeSuffix", () => {
    it("formats YYYY-MM-dd_HH:mm:ss", () => {
        const suffix = formatSessionDatetimeSuffix(new Date(2026, 4, 26, 14, 30, 22, 456));
        expect(suffix).toBe("2026-05-26_14:30:22");
    });
});

describe("buildTimestampedSessionName", () => {
    it("appends -datetime suffix to base name", () => {
        const name = buildTimestampedSessionName("metro", new Date(2026, 4, 26, 14, 30, 22, 456));
        expect(name).toBe("metro-2026-05-26_14:30:22");
    });
});

describe("isRelatedSessionName", () => {
    it("matches base and collision-suffixed names only", () => {
        expect(isRelatedSessionName("eval2-dup", "eval2-dup")).toBe(true);
        expect(isRelatedSessionName("eval2-dup", "eval2-dup-2026-05-26_14:30:22")).toBe(true);
        expect(isRelatedSessionName("eval2-dup", "eval2-dup-unrelated")).toBe(false);
        expect(isRelatedSessionName("eval2-dup", "eval2-dup_2026-05-26_14:30:22")).toBe(false);
    });
});
