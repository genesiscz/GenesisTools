import { expect, test } from "bun:test";
import { validateNativeCapturePlan } from "./capture-native";
import { peekabooDurationArg, runCapturePlan } from "./capture-runner";

// Regression: PR #376 review round 3 — plan durations reached peekaboo unconverted.
// `capture-plan.ts` documents `capture.duration` in SECONDS, but peekaboo reads a bare
// `--duration` as MILLISECONDS ("Duration; bare values are milliseconds" in
// `peekaboo capture live --help`), so a `duration: 2` plan asked for a 2 ms recording
// while the runner's own exit wait blocked for ~2 s.

test("a plan duration reaches peekaboo as seconds, not as a bare millisecond count", () => {
    expect(peekabooDurationArg(2)).toBe("2s");
    expect(peekabooDurationArg(9)).toBe("9s");
});

test("the argument is never a bare number, which peekaboo would read as milliseconds", () => {
    for (const seconds of [1, 2, 3, 30, 180]) {
        expect(peekabooDurationArg(seconds)).not.toBe(String(seconds));
        expect(peekabooDurationArg(seconds)).toMatch(/^\d+(\.\d+)?s$/);
    }
});

test("a fractional duration keeps its unit rather than truncating to milliseconds", () => {
    expect(peekabooDurationArg(1.5)).toBe("1.5s");
});

test("native recording rejects scripting and unsupported typing before recorder startup", async () => {
    const base = { capture: { mode: "screen" as const, duration: 1 }, actions: [] };
    for (const action of [
        { atMs: 0, do: "osascript" as const, script: 'error "must never run"' },
        { atMs: 0, do: "url" as const, url: "https://example.com" },
        { atMs: 0, do: "hotkey" as const, keys: "volumeup" },
        { atMs: 0, do: "type" as const, text: "line one\nline two" },
    ]) {
        await expect(runCapturePlan({ ...base, actions: [action] })).rejects.toThrow(/unavailable|single-line/);
    }
    expect(() =>
        validateNativeCapturePlan({ ...base, actions: [{ atMs: 0, do: "ax-press", app: "Fixture", axId: "save" }] })
    ).not.toThrow();
});
