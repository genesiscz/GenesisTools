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

describe("codex driver", () => {
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
        // gpt-5.6: $5 in · $30 out · $0.5 cacheRead per Mtok. Reasoning is inside output.
        // 635×5e-6 + 139×30e-6 + 26368×0.5e-6 = 0.003175 + 0.00417 + 0.013184
        expect(billedCost(codexDriver, events[0])).toBeCloseTo(0.020529, 10);
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

    test("price candidates peel codex and plan suffixes down to a catalog id", () => {
        expect(codexDriver.priceCandidates("gpt-5.3-codex-spark")).toEqual([
            "gpt-5.3-codex-spark",
            "gpt-5.3-codex",
            "gpt-5.3",
        ]);
        expect(codexDriver.priceCandidates("gpt-5-codex")).toEqual(["gpt-5-codex", "gpt-5"]);
        expect(codexDriver.priceCandidates("gpt-5.6-sol")).toEqual(["gpt-5.6-sol", "gpt-5.6"]);
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
