import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { booleanProbability, choiceValue } from "./answers";
import { matchWake, type WakeMatch } from "./wake-word";

export interface JevWakeResult {
    woke: boolean;
    remainder: string;
    destructive: boolean;
    complete: boolean;
    probabilities: { woke?: number; complete?: number; destructive?: number };
}

export async function detectJevWake(options: {
    text: string;
    recent?: string[];
    evaluate: Evaluator;
    phrases: string[];
    signal?: AbortSignal;
}): Promise<JevWakeResult> {
    const contains = matchWake(options.text, options.phrases);
    const evaluation = await options.evaluate({
        signal: options.signal,
        input: {
            state: { text: options.text, recent: options.recent ?? [], contains },
            questions: {
                woke: {
                    type: "boolean",
                    instructions: "Does the user address GenesisTools, not mention the word in passing?",
                },
                remainder: {
                    type: "choice",
                    instructions: "Which span is the command?",
                    criteria: {
                        "after-wake": "Command follows the wake phrase",
                        whole: "The whole utterance is the command",
                        none: "No command yet",
                    },
                },
                destructive: {
                    type: "boolean",
                    instructions: "Is the command irreversible (send, delete, pay, push)?",
                },
                complete: {
                    type: "boolean",
                    instructions: "Is the utterance a finished command rather than mid-sentence?",
                },
            },
        },
    });
    const wokeP = booleanProbability(evaluation, "woke") ?? 0;
    const completeP = booleanProbability(evaluation, "complete") ?? 0;
    const destructiveP = booleanProbability(evaluation, "destructive") ?? 0;
    const span = choiceValue(evaluation, "remainder") ?? "none";
    const woke = wokeP >= 0.85;
    const complete = completeP >= 0.7;
    return {
        woke,
        remainder: remainderOf(options.text, contains, span),
        destructive: destructiveP >= 0.5,
        complete,
        probabilities: { woke: wokeP, complete: completeP, destructive: destructiveP },
    };
}

function remainderOf(text: string, contains: WakeMatch | null, span: string): string {
    if (span === "none") {
        return "";
    }
    if (span === "after-wake" && contains) {
        return contains.remainder;
    }
    return text;
}

export function canDispatchWake(result: JevWakeResult, confirmedDestructive = false): boolean {
    if (!result.woke || !result.complete) {
        return false;
    }
    if (result.destructive && !confirmedDestructive) {
        return false;
    }
    return true;
}
