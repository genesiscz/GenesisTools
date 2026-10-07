import { describe, expect, test } from "bun:test";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { DEFAULT_PRICING } from "../pricing";
import { codexDriver } from "./codex";
import { billedCost, collectEvents } from "./driver-test-helpers";
import { isolateAgentHomeEnv } from "./test-env";
import type { DriverUsageEvent } from "./types";

// An ambient CODEX_HOME would relocate the roots asserted below.
isolateAgentHomeEnv();

const turnContext = (model: string): string =>
    SafeJSON.stringify({
        timestamp: "2026-08-27T09:00:00.000Z",
        type: "turn_context",
        payload: { turn_id: "turn-1", cwd: "/tmp/proj", model, effort: "medium" },
    });

const tokenCount = (timestamp: string, total: Record<string, number>, last: Record<string, number>): string =>
    SafeJSON.stringify({
        timestamp,
        type: "event_msg",
        payload: {
            type: "token_count",
            info: { total_token_usage: total, last_token_usage: last, model_context_window: 258_400 },
        },
    });

const currentUsage = (response: string): string =>
    SafeJSON.stringify({
        type: "token_usage_record",
        timestamp: "2026-08-27T09:00:10.000Z",
        payload: {
            response_id: response,
            usage: { input_tokens: 120, cached_input_tokens: 100, output_tokens: 30, reasoning_output_tokens: 12 },
        },
    });

describe("codex driver", () => {
    test("current per-response usage is a delta and deduplicates IDs across restored state", () => {
        const first = codexDriver.createParser({ file: "/fixture/rollout.jsonl", state: undefined });
        const events: DriverUsageEvent[] = [];
        first.parseLine(turnContext("gpt-5"), (event) => events.push(event));
        first.parseLine(currentUsage("fixture-one"), (event) => events.push(event));
        const resumed = codexDriver.createParser({ file: "/fixture/rollout.jsonl", state: first.snapshot() });
        resumed.parseLine(currentUsage("fixture-one"), (event) => events.push(event));
        resumed.parseLine(currentUsage("fixture-two"), (event) => events.push(event));
        expect(events).toHaveLength(2);
        expect(events[0]).toMatchObject({
            id: "response:fixture-one",
            inputTokens: 20,
            cacheReadTokens: 100,
            outputTokens: 30,
            reasoningOutputTokens: 12,
        });
        expect(events[1].id).toBe("response:fixture-two");
    });

    test("a mirrored legacy/current record counts once in either order", () => {
        const usage = { input_tokens: 120, cached_input_tokens: 100, output_tokens: 30, reasoning_output_tokens: 12 };
        const legacy = tokenCount("2026-08-27T09:00:10.000Z", usage, usage);
        for (const rows of [
            [legacy, currentUsage("fixture-one")],
            [currentUsage("fixture-one"), legacy],
        ]) {
            expect(collectEvents(codexDriver, [turnContext("gpt-5"), ...rows])).toHaveLength(1);
        }
        // The two copies of one call carry different timestamps; a legacy-first mirror still pairs.
        const earlier = tokenCount("2026-08-27T09:00:09.846Z", usage, usage);
        const legacyFirst = collectEvents(codexDriver, [turnContext("gpt-5"), earlier, currentUsage("fixture-one")]);
        expect(legacyFirst).toHaveLength(1);
        // A legacy call followed by a record with different counts is two calls.
        const other = { ...usage, output_tokens: 31 };
        const distinct = tokenCount("2026-08-27T09:00:09.846Z", other, other);
        const twoCalls = collectEvents(codexDriver, [turnContext("gpt-5"), distinct, currentUsage("fixture-one")]);
        expect(twoCalls).toHaveLength(2);
    });

    test("a rollout with per-response records counts each call once although its token_count lands later", () => {
        // Observed 2026-10-05 in 83 of 89 real rollouts: every call is written twice, as a
        // `token_usage_record` and, 0 ms to minutes later (median 154 ms), as a `token_count` with the
        // same counts. The timestamps never agree, so only the record's presence can tell them apart.
        const usage = { input_tokens: 120, cached_input_tokens: 100, output_tokens: 30, reasoning_output_tokens: 12 };
        const rows = [
            turnContext("gpt-5"),
            currentUsage("resp-1"),
            tokenCount("2026-08-27T09:00:10.166Z", usage, usage),
            currentUsage("resp-2"),
            tokenCount("2026-08-27T09:00:10.304Z", { ...usage, input_tokens: 240, output_tokens: 60 }, usage),
        ];
        const events = collectEvents(codexDriver, rows);

        expect(events.map((event) => event.id)).toEqual(["response:resp-1", "response:resp-2"]);

        // Across a resumed parse the file is still known to carry records.
        const first = codexDriver.createParser({ file: "/fixture/rollout.jsonl", state: undefined });
        const seen: DriverUsageEvent[] = [];
        first.parseLine(turnContext("gpt-5"), (event) => seen.push(event));
        first.parseLine(currentUsage("resp-1"), (event) => seen.push(event));
        const resumed = codexDriver.createParser({ file: "/fixture/rollout.jsonl", state: first.snapshot() });
        resumed.parseLine(tokenCount("2026-08-27T09:00:10.166Z", usage, usage), (event) => seen.push(event));
        expect(seen).toHaveLength(1);
    });

    test("bills last_token_usage with cached input subtracted, model from turn_context", () => {
        const events = collectEvents(codexDriver, [
            turnContext("gpt-5.6-sol"),
            tokenCount(
                "2026-08-27T09:00:10.000Z",
                {
                    input_tokens: 208_890,
                    cached_input_tokens: 185_344,
                    output_tokens: 1_454,
                    reasoning_output_tokens: 362,
                    total_tokens: 210_344,
                },
                {
                    input_tokens: 27_003,
                    cached_input_tokens: 26_368,
                    output_tokens: 139,
                    reasoning_output_tokens: 32,
                    total_tokens: 27_142,
                }
            ),
        ]);

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            model: "gpt-5.6-sol",
            // 27003 − 26368 uncached
            inputTokens: 635,
            outputTokens: 139,
            cacheCreationTokens: 0,
            cacheReadTokens: 26_368,
        });
        // Sol: $4 in · $20 out · $0.4 cacheRead per Mtok. Reasoning is inside output.
        // 0.00254 ordinary input + 0.00278 output + 0.0105472 cache read.
        expect(billedCost(codexDriver, events[0])).toBeCloseTo(0.0158672, 10);
    });

    test("a repeated cumulative total is not billed twice", () => {
        const total = {
            input_tokens: 27_003,
            cached_input_tokens: 26_368,
            output_tokens: 139,
            reasoning_output_tokens: 32,
            total_tokens: 27_142,
        };
        const last = { ...total };
        const events = collectEvents(codexDriver, [
            turnContext("gpt-5-codex"),
            tokenCount("2026-08-27T09:00:10.000Z", total, last),
            // Codex re-emits the same total; `last` must NOT be counted again.
            tokenCount("2026-08-27T09:00:11.000Z", total, last),
        ]);

        expect(events).toHaveLength(1);
        expect(events[0].inputTokens).toBe(635);
    });

    test("falls back to the cumulative difference when last_token_usage is absent", () => {
        const events = collectEvents(codexDriver, [
            turnContext("gpt-5"),
            SafeJSON.stringify({
                timestamp: "2026-08-27T09:00:10.000Z",
                type: "event_msg",
                payload: {
                    type: "token_count",
                    info: { total_token_usage: { input_tokens: 1_000, cached_input_tokens: 400, output_tokens: 50 } },
                },
            }),
            SafeJSON.stringify({
                timestamp: "2026-08-27T09:00:20.000Z",
                type: "event_msg",
                payload: {
                    type: "token_count",
                    info: { total_token_usage: { input_tokens: 2_500, cached_input_tokens: 900, output_tokens: 130 } },
                },
            }),
        ]);

        expect(events).toHaveLength(2);
        expect(events[0]).toMatchObject({ inputTokens: 600, cacheReadTokens: 400, outputTokens: 50 });
        // Second event is the delta: 1500 input, 500 cached, 80 output.
        expect(events[1]).toMatchObject({ inputTokens: 1_000, cacheReadTokens: 500, outputTokens: 80 });
    });

    test("an all-zero usage event is dropped", () => {
        const zero = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };

        expect(
            collectEvents(codexDriver, [turnContext("gpt-5"), tokenCount("2026-08-27T09:00:10.000Z", zero, zero)])
        ).toEqual([]);
    });

    test("the sticky model survives a resume from a persisted snapshot", () => {
        const first = codexDriver.createParser({ file: "/tmp/rollout.jsonl", state: undefined });
        first.parseLine(turnContext("gpt-5.6-sol"), () => undefined);

        const resumed = codexDriver.createParser({ file: "/tmp/rollout.jsonl", state: first.snapshot() });
        const events: DriverUsageEvent[] = [];
        resumed.parseLine(
            tokenCount(
                "2026-08-27T09:05:00.000Z",
                { input_tokens: 100, output_tokens: 10 },
                { input_tokens: 100, output_tokens: 10 }
            ),
            (event) => events.push(event)
        );

        expect(events).toHaveLength(1);
        expect(events[0].model).toBe("gpt-5.6-sol");
    });

    test("price candidates retain distinct named models while supporting legacy codex suffixes", () => {
        expect(codexDriver.priceCandidates("gpt-5.3-codex-spark")).toEqual([
            "gpt-5.3-codex-spark",
            "gpt-5.3-codex",
            "gpt-5.3",
        ]);
        expect(codexDriver.priceCandidates("gpt-5-codex")).toEqual(["gpt-5-codex", "gpt-5"]);
        expect(codexDriver.priceCandidates("gpt-5.6-sol")).toEqual(["gpt-5.6-sol"]);
        expect(codexDriver.priceCandidates("gpt-5.6-terra")).toEqual(["gpt-5.6-terra"]);
        expect(codexDriver.priceCandidates("gpt-5.6-luna")).toEqual(["gpt-5.6-luna"]);
        // Nothing to peel and nothing in the catalog: unpriced, so $0.
        expect(codexDriver.priceCandidates("codex-auto-review")).toEqual(["codex-auto-review"]);
        expect(DEFAULT_PRICING["codex-auto-review"]).toBeUndefined();
    });

    test("a non-string model on a corrupt line never reaches the event", () => {
        // These files are a system boundary; the CodexLine cast validates nothing.
        // A number here used to flow into priceCandidates() and throw on .endsWith.
        const events = collectEvents(codexDriver, [
            turnContext("gpt-5"),
            '{"timestamp":"2026-08-27T09:00:10.000Z","type":"event_msg","payload":{"type":"token_count","model":404,"info":{"last_token_usage":{"input_tokens":100,"output_tokens":10}}}}',
        ]);

        expect(events).toHaveLength(1);
        // Falls through the invalid value to the sticky turn_context model.
        expect(events[0].model).toBe("gpt-5");
        expect(() => codexDriver.priceCandidates(events[0].model)).not.toThrow();
        expect(billedCost(codexDriver, events[0])).toBeCloseTo(100 * 1.25e-6 + 10 * 10e-6, 12);
    });

    test("roots follow CODEX_HOME, comma-separated, sessions + archived_sessions", async () => {
        expect(codexDriver.roots("/home/u")).toEqual(["/home/u/.codex/sessions", "/home/u/.codex/archived_sessions"]);

        await env.testing.withOverrides({ CODEX_HOME: "/a/codex, /b/codex" }, () => {
            expect(codexDriver.roots("/home/u")).toEqual([
                "/a/codex/sessions",
                "/a/codex/archived_sessions",
                "/b/codex/sessions",
                "/b/codex/archived_sessions",
            ]);
        });
    });
});
