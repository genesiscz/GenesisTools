import { describe, expect, it } from "bun:test";
import { strokePath } from "@/features/snap/queries";

describe("snap markup", () => {
    it("draws a stroke as a path, and nothing for an empty one", () => {
        expect(strokePath({ points: [{ x: 1, y: 2 }, { x: 3.25, y: 4 }] })).toBe("M 1.0 2.0 L 3.3 4.0");
        expect(strokePath({ points: [] })).toBe("");
    });
});
