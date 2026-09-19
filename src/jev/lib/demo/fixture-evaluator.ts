import type { EvaluationResponse, Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";

const { log } = logger.scoped("jev-demo");

/**
 * The ONE evaluator the demo reel ever uses. It answers from a scripted table, so a reel run
 * costs nothing and is byte-identical on every machine.
 *
 * It builds a FULL probability distribution over the request's own criteria rather than a canned
 * one, because `admittedChoice` (src/control/lib/decision/decisions.ts) rejects a distribution
 * that misses an allowed key, carries an extra key, or does not sum to 1. PR #410's
 * `fake-evaluate.ts` returned a fixed `{github: 0.93, none: 0.07}` map for every question, which
 * is `invalid_distribution` the moment the candidate list is anything else.
 */

const REQUEST_SCHEMA = z.object({
    state: z.unknown(),
    questions: z.record(
        z.string(),
        z.object({
            type: z.enum(["boolean", "choice", "score"]),
            instructions: z.unknown(),
            criteria: z.unknown().optional(),
        })
    ),
});

export interface FixtureChoiceOption {
    key: string;
    label: string;
}

/** Picks one criteria key. A RegExp matches the key or its label; a function sees every option. */
export type FixtureChoiceRule = RegExp | ((options: FixtureChoiceOption[], state: string) => string);

/** A probability, or a function of the serialized request state so one script can drive a loop. */
export type FixtureProbabilityRule = number | ((state: string) => number);

/** A criteria index (0-based), or a function of the serialized request state. */
export type FixtureScoreRule = number | ((state: string) => number);

export interface FixtureScript {
    /** Ordered: the first pattern that matches the question id wins. */
    choice?: Array<[RegExp, FixtureChoiceRule]>;
    boolean?: Array<[RegExp, FixtureProbabilityRule]>;
    score?: Array<[RegExp, FixtureScoreRule]>;
    defaults?: {
        /** Probability given to the winning choice; the rest share what is left. */
        choiceProbability?: number;
        boolean?: number;
        score?: number;
    };
}

export interface FixtureEvaluator {
    evaluate: Evaluator;
    /** Requests answered so far. A chapter that never calls Jev reports zero. */
    calls(): number;
    /** Questions answered so far, across all requests. */
    questions(): number;
}

const DEFAULT_CHOICE_PROBABILITY = 0.96;
const DEFAULT_BOOLEAN = 0.02;
const DEFAULT_SCORE = 0;
const ABSTAIN_KEYS = ["abstain", "none"];

function optionsOf(criteria: unknown): FixtureChoiceOption[] {
    if (criteria === null || typeof criteria !== "object" || Array.isArray(criteria)) {
        return [];
    }

    return Object.entries(criteria).map(([key, value]) => ({
        key,
        label: typeof value === "string" ? value : SafeJSON.stringify(value ?? key),
    }));
}

function pickChoice(rule: FixtureChoiceRule | undefined, options: FixtureChoiceOption[], state: string): string {
    if (typeof rule === "function") {
        return rule(options, state);
    }

    if (rule) {
        const hit = options.find((option) => rule.test(option.key) || rule.test(option.label));
        if (hit) {
            return hit.key;
        }
    }

    const fallback = options.find((option) => ABSTAIN_KEYS.includes(option.key));
    return fallback?.key ?? options[0]?.key ?? "abstain";
}

/** Winner takes `probability`; every other option shares the remainder so the sum is exactly 1. */
export function fullDistribution(keys: string[], winner: string, probability: number): Record<string, number> {
    if (keys.length <= 1) {
        return Object.fromEntries(keys.map((key) => [key, 1]));
    }

    const share = (1 - probability) / (keys.length - 1);
    return Object.fromEntries(keys.map((key) => [key, key === winner ? probability : share]));
}

function firstRule<T>(rules: Array<[RegExp, T]> | undefined, id: string): T | undefined {
    return rules?.find(([pattern]) => pattern.test(id))?.[1];
}

function scoreAnswer(index: number, count: number): EvaluationResponse["answers"][string] {
    const clamped = Math.min(Math.max(Math.round(index), 0), Math.max(0, count - 1));
    const probabilities = Object.fromEntries(
        Array.from({ length: Math.max(count, 1) }, (_value, position) => [
            String(position),
            position === clamped ? 1 : 0,
        ])
    );
    return { type: "score", score: clamped, probabilities };
}

export function createFixtureEvaluator(script: FixtureScript = {}): FixtureEvaluator {
    let calls = 0;
    let questions = 0;
    const choiceProbability = script.defaults?.choiceProbability ?? DEFAULT_CHOICE_PROBABILITY;

    const evaluate: Evaluator = async (call) => {
        const request = REQUEST_SCHEMA.parse(call.input);
        const state = SafeJSON.stringify(request.state ?? "");
        const answers: EvaluationResponse["answers"] = {};
        for (const [id, question] of Object.entries(request.questions)) {
            if (question.type === "choice") {
                const options = optionsOf(question.criteria);
                const winner = pickChoice(firstRule(script.choice, id), options, state);
                answers[id] = {
                    type: "choice",
                    choice: winner,
                    probabilities: fullDistribution(
                        options.map((option) => option.key),
                        winner,
                        choiceProbability
                    ),
                };
                continue;
            }

            if (question.type === "score") {
                const rule = firstRule(script.score, id) ?? script.defaults?.score ?? DEFAULT_SCORE;
                const criteria = Array.isArray(question.criteria) ? question.criteria : [];
                answers[id] = scoreAnswer(typeof rule === "function" ? rule(state) : rule, criteria.length);
                continue;
            }

            const rule = firstRule(script.boolean, id) ?? script.defaults?.boolean ?? DEFAULT_BOOLEAN;
            answers[id] = { type: "boolean", probability: typeof rule === "function" ? rule(state) : rule };
        }

        calls += 1;
        questions += Object.keys(answers).length;
        log.debug({ questions: Object.keys(request.questions), call: calls }, "fixture evaluator answered a request");
        return {
            model: "fixture/jev-demo",
            answers,
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            warnings: [],
            rounding: { probabilityDecimals: 2, scoreDecimals: 2 },
            providerMetadata: undefined,
        };
    };

    return { evaluate, calls: () => calls, questions: () => questions };
}
