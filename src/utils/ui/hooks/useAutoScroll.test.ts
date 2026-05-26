import { describe, expect, it } from "bun:test";

const EDGE_THRESHOLD_PX = 24;

function isAtScrollEdge(
    scrollTop: number,
    scrollHeight: number,
    clientHeight: number,
    edge: "top" | "bottom",
    thresholdPx: number
): boolean {
    if (edge === "top") {
        return scrollTop <= thresholdPx;
    }

    return scrollHeight - scrollTop - clientHeight <= thresholdPx;
}

describe("useAutoScroll edge detection", () => {
    it("detects bottom edge within threshold", () => {
        expect(isAtScrollEdge(900, 1000, 100, "bottom", EDGE_THRESHOLD_PX)).toBe(true);
        expect(isAtScrollEdge(875, 1000, 100, "bottom", EDGE_THRESHOLD_PX)).toBe(false);
    });

    it("detects top edge within threshold", () => {
        expect(isAtScrollEdge(0, 1000, 100, "top", EDGE_THRESHOLD_PX)).toBe(true);
        expect(isAtScrollEdge(40, 1000, 100, "top", EDGE_THRESHOLD_PX)).toBe(false);
    });
});
