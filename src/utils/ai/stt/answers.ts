import type { EvaluationResponse } from "@genesiscz/utils/ai/evaluation/service";

export function booleanProbability(result: EvaluationResponse, id: string): number | undefined {
    const answer = result.answers[id];
    return answer?.type === "boolean" && Number.isFinite(answer.probability) ? answer.probability : undefined;
}

export function choiceValue(result: EvaluationResponse, id: string): string | undefined {
    const answer = result.answers[id];
    return answer?.type === "choice" && typeof answer.choice === "string" ? answer.choice : undefined;
}

export function scoreValue(result: EvaluationResponse, id: string): number | undefined {
    const answer = result.answers[id];
    return answer?.type === "score" && Number.isFinite(answer.score) ? answer.score : undefined;
}
