import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { booleanProbability, choiceValue } from "../answers";
import { matchWake, type WakeMatch } from "./word";

const prof = profiler.scope("jev-listen");
const log = logger.child({ component: "ai-stt-wake" });

export const WAKE_WOKE_MIN_P = 0.85;
export const WAKE_COMPLETE_MIN_P = 0.7;
export const WAKE_DESTRUCTIVE_MIN_P = 0.5;
/** At most one Jev wake evaluation per this many ms of partials; later partials coalesce. */
export const WAKE_EVAL_INTERVAL_MS = 400;

export interface JevWakeResult {
    woke: boolean;
    remainder: string;
    destructive: boolean;
    complete: boolean;
    probabilities: { woke?: number; complete?: number; destructive?: number };
}

/**
 * Jev-backed wake detection: one fan-out over the utterance answering woke / remainder span /
 * destructive / complete. The deterministic `matchWake` result is part of the state so Jev can
 * confirm or reject a literal hit ("did the user address the tool, or mention the word?").
 */
export async function detectJevWake(options: {
    text: string;
    recent?: string[];
    evaluate: Evaluator;
    phrases: string[];
    signal?: AbortSignal;
}): Promise<JevWakeResult> {
    const contains = matchWake(options.text, options.phrases);
    const evaluation = await prof.measureAsync("wake", () =>
        options.evaluate({
            signal: options.signal,
            input: {
                state: { text: options.text, recent: options.recent ?? [], contains },
                questions: {
                    woke: {
                        type: "boolean",
                        instructions:
                            "Does the user address the assistant by its wake phrase, rather than mention the phrase in passing?",
                    },
                    remainder: {
                        type: "choice",
                        instructions: "Which span of the utterance is the command?",
                        criteria: {
                            "after-wake": "The command follows the wake phrase",
                            whole: "The whole utterance is the command",
                            none: "No command yet",
                        },
                    },
                    destructive: {
                        type: "boolean",
                        instructions: "Is the command irreversible (send, delete, pay, push, submit)?",
                    },
                    complete: {
                        type: "boolean",
                        instructions: "Is the utterance a finished command rather than mid-sentence?",
                    },
                },
            },
        })
    );
    const wokeP = booleanProbability(evaluation, "woke") ?? 0;
    const completeP = booleanProbability(evaluation, "complete") ?? 0;
    const destructiveP = booleanProbability(evaluation, "destructive") ?? 0;
    const span = choiceValue(evaluation, "remainder") ?? "none";
    const result: JevWakeResult = {
        woke: wokeP >= WAKE_WOKE_MIN_P,
        remainder: remainderOf(options.text, contains, span),
        destructive: destructiveP >= WAKE_DESTRUCTIVE_MIN_P,
        complete: completeP >= WAKE_COMPLETE_MIN_P,
        probabilities: { woke: wokeP, complete: completeP, destructive: destructiveP },
    };
    log.debug({ text: options.text.slice(0, 80), span, ...result.probabilities }, "jev wake evaluated");
    return result;
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

/** Coalesces partials so the wake detector is asked at most once per interval. */
export class WakeRateLimiter {
    private lastEvalMs = Number.NEGATIVE_INFINITY;
    private pendingText: string | null = null;

    constructor(
        private readonly intervalMs: number = WAKE_EVAL_INTERVAL_MS,
        private readonly now: () => number = () => Date.now()
    ) {}

    /** Returns the text to evaluate now, or null when this partial must wait. Finals always pass. */
    admit(text: string, isFinal: boolean): string | null {
        const now = this.now();
        if (isFinal || now - this.lastEvalMs >= this.intervalMs) {
            this.lastEvalMs = now;
            this.pendingText = null;
            return text;
        }

        this.pendingText = text;
        return null;
    }

    /** The newest partial that was held back, for a caller that flushes on a timer. */
    takePending(): string | null {
        const text = this.pendingText;
        this.pendingText = null;
        return text;
    }
}
