import type { EvaluationResponse, Evaluator } from "@genesiscz/utils/ai/evaluation/service";

export function fakeEvaluator(answers: EvaluationResponse["answers"]): Evaluator {
    return async () => ({
        model: "typesafe-ai/jev",
        answers,
        usage: { inputTokens: 1, outputTokens: 0 },
        warnings: [],
        providerMetadata: { typesafe: { confidence: {} } },
    });
}

export function choice(choice: string, probabilities: Record<string, number>) {
    return { type: "choice" as const, choice, probabilities };
}

export function bool(probability: number) {
    return { type: "boolean" as const, probability };
}

export function score(score: number, probabilities: Record<string, number>) {
    return { type: "score" as const, score, probabilities };
}
