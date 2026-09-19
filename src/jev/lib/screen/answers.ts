import type { EvaluationResponse } from "@genesiscz/utils/ai/evaluation/service";
import type { TemplateQuestion } from "./templates";

/**
 * A Jev question as the evaluation schema wants it, and the reader that turns its answer back
 * into one number. Boolean answers report a probability in 0..1; score answers report the index of
 * the chosen criterion, so a score threshold is an index and a boolean threshold is a probability.
 *
 * A missing key returns `null`, never `0`. `0` is a real answer meaning "certainly not", and B12
 * is exactly what happens when an absent answer is presented as a confident one.
 */
export type EvaluationQuestion =
    | { type: "boolean"; instructions: string }
    | { type: "score"; instructions: string; criteria: string[] };

export function buildQuestion(question: TemplateQuestion, suffix?: string): EvaluationQuestion {
    const instructions = suffix ? `${question.instructions} ${suffix}` : question.instructions;

    if (question.type === "score") {
        return { type: "score", instructions, criteria: question.criteria ?? ["low", "high"] };
    }

    return { type: "boolean", instructions };
}

export function readAnswer(evaluation: EvaluationResponse, key: string): number | null {
    const answer = evaluation.answers[key];

    if (!answer) {
        return null;
    }

    if (answer.type === "boolean") {
        return answer.probability;
    }

    if (answer.type === "score") {
        return answer.score;
    }

    return null;
}
