import { describe, expect, test } from "bun:test";
import { backoffRefetchInterval } from "./poll-backoff";

function fakeQuery(data: unknown) {
    return { state: { data, dataUpdateCount: 0 } };
}

function land(query: { state: { data: unknown; dataUpdateCount: number } }, data: unknown): void {
    query.state = { data, dataUpdateCount: query.state.dataUpdateCount + 1 };
}

describe("backoffRefetchInterval", () => {
    test("doubles for each unchanged answer and stops at the ceiling", () => {
        const interval = backoffRefetchInterval(3000, 12_000);
        const same = { sessions: ["a"] };
        const query = fakeQuery(undefined);

        expect(interval(query)).toBe(3000);
        land(query, same);
        expect(interval(query)).toBe(3000);
        land(query, same);
        expect(interval(query)).toBe(6000);
        land(query, same);
        expect(interval(query)).toBe(12_000);
        land(query, same);
        expect(interval(query)).toBe(12_000);
    });

    test("a changed answer drops back to the base interval", () => {
        const interval = backoffRefetchInterval(3000, 12_000);
        const query = fakeQuery(undefined);
        const first = { sessions: ["a"] };

        interval(query);
        land(query, first);
        interval(query);
        land(query, first);
        interval(query);
        land(query, first);
        expect(interval(query)).toBe(12_000);

        land(query, { sessions: ["a", "b"] });
        expect(interval(query)).toBe(3000);
    });

    test("re-evaluating without a new fetch does not grow the streak", () => {
        const interval = backoffRefetchInterval(3000, 12_000);
        const same = { sessions: ["a"] };
        const query = fakeQuery(undefined);

        interval(query);
        land(query, same);
        interval(query);
        land(query, same);

        // Every observer of the query, and every status change, evaluates the interval again.
        expect(interval(query)).toBe(6000);
        expect(interval(query)).toBe(6000);
        expect(interval(query)).toBe(6000);
    });
});
