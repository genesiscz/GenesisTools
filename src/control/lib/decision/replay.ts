import { evaluationSchema } from "@genesiscz/utils/ai/evaluation/evaluate";
import { type EvaluationResponse, type Evaluator, evaluateRequest } from "@genesiscz/utils/ai/evaluation/service";
import type { EvaluationProviderId } from "@genesiscz/utils/ai/evaluation/types";
import { DEFAULT_EVALUATION_PROVIDER } from "@genesiscz/utils/ai/evaluation/types";
import { Stopwatch } from "@genesiscz/utils/Stopwatch";
import { z } from "zod";
import { judgeOutcome, resolveIntent } from "./decisions";
import { replayCaseSchema } from "./fixtures";
import { candidatesFor } from "./observation";

export const replayRequestSchema = z
    .object({
        fixture: replayCaseSchema,
        chooser: z.enum(["exact", "mock", "jev"]).default("mock"),
    })
    .strict();
export type ReplayResult = Awaited<ReturnType<typeof replayControl>>;

export async function replayControl(options: {
    input: unknown;
    provider?: EvaluationProviderId;
    signal?: AbortSignal;
    evaluate?: Evaluator;
}) {
    const { fixture, chooser } = replayRequestSchema.parse(options.input);
    options.signal?.throwIfAborted();
    const clock = new Stopwatch();
    const candidates = candidatesFor({ observation: fixture.observation });
    let requests = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let usageKnown = true;
    let costUsd = 0;
    let costKnown = true;
    const evaluate: Evaluator = async (call) => {
        if (chooser === "jev") {
            requests++;
            const result = await (options.evaluate ?? evaluateRequest)({ ...call, provider: options.provider });
            usageKnown &&= result.usage.inputTokens !== undefined && result.usage.outputTokens !== undefined;
            inputTokens += result.usage.inputTokens ?? 0;
            outputTokens += result.usage.outputTokens ?? 0;
            const reportedCost = result.providerMetadata?.gateway?.cost;
            const cost =
                typeof reportedCost === "string" || typeof reportedCost === "number" ? Number(reportedCost) : NaN;
            costKnown &&= Number.isFinite(cost);
            if (Number.isFinite(cost)) {
                costUsd += cost;
            }
            return result;
        }
        const input = evaluationSchema.parse(call.input);
        const answers: EvaluationResponse["answers"] = {};
        for (const [id, question] of Object.entries(input.questions)) {
            if (question.type === "boolean") {
                const value =
                    chooser === "mock" && (id === "complete" || id === "sufficient")
                        ? fixture.expectedOutcome === "verified"
                        : chooser === "mock" && id === "contradicted" && fixture.expectedOutcome === "refuted";
                answers[id] = { type: "boolean", probability: value ? 1 : 0 };
            } else if (question.type === "choice") {
                const exact = candidates.filter(
                    (item) => item.label.toLowerCase() === fixture.intent.trim().toLowerCase()
                );
                const selected =
                    chooser === "mock"
                        ? candidates.find((item) => item.element === fixture.expectedElement)?.id
                        : exact.length === 1
                          ? exact[0].id
                          : undefined;
                const witness = chooser === "mock" && fixture.mockWitness !== null ? `e${fixture.mockWitness}` : "none";
                const choice = id === "target" ? (selected ?? "abstain") : witness;
                answers[id] = {
                    type: "choice",
                    choice,
                    probabilities: Object.fromEntries(
                        Object.keys(question.criteria).map((key) => [key, key === choice ? 1 : 0])
                    ),
                };
            }
        }
        return {
            model: chooser,
            answers,
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            warnings: [],
            rounding: undefined,
            providerMetadata: undefined,
        };
    };
    const resolution = await resolveIntent({
        observation: fixture.observation,
        intent: fixture.intent,
        evaluate,
        signal: options.signal,
    });
    const judgment = await judgeOutcome({
        observation: fixture.observation,
        expect: fixture.expect,
        evaluate,
        signal: options.signal,
    });
    const selectedElement = resolution.selected?.element ?? null;
    return {
        fixtureId: fixture.id,
        chooser,
        provider: chooser === "jev" ? (options.provider ?? DEFAULT_EVALUATION_PROVIDER) : null,
        resolution,
        judgment,
        expected: { element: fixture.expectedElement, outcome: fixture.expectedOutcome },
        metrics: {
            correctTarget: selectedElement === fixture.expectedElement,
            correctOutcome: judgment.status === fixture.expectedOutcome,
            abstained: selectedElement === null,
            wrongTarget: selectedElement !== null && selectedElement !== fixture.expectedElement,
            actions: 0,
            requests,
            inputTokens: usageKnown ? inputTokens : null,
            outputTokens: usageKnown ? outputTokens : null,
            costUsd: chooser !== "jev" ? 0 : costKnown ? costUsd : null,
            observationMs: 0,
            decisionMs: resolution.decisionMs,
            dispatchMs: null,
            verificationMs: judgment.verificationMs,
            totalMs: clock.elapsedMs,
        },
        mode: "decision-only" as const,
        note:
            chooser === "mock"
                ? "Oracle fixture responses: validates plumbing, not model accuracy."
                : "No desktop action was dispatched. Outcome labels describe the retained observation.",
    };
}
