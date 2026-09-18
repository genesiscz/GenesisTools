import { createEvaluator, type Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import type { EvaluationProviderId } from "@genesiscz/utils/ai/evaluation/types";
import { Stopwatch } from "@genesiscz/utils/Stopwatch";
import { z } from "zod";
import { awaitCondition, type ObservationChangeSource, type WaitClock, type WaitState } from "./await";
import type { ControlDriver } from "./native";
import type { Observation } from "./observation";

function observation(value: string, index = 0): Observation {
    return {
        ok: true,
        app: "Wait fixture",
        pid: 1,
        window: { id: 1, title: "Export" },
        scope: "window",
        snapshot: `fixture-${value}-${index}`,
        elements: [{ index, depth: 0, role: "AXStaticText", AXIdentifier: "status", AXValue: value, visible: true }],
    };
}
export const waitCases = [
    {
        id: "ready",
        title: "Loading → ready",
        condition: "The interface displays an export-completed success confirmation.",
        timeoutMs: 4000,
        frames: [
            { atMs: 0, state: "loading", observation: observation("Export in progress") },
            { atMs: 1000, state: "loading", observation: observation("Export in progress", 8) },
            { atMs: 2000, state: "ready", observation: observation("Export completed successfully") },
        ],
    },
    {
        id: "blocked",
        title: "Sign-in required",
        condition: "The interface displays an export-completed success confirmation.",
        timeoutMs: 4000,
        frames: [
            { atMs: 0, state: "loading", observation: observation("Export in progress") },
            { atMs: 1000, state: "blocked", observation: observation("Sign in to continue the export") },
        ],
    },
    {
        id: "failed",
        title: "Observed failure",
        condition: "The interface displays an export-completed success confirmation.",
        timeoutMs: 4000,
        frames: [
            { atMs: 0, state: "loading", observation: observation("Export in progress") },
            { atMs: 1000, state: "failed", observation: observation("Export failed: disk full") },
        ],
    },
    {
        id: "unchanged",
        title: "Stable loading indicator",
        condition: "The interface displays an export-completed success confirmation.",
        timeoutMs: 4000,
        frames: [
            { atMs: 0, state: "loading", observation: observation("Export in progress") },
            { atMs: 1000, state: "loading", observation: observation("Export in progress", 3) },
            { atMs: 2000, state: "loading", observation: observation("Export in progress", 9) },
            { atMs: 3000, state: "loading", observation: observation("Export in progress", 12) },
        ],
    },
] satisfies Array<{
    id: string;
    title: string;
    condition: string;
    timeoutMs: number;
    frames: Array<{ atMs: number; state: WaitState; observation: Observation }>;
}>;

export async function replayWait(options: {
    input: unknown;
    provider?: EvaluationProviderId;
    signal?: AbortSignal;
    evaluate?: Evaluator;
}) {
    const input = z
        .object({ id: z.string(), chooser: z.enum(["oracle", "jev"]).default("oracle") })
        .strict()
        .parse(options.input);
    const fixture = waitCases.find((item) => item.id === input.id);
    if (!fixture) {
        throw new Error("Unknown wait fixture.");
    }
    const wall = new Stopwatch();
    let current = 0;
    let time = 0;
    const clock: WaitClock = {
        now: () => time,
        sleep: async (ms) => {
            time += ms;
        },
    };
    const driver: ControlDriver = {
        observe: async () => structuredClone(fixture.frames[current].observation),
        act: async () => {
            throw new Error("Wait replay never dispatches desktop actions.");
        },
    };
    const source: ObservationChangeSource = {
        kind: "virtual-event-sequence",
        next: async (call) => {
            const next = fixture.frames[current + 1];
            if (!next || next.atMs - time >= call.timeoutMs) {
                time += call.timeoutMs;
                return null;
            }
            current++;
            time = next.atMs;
            return structuredClone(next.observation);
        },
    };
    let live: Promise<Evaluator> | undefined;
    const evaluate: Evaluator =
        input.chooser === "oracle"
            ? async () => {
                  const frame = fixture.frames[current];
                  const id = `e${frame.observation.elements[0].index}`;
                  return {
                      model: "fixture-oracle",
                      answers: {
                          ready: { type: "boolean", probability: frame.state === "ready" ? 1 : 0 },
                          failed: { type: "boolean", probability: frame.state === "failed" ? 1 : 0 },
                          blocked: { type: "boolean", probability: frame.state === "blocked" ? 1 : 0 },
                          loading: { type: "boolean", probability: frame.state === "loading" ? 1 : 0 },
                          evidence: { type: "choice", choice: id, probabilities: { [id]: 1, none: 0 } },
                      },
                      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                      providerMetadata: undefined,
                      warnings: [],
                      rounding: undefined,
                  };
              }
            : async (call) => {
                  live ??= options.evaluate
                      ? Promise.resolve(options.evaluate)
                      : createEvaluator({ provider: options.provider });
                  return (await live)(call);
              };
    const result = await awaitCondition({
        condition: fixture.condition,
        driver,
        source,
        clock,
        evaluate,
        signal: options.signal,
        limits: { timeoutMs: fixture.timeoutMs },
    });
    return {
        ...result,
        mode: "virtual-replay" as const,
        chooser: input.chooser,
        wallMs: wall.elapsedMs,
        paidRequests: input.chooser === "jev" ? result.metrics.requests : 0,
    };
}
export type WaitReplayResult = Awaited<ReturnType<typeof replayWait>>;
