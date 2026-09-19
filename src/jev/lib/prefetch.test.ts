import { expect, test } from "bun:test";
import { buildPrefetch, matchPrefetch, PREFETCH_MAX_AGE_MS } from "./prefetch";

const candidates = [
    { id: "c0", element: 4, action: "press" as const },
    { id: "c1", element: 7, action: "press" as const },
    { id: "c2", element: 9, action: "press" as const },
    { id: "back", element: -1, action: "chrome" as const, chrome: "back" },
];

test("buildPrefetch keeps the top three ids that still exist", () => {
    const cache = buildPrefetch({
        distribution: { c0: 0.5, c1: 0.3, back: 0.15, abstain: 0.05, missing: 0.0 },
        snapshot: "tok-1",
        candidates,
        now: () => 1000,
    });
    expect(cache.items.map((item) => item.id)).toEqual(["c0", "c1", "back"]);
    expect(cache.items[2]?.payload).toEqual({ element: -1, action: "chrome", uid: "back", chrome: "back" });
    expect(cache.builtAtMs).toBe(1000);
});

test("matchPrefetch returns the payload only on a live snapshot and present winner", () => {
    const cache = buildPrefetch({
        distribution: { c0: 0.9, c1: 0.1 },
        snapshot: "tok-1",
        candidates,
        now: () => 1000,
    });
    expect(matchPrefetch({ cache, snapshot: "tok-1", winnerId: "c0", now: () => 1500 })).toEqual({
        element: 4,
        action: "press",
        uid: "c0",
    });
    expect(matchPrefetch({ cache, snapshot: "tok-2", winnerId: "c0", now: () => 1500 })).toBeNull();
    expect(matchPrefetch({ cache, snapshot: "tok-1", winnerId: "c2", now: () => 1500 })).toBeNull();
    expect(
        matchPrefetch({
            cache,
            snapshot: "tok-1",
            winnerId: "c0",
            now: () => 1000 + PREFETCH_MAX_AGE_MS + 1,
        })
    ).toBeNull();
});

test("matchPrefetch refuses a winner whose element left the candidate set", () => {
    const cache = buildPrefetch({
        distribution: { c0: 1 },
        snapshot: "tok-1",
        candidates,
        now: () => 1,
    });
    expect(
        matchPrefetch({
            cache,
            snapshot: "tok-1",
            winnerId: "c0",
            candidates: [{ id: "c1", element: 7, action: "press" }],
            now: () => 2,
        })
    ).toBeNull();
});
