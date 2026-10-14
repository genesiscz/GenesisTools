import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { Runner } from "../runners";
import { isExtractionOutage, type MineSessionResult, modelSlug, persistSessionResult } from "./mine";
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

describe("persistSessionResult", () => {
    test("unparseable and wrong-shape raw lines survive a re-mine while valid episodes merge", () => {
        const pack = mkdtempSync(join(tmpdir(), "lff-mine-"));
        const runner: Runner = {
            id: "ai-proxy:work/grok/grok-4.5",
            call: async () => {
                throw new Error("persist makes no model call");
            },
        };
        const dir = join(pack, "meta", "episodes");
        mkdirSync(dir, { recursive: true });
        const rawPath = join(dir, `episodes.${modelSlug(runner.id)}.raw.jsonl`);
        const unreadable = [
            '{"id":"old","contextPre',
            '{ "contextPrefix": "first" }',
            '{"contextPrefix":"second"}',
            "null",
            "true",
            "17",
            '"text"',
            "[]",
            '{"id":11}',
            '{"id":""}',
            '{"id":"  "}',
        ];
        const existing = '{"id":"existing","contextPrefix":"saved"}';
        writeFileSync(rawPath, `${[existing, ...unreadable].join("\n")}\n`);

        persistSessionResult(
            { packPath: pack, sessionsMirrorPath: pack, sessionSources: [] },
            runner,
            result({ episodes: episodes(1) })
        );

        expect(readFileSync(rawPath, "utf-8").trim().split("\n")).toEqual([
            existing,
            SafeJSON.stringify(episodes(1)[0], { strict: true }),
            ...unreadable,
        ]);
    });
});
