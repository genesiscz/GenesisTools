import { expect, test } from "bun:test";
import { fixtureWakeEvents } from "./wake";

test("fixture trigger yields once and cooldown suppresses a second hit", async () => {
    const seen: number[] = [];
    for await (const event of fixtureWakeEvents(
        [
            { atMs: 100, word: "hey jev" },
            { atMs: 200, word: "hey jev" },
            { atMs: 2000, word: "hey jev" },
        ],
        1500
    )) {
        seen.push(event.atMs);
    }
    expect(seen).toEqual([100, 2000]);
});
