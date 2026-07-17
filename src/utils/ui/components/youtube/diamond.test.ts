import { describe, expect, test } from "bun:test";
import { formatDiamonds } from "@app/utils/ui/components/youtube/diamond";

describe("formatDiamonds", () => {
    test("thin-space separates thousands", () => {
        expect(formatDiamonds(1500)).toBe("1 500");
        expect(formatDiamonds(1_234_567)).toBe("1 234 567");
    });

    test("leaves sub-thousand values bare", () => {
        expect(formatDiamonds(0)).toBe("0");
        expect(formatDiamonds(999)).toBe("999");
    });

    test("rounds fractional balances", () => {
        expect(formatDiamonds(15.4)).toBe("15");
        expect(formatDiamonds(15.6)).toBe("16");
    });
});
