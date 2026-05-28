import { describe, expect, test } from "bun:test";
import { resolveQaRecency } from "./qa-recency";

const now = Date.parse("2026-05-20T12:00:00.000Z");

describe("resolveQaRecency", () => {
    test("uses hot tier under 10 seconds", () => {
        expect(resolveQaRecency(now - 4_000, now)).toEqual({
            tier: "hot",
            relative: "4s ago",
            ageMs: 4_000,
        });
    });

    test("uses fresh tier from 10s to under 30s", () => {
        expect(resolveQaRecency(now - 18_000, now).tier).toBe("fresh");
        expect(resolveQaRecency(now - 18_000, now).relative).toBe("18s ago");
    });

    test("uses recent tier from 30s to under 1 minute", () => {
        expect(resolveQaRecency(now - 45_000, now).tier).toBe("recent");
    });

    test("uses warm tier from 1 to under 5 minutes", () => {
        expect(resolveQaRecency(now - 3 * 60_000, now).tier).toBe("warm");
        expect(resolveQaRecency(now - 3 * 60_000, now).relative).toBe("3m ago");
    });

    test("cools down after 15 minutes", () => {
        expect(resolveQaRecency(now - 20 * 60_000, now).tier).toBe("cool");
    });
});
