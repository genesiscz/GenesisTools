import { describe, expect, it } from "bun:test";
import { buildTimestampedSessionName, formatSessionDatetimeSuffix } from "./session-name";

describe("formatSessionDatetimeSuffix", () => {
    it("formats YYYY-mm-dd-HH-ii-ss", () => {
        const suffix = formatSessionDatetimeSuffix(new Date(2026, 4, 26, 14, 30, 22, 456));
        expect(suffix).toBe("2026-05-26_14-30-22");
    });

    it("appends ms when includeMs is true", () => {
        const suffix = formatSessionDatetimeSuffix(new Date(2026, 4, 26, 14, 30, 22, 456), true);
        expect(suffix).toBe("2026-05-26_14-30-22-456");
    });
});

describe("buildTimestampedSessionName", () => {
    it("appends datetime suffix to base name", () => {
        const name = buildTimestampedSessionName("metro", new Date(2026, 4, 26, 14, 30, 22, 456));
        expect(name).toBe("metro_2026-05-26_14-30-22");
    });
});
