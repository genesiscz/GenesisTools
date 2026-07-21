import { describe, expect, it } from "bun:test";
import {
    isFullBleedOverPlayer,
    isInFlowPosition,
    isUsableLiveChatStyle,
    rectsOverlapSubstantially,
} from "@ext/placement";

describe("isUsableLiveChatStyle", () => {
    it("rejects hidden or zero-size ghost frames", () => {
        expect(isUsableLiveChatStyle({ display: "none", visibility: "visible" }, rect(0, 0, 300, 400))).toBe(false);
        expect(isUsableLiveChatStyle({ display: "block", visibility: "hidden" }, rect(0, 0, 300, 400))).toBe(false);
        expect(isUsableLiveChatStyle({ display: "block", visibility: "visible" }, rect(0, 0, 300, 0))).toBe(false);
        expect(isUsableLiveChatStyle({ display: "block", visibility: "visible" }, rect(0, 0, 50, 200))).toBe(false);
    });

    it("accepts a real chat-sized frame", () => {
        expect(isUsableLiveChatStyle({ display: "block", visibility: "visible" }, rect(900, 80, 400, 600))).toBe(true);
    });
});

describe("isInFlowPosition", () => {
    it("only allows static/relative", () => {
        expect(isInFlowPosition("static")).toBe(true);
        expect(isInFlowPosition("relative")).toBe(true);
        expect(isInFlowPosition("fixed")).toBe(false);
        expect(isInFlowPosition("absolute")).toBe(false);
    });
});

describe("rectsOverlapSubstantially / full-bleed", () => {
    it("detects player coverage", () => {
        const player = rect(0, 56, 960, 540);
        const over = rect(0, 56, 960, 200);
        const rail = rect(980, 56, 400, 800);

        expect(rectsOverlapSubstantially(over, player)).toBe(true);
        expect(rectsOverlapSubstantially(rail, player)).toBe(false);
        expect(isFullBleedOverPlayer(over, player)).toBe(true);
        expect(isFullBleedOverPlayer(rail, player)).toBe(false);
    });
});

function rect(left: number, top: number, width: number, height: number) {
    return { left, top, width, height, right: left + width, bottom: top + height };
}
