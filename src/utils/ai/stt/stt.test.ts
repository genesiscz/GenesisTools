import { expect, test } from "bun:test";
import { createFixtureStt } from "./fixture";
import { openLiveStt, parseSttProvider } from "./resolve";
import { type LiveTranscriptEvent, STT_PROVIDER_IDS } from "./types";
import { LocalVad, pcmRms } from "./vad";
import { canDispatchWake, WakeRateLimiter } from "./wake/jev";
import { isStopUtterance, matchWake, parseWakePhrases } from "./wake/word";

const sample: LiveTranscriptEvent[] = [
    { kind: "partial", text: "click", isFinal: false, startedAtMs: 1 },
    { kind: "final", text: "click export", isFinal: true, startedAtMs: 1, endedAtMs: 400 },
];

test("fixture provider emits partial then final, accepts audio, and close is idempotent", async () => {
    const session = createFixtureStt({ events: sample });
    session.write(new Uint8Array(320));
    session.end();
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

test("parseSttProvider accepts the closed set, normalises aliases, rejects unknown ids", () => {
    expect(STT_PROVIDER_IDS).toEqual(["deepgram", "openai", "xai", "elevenlabs", "fixture"]);
    expect(parseSttProvider("xai")).toBe("xai");
    expect(parseSttProvider("grok-live")).toBe("xai");
    expect(parseSttProvider("gpt-realtime")).toBe("openai");
    expect(parseSttProvider("mock")).toBe("fixture");
    expect(parseSttProvider("scribe")).toBe("elevenlabs");
    expect(() => parseSttProvider("bonsai")).toThrow(/Unknown STT provider/);
});

test("an explicit account that does not exist is refused before any socket work", async () => {
    await expect(openLiveStt({ provider: "deepgram", account: "no-such-account-xyz" })).rejects.toThrow(
        /No AI account 'no-such-account-xyz'/
    );
});

test("pcm rms and the local VAD detect speech start and end", () => {
    const silent = new Uint8Array(3200);
    expect(pcmRms(silent)).toBe(0);
    const loud = new Uint8Array(3200);
    const view = new DataView(loud.buffer);
    for (let offset = 0; offset < loud.byteLength; offset += 2) {
        view.setInt16(offset, offset % 4 === 0 ? 12000 : -12000, true);
    }
    expect(pcmRms(loud)).toBeGreaterThan(0.3);

    let now = 0;
    const vad = new LocalVad({ silenceMs: 400 }, () => now);
    expect(vad.push(silent)).toBeNull();
    expect(vad.push(loud)).toBe("speech_start");
    now = 100;
    expect(vad.push(silent)).toBeNull();
    now = 600;
    expect(vad.push(silent)).toBe("speech_end");
});

test("wake matcher prefers the longest phrase and returns the remainder", () => {
    const phrases = parseWakePhrases("hey jev, jev");
    expect(matchWake("Hey Jev, press seven", phrases)).toEqual({ matched: "hey jev", remainder: "press seven" });
    expect(matchWake("please jev go back", phrases)).toEqual({ matched: "jev", remainder: "go back" });
    expect(matchWake("nothing here", phrases)).toBeNull();
    expect(isStopUtterance("Never mind")).toBe(true);
    expect(isStopUtterance("never mind that button")).toBe(false);
});

test("wake dispatch needs woke and complete, and a confirmation when destructive", () => {
    const base = { woke: true, remainder: "send it", destructive: true, complete: true, probabilities: {} };
    expect(canDispatchWake(base)).toBe(false);
    expect(canDispatchWake(base, true)).toBe(true);
    expect(canDispatchWake({ ...base, destructive: false })).toBe(true);
    expect(canDispatchWake({ ...base, destructive: false, complete: false })).toBe(false);
});

test("wake rate limiter coalesces partials to one evaluation per interval and lets finals through", () => {
    let now = 0;
    const limiter = new WakeRateLimiter(400, () => now);
    expect(limiter.admit("hey", false)).toBe("hey");
    now = 100;
    expect(limiter.admit("hey jev", false)).toBeNull();
    now = 200;
    expect(limiter.admit("hey jev press", false)).toBeNull();
    expect(limiter.takePending()).toBe("hey jev press");
    now = 300;
    expect(limiter.admit("hey jev press seven", true)).toBe("hey jev press seven");
    now = 350;
    expect(limiter.admit("x", false)).toBeNull();
    now = 800;
    expect(limiter.admit("y", false)).toBe("y");
});
