import { expect, test } from "bun:test";
import { createFixtureStt } from "./fixture";
import { openLiveStt, parseSttProvider } from "./resolve";
import { type LiveTranscriptEvent, STT_PROVIDER_IDS } from "./types";

const sample: LiveTranscriptEvent[] = [
    { kind: "partial", text: "click", isFinal: false, startedAtMs: 1 },
    { kind: "final", text: "click export", isFinal: true, startedAtMs: 1, endedAtMs: 400 },
];

test("fixture provider emits partial then final and close is idempotent", async () => {
    const session = createFixtureStt({ events: sample });
    const seen: string[] = [];
    for await (const event of session.events()) {
        seen.push(`${event.kind}:${event.text}`);
    }
    expect(seen).toEqual(["partial:click", "final:click export"]);
    await session.close();
    await session.close();
});

test("openLiveStt fixture replays supplied events", async () => {
    const session = await openLiveStt({ provider: "fixture", events: sample });
    expect(session.provider).toBe("fixture");
    const texts: string[] = [];
    for await (const event of session.events()) {
        texts.push(event.text);
    }
    expect(texts).toEqual(["click", "click export"]);
});

test("parseSttProvider accepts the closed set and rejects unknown ids", () => {
    expect(STT_PROVIDER_IDS).toEqual(["deepgram", "xai", "openai", "fixture"]);
    expect(parseSttProvider("xai")).toBe("xai");
    expect(() => parseSttProvider("bonsai")).toThrow(/Unknown STT provider/);
});

test("live cloud providers refuse without a bound account instead of reading ambient keys", async () => {
    await expect(openLiveStt({ provider: "deepgram" })).rejects.toThrow(/bound deepgram account/);
    await expect(openLiveStt({ provider: "openai" })).rejects.toThrow(/tools ai config default set transcribe/);
});

test("close stops further fixture events", async () => {
    const session = createFixtureStt({ events: sample });
    await session.close();
    const seen: LiveTranscriptEvent[] = [];
    for await (const event of session.events()) {
        seen.push(event);
    }
    expect(seen).toEqual([]);
});
