import { describe, expect, test } from "bun:test";
import type { LimitWindow } from "@app/dev-dashboard/contract/ai-accounts";
import { formatMoney, limitColor, percentOf } from "./LimitBar";

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

describe("percentOf", () => {
    test("a real percentage passes through", () => {
        expect(percentOf({ percentUsed: 42 } as LimitWindow)).toBe(42);
    });

    test("a row off an older snapshot reads as 0 rather than blanking the page", () => {
        const fromDisk = {
            key: "product:grokimagine",
            label: "Grok Imagine",
            kind: "scoped",
        } as unknown as LimitWindow;

        expect(percentOf(fromDisk)).toBe(0);
        expect(() => percentOf(fromDisk).toFixed(0)).not.toThrow();
        expect(limitColor(fromDisk)).toBe("var(--dd-accent-from)");
    });
});

describe("formatMoney honours the limit exponent and the cap", () => {
    test("a limit with its own exponent is not scaled by the spend's", () => {
        expect(formatMoney({ usedMinor: 900, limitMinor: 30, currency: "USD", exponent: 2, limitExponent: 0 })).toBe(
            "$9.00 / $30"
        );
    });

    test("a configured ceiling with no limit is printed", () => {
        expect(formatMoney({ usedMinor: 900, currency: "USD", exponent: 2, capMinor: 3000 })).toBe("$9.00 / $30.00");
    });

    test("the cap keeps its own currency", () => {
        expect(formatMoney({ usedMinor: 900, currency: "USD", exponent: 2, capMinor: 3000, capCurrency: "EUR" })).toBe(
            "$9.00 / EUR 30.00"
        );
    });
});
