import { describe, expect, test } from "bun:test";
import { formatMoney } from "./LimitBar";

/**
 * `anthropic-sub` forwards the API's own exponent into `LimitMoney`, so a
 * non-2 exponent reaches this formatter. It used to scale by the exponent and
 * then round to two decimals regardless (CodeRabbit review, PR #363).
 */
describe("formatMoney", () => {
    test("two decimals is still two decimals", () => {
        expect(formatMoney({ usedMinor: 900, limitMinor: 3000, currency: "USD", exponent: 2 })).toBe("$9.00 / $30.00");
    });

    test("a three-decimal currency keeps its last minor-unit digit", () => {
        expect(formatMoney({ usedMinor: 9123, limitMinor: 30000, currency: "KWD", exponent: 3 })).toBe(
            "KWD 9.123 / KWD 30.000"
        );
    });

    test("a zero-decimal currency gains no decimals", () => {
        expect(formatMoney({ usedMinor: 900, limitMinor: 3000, currency: "JPY", exponent: 0 })).toBe(
            "JPY 900 / JPY 3000"
        );
    });

    test("a window with no limit prints the used amount alone, at its own precision", () => {
        expect(formatMoney({ usedMinor: 9123, currency: "KWD", exponent: 3 })).toBe("KWD 9.123");
    });
});
