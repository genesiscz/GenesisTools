import { expect, test } from "bun:test";
import { agentWaveStopAfter, listingIndexSlice, mergeSearchWaves } from "./search-plan";

test("preserves zero-limit planning quirks", () => {
    const entries = Array.from({ length: 22 }, (_, mtime) => ({ mtime }));
    const mains = [{ id: "main", timestamp: new Date(1) }];
    const agents = [{ id: "agent", timestamp: new Date(2) }];

    expect(listingIndexSlice(entries, 0).map((entry) => entry.mtime)).toEqual(
        Array.from({ length: 20 }, (_, index) => 21 - index)
    );
    expect(agentWaveStopAfter({ limit: 0, mainHitCount: 4 })).toBe(0);
    expect(mergeSearchWaves(mains, agents, { limit: 0 }).map((entry) => entry.id)).toEqual(["main", "agent"]);
    expect(mergeSearchWaves([], [], { limit: 0 })).toEqual([]);
});
