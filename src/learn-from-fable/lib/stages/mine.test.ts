import { describe, expect, test } from "bun:test";
import { isExtractionOutage, type MineSessionResult } from "./mine";
import type { Episode } from "./types";

function result(overrides: Partial<MineSessionResult>): MineSessionResult {
    return {
        session: "/tmp/session.jsonl",
        stem: "abcd1234",
        runId: "mine-test",
        turns: 40,
        fableTurns: 20,
        windows: 6,
        windowsSampled: 6,
        episodes: [],
        principles: [],
        extractorFailures: 0,
        secs: 1,
        ...overrides,
    };
}

/** Only the count matters here — the guard never looks inside an episode. */
function episodes(count: number): Episode[] {
    return Array.from({ length: count }, (_, i) => ({ id: `e${i}` }) as Episode);
}

describe("isExtractionOutage", () => {
    test("a clean run with no episodes is an empty session, not an outage", () => {
        expect(isExtractionOutage(result({ extractorFailures: 0 }))).toBe(false);
    });

    test("one flaky window among many good ones does not withhold the session", () => {
        // Otherwise a genuinely empty session sits in the queue forever, re-mined
        // on every run because a single window happened to fail once.
        expect(isExtractionOutage(result({ windowsSampled: 6, extractorFailures: 1 }))).toBe(false);
        expect(isExtractionOutage(result({ windowsSampled: 6, extractorFailures: 2 }))).toBe(false);
    });

    test("a lone success among mostly-failed windows is not evidence the session is empty", () => {
        expect(isExtractionOutage(result({ windowsSampled: 6, extractorFailures: 5 }))).toBe(true);
    });

    test("every window failing is an outage", () => {
        expect(isExtractionOutage(result({ windowsSampled: 6, extractorFailures: 6 }))).toBe(true);
    });

    test("a tie goes to retrying, because losing a session is worse than re-mining one", () => {
        expect(isExtractionOutage(result({ windowsSampled: 6, extractorFailures: 3 }))).toBe(true);
    });

    test("episodes found means the run produced a verdict regardless of failures", () => {
        expect(isExtractionOutage(result({ windowsSampled: 6, extractorFailures: 5, episodes: episodes(2) }))).toBe(
            false
        );
    });

    test("a session with nothing sampled is not treated as an outage", () => {
        expect(isExtractionOutage(result({ windowsSampled: 0, extractorFailures: 0 }))).toBe(false);
    });
});
