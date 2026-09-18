import { expect, test } from "bun:test";
import type { LiveTranscriptEvent } from "@genesiscz/utils/ai/stt";
import { eventsAfterWake } from "./handoff";
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

test("listen sees command words after the wake timestamp", () => {
    const events: LiveTranscriptEvent[] = [
        { kind: "final", text: "hey jev", isFinal: true, startedAtMs: 1000 },
        { kind: "final", text: "click export", isFinal: true, startedAtMs: 1050 },
    ];
    expect(eventsAfterWake(events, 1000).map((event) => event.text)).toEqual(["hey jev", "click export"]);
    expect(eventsAfterWake(events, 1001).map((event) => event.text)).toEqual(["click export"]);
});
