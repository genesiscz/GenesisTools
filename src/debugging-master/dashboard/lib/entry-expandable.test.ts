import { describe, expect, it } from "bun:test";
import { entryHasExpandableContent } from "./entry-expandable";

describe("entryHasExpandableContent", () => {
    it("returns false for plain task stdout lines", () => {
        expect(
            entryHasExpandableContent({
                level: "info",
                label: "stdout",
                msg: "yarn start:no-lazy",
                msgAnsi: "\u001b[36myarn start:no-lazy\u001b[0m",
                ts: 1,
            })
        ).toBe(false);
    });

    it("returns true when structured payload exists", () => {
        expect(
            entryHasExpandableContent({
                level: "info",
                msg: "state",
                data: { ok: true },
                ts: 1,
            })
        ).toBe(true);
    });

    it("returns true for timer-end rows that can show aggregate stats", () => {
        expect(
            entryHasExpandableContent({
                level: "timer-end",
                label: "query",
                durationMs: 12,
                ts: 1,
            })
        ).toBe(true);
    });
});
