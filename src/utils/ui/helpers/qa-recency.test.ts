import { describe, expect, test } from "bun:test";
import { resolveQaRecency } from "./qa-recency";

const now = 1_700_000_000_000;

describe("resolveQaRecency", () => {
    test("just-now under 5 seconds", () => {
        expect(resolveQaRecency(now - 2_000, now).relative).toBe("just now");
    });

    test("under 60s shows Ns ago", () => {
        expect(resolveQaRecency(now - 30_000, now).relative).toBe("30s ago");
    });

    test("under 60min shows Nm Ks ago", () => {
        expect(resolveQaRecency(now - 312_000, now).relative).toBe("5m 12s ago");
    });

    test("uses fresh tier under 5 minutes", () => {
        expect(resolveQaRecency(now - 3 * 60_000, now).tier).toBe("fresh");
        expect(resolveQaRecency(now - 3 * 60_000, now).relative).toBe("3m ago");
    });

    test("uses muted tier for hours", () => {
        expect(resolveQaRecency(now - 2 * HOUR, now).tier).toBe("muted");
    });
});

const HOUR = 60 * 60_000;
