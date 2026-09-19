import type { EvaluationResponse } from "./providers";

/**
 * Read one boolean answer's probability, or null when Jev did not answer it as a boolean.
 *
 * This lives here, with only a type import, so reading an answer costs nothing at runtime.
 * `service.ts` would have been the obvious home, but it constructs the AI gateway at module
 * scope, and compaction only ever receives an evaluator rather than creating one.
 *
 * null is "no usable answer", never "false". A caller that treats a missing answer as a no
 * turns Jev declining to answer into a decision it did not make, so every call site either
 * defaults explicitly (`?? 0`) or branches on null.
 */
export function booleanProbability(result: EvaluationResponse | null | undefined, id: string): number | null {
    const answer = result?.answers[id];

    if (answer?.type !== "boolean" || !Number.isFinite(answer.probability)) {
        return null;
    }

    return answer.probability;
}
