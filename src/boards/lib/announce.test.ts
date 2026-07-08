import { describe, expect, it } from "bun:test";
import type { WorkItemDto } from "@app/dev-dashboard/contract/dto";
import { computeAnnouncements, type SeenMap } from "./announce";

function item(overrides: Partial<WorkItemDto> = {}): WorkItemDto {
    return {
        id: 1,
        board: "demo",
        cardId: 1,
        intent: "fix",
        status: "open",
        prompt: "tighten the spacing",
        createdAt: "2026-07-08T00:00:00.000Z",
        updatedAt: "2026-07-08T00:00:00.000Z",
        ...overrides,
    };
}

describe("computeAnnouncements", () => {
    it("announces a new item", () => {
        const { lines, next } = computeAnnouncements(new Map(), [item()]);
        expect(lines).toEqual(["№1 [fix] demo: tighten the spacing"]);
        expect(next.get(1)).toBe("open:2026-07-08T00:00:00.000Z");
    });

    it("does not re-announce an unchanged item", () => {
        const seen: SeenMap = new Map([[1, "open:2026-07-08T00:00:00.000Z"]]);
        const { lines } = computeAnnouncements(seen, [item()]);
        expect(lines).toEqual([]);
    });

    it("re-announces on a status flip", () => {
        const seen: SeenMap = new Map([[1, "open:2026-07-08T00:00:00.000Z"]]);
        const { lines } = computeAnnouncements(seen, [
            item({ status: "working", updatedAt: "2026-07-08T00:05:00.000Z" }),
        ]);
        expect(lines).toEqual(["№1 [fix] demo: tighten the spacing"]);
    });

    it("drops absent items from the returned map, so a later reopen re-announces", () => {
        const seen: SeenMap = new Map([[1, "open:2026-07-08T00:00:00.000Z"]]);
        const gone = computeAnnouncements(seen, []);
        expect(gone.next.size).toBe(0);

        const { lines } = computeAnnouncements(gone.next, [item()]);
        expect(lines).toEqual(["№1 [fix] demo: tighten the spacing"]);
    });

    it("clips prompts over 100 chars with an ellipsis and collapses whitespace", () => {
        const long = "a".repeat(120);
        const { lines } = computeAnnouncements(new Map(), [item({ prompt: `  ${long}  \n more  ` })]);
        expect(lines[0]).toBe(`№1 [fix] demo: ${"a".repeat(100)}…`);
    });
});
