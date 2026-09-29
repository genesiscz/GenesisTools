import { setTimeout as delay } from "node:timers/promises";
import { byId } from "@genesiscz/utils/ai/catalog";
import { EvaluationError } from "@genesiscz/utils/ai/evaluation/errors";
import { JEV_MODEL } from "@genesiscz/utils/ai/evaluation/evaluate";
import type { Evaluator as ServiceEvaluator } from "@genesiscz/utils/ai/evaluation/service";
import type { EvaluationProviderId } from "@genesiscz/utils/ai/evaluation/types";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import type { GrepCache } from "./cache";
import { EvaluationFailure, type EvaluationPolicy, type EvaluationRequest, type Evaluator, jsonBytes } from "./types";

const { log } = logger.scoped("jev-grep");
const prof = profiler.scope("jev-grep");

/** Only grep pins this; listen, watch, route and verify stay on `jev-latest`. */
export const GREP_TYPESAFE_MODEL = "jev-1.13.0";
export const DEFAULT_CONCURRENCY = 32;
export const DEFAULT_REQUEST_LIMIT = 50_000;
/** Bumped when the question text changes, so old answers stop matching. */
const PROMPT_VERSION = "unit-locators-1";
const RATE_LIMIT_FALLBACK_MS = 1000;
/** Deadline sleeps only. A shorter wait is rounded up so no timer here fires in under 100 ms. */
const MIN_WAIT_MS = 100;
const MAX_WAIT_MS = 60_000;

export function grepModelFor(provider: EvaluationProviderId): string {
    return provider === "typesafe" ? GREP_TYPESAFE_MODEL : JEV_MODEL;
}

export function grepTimeoutFor(provider: EvaluationProviderId): number {
    return provider === "typesafe" ? 60_000 : 15_000;
}

/**
 * Rolling per-process budgets from upstream `packages/core/src/rate-budget.ts`: 250 000 input tokens
 * per second and 1 200 requests per minute, TypeSafe only. Concurrency stays with the evaluator.
 */
export function createRateBudget(limits: { tokensPerSecond: number; requestsPerMinute: number }, now: () => number) {
    const starts: Array<{ at: number; tokens: number }> = [];
    function waitMs(tokens: number): number {
        if (!Number.isSafeInteger(tokens) || tokens < 0 || tokens > limits.tokensPerSecond) {
            throw new Error("Token reservation exceeds the rate budget");
        }

        const time = now();
        while (starts.length && starts[0]!.at <= time - 60_000) {
            starts.shift();
        }

        let wait =
            starts.length >= limits.requestsPerMinute
                ? starts[starts.length - limits.requestsPerMinute]!.at + 60_000 - time
                : 0;
        const recent = starts.filter((entry) => entry.at > time - 1000);
        let total = recent.reduce((sum, entry) => sum + entry.tokens, 0) + tokens;
        for (const entry of recent) {
            if (total <= limits.tokensPerSecond) {
                break;
            }

            total -= entry.tokens;
            wait = Math.max(wait, entry.at + 1000 - time);
        }

        return wait;
    }

    return {
        waitMs,
        reserve(tokens: number) {
            if (waitMs(tokens) > 0) {
                throw new Error("Rate budget is not available");
            }

            const entry = { at: now(), tokens };
            starts.push(entry);
            return {
                reconcile(inputTokens: number | undefined): void {
                    if (inputTokens !== undefined && Number.isSafeInteger(inputTokens) && inputTokens >= 0) {
                        entry.tokens = inputTokens;
                    }
                },
            };
        },
    };
}

/** A conservative byte reservation bounded by Jev's largest input. Returned usage replaces it. */
export function estimatedInputTokens(request: EvaluationRequest): number {
    return Math.min(65_536, jsonBytes(request) + 512 + 32 * Object.keys(request.questions).length);
}

export interface GrepEvaluatorOptions {
    /** The shared transport from `createEvaluator`. It books `recordUsage` and logs every call. */
    evaluate: ServiceEvaluator;
    provider: EvaluationProviderId;
    model?: string;
    signal: AbortSignal;
    cache?: GrepCache;
    /** Filesystem flags; different flags ask different questions, so they key the cache. */
    policyVersion?: string;
    concurrency?: number;
    requestLimit?: number;
    /** Stop before the next attempt once the booked list price reaches this many dollars. */
    maxCostUsd?: number;
    /** Tests only. Production uses `grepTimeoutFor(provider)`. */
    timeoutMs?: number;
    /** Tests only: a fake clock and a fake sleep, so a 429 wait takes no wall time. */
    now?: () => number;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export type GrepEvaluator = Evaluator & { readonly provider: EvaluationProviderId; readonly model: string };

function validScores(request: EvaluationRequest, answers: Record<string, unknown>): Record<string, number> | undefined {
    const scores: Record<string, number> = {};
    for (const id of Object.keys(request.questions)) {
        const answer = answers[id];
        if (
            !answer ||
            typeof answer !== "object" ||
            !("type" in answer) ||
            answer.type !== "boolean" ||
            !("probability" in answer) ||
            typeof answer.probability !== "number" ||
            !Number.isFinite(answer.probability) ||
            answer.probability < 0 ||
            answer.probability > 1
        ) {
            return undefined;
        }

        scores[id] = answer.probability;
    }

    return scores;
}

/**
 * What the shared client must not grow, because listen and watch pace themselves: a concurrency
 * semaphore, a runaway request ceiling, the upstream attempt policy, the TypeSafe rate budget, and the
 * answer cache. Every network attempt still goes through `createEvaluator`, so `tools ai usage` sees it.
 */
export function createGrepEvaluator(options: GrepEvaluatorOptions): GrepEvaluator {
    const model = options.model ?? grepModelFor(options.provider);
    const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    const requestLimit = options.requestLimit ?? DEFAULT_REQUEST_LIMIT;
    const timeoutMs = options.timeoutMs ?? grepTimeoutFor(options.provider);
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }));
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
        throw new Error("Concurrency must be a positive integer");
    }

    // `Infinity` passes a `>=` cap forever and `NaN` never trips it, so neither may reach a paid run.
    if (!Number.isSafeInteger(requestLimit) || requestLimit < 1) {
        throw new Error("The request limit must be a positive integer");
    }

    if (options.maxCostUsd !== undefined && !(Number.isFinite(options.maxCostUsd) && options.maxCostUsd > 0)) {
        throw new Error("The cost limit must be a finite number of dollars above 0");
    }

    let requests = 0;
    let cacheHits = 0;
    let cooldownUntil = 0;
    const spend = { inputTokens: 0, costUsd: 0, unpricedCalls: 0 };
    // Dollars the calls in flight may still book. A call starts only while booked plus reserved spend is
    // under the cap, so concurrent workers cannot all pass on a cost no answer has booked yet.
    let reservedCostUsd = 0;
    // The highest price per estimated input token: the catalog's list price, raised by any booked call.
    // The estimate counts JSON bytes, which outnumber tokens, so a reservation errs high.
    let usdPerToken = (byId(model, `jev-${options.provider}`)?.pricing?.inputPer1M ?? 0) / 1_000_000;
    const rateBudget =
        options.provider === "typesafe"
            ? createRateBudget({ tokensPerSecond: 250_000, requestsPerMinute: 1_200 }, now)
            : undefined;
    const authenticationFailure = new AbortController();
    const stopped = AbortSignal.any([options.signal, authenticationFailure.signal]);
    let active = 0;
    const waiting: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
    stopped.addEventListener(
        "abort",
        () => {
            const kind = options.signal.aborted ? "cancelled" : "authentication";
            for (const waiter of waiting.splice(0)) {
                waiter.reject(new EvaluationFailure(kind));
            }
        },
        { once: true }
    );

    function assertActive(): void {
        if (options.signal.aborted) {
            throw new EvaluationFailure("cancelled");
        }

        if (authenticationFailure.signal.aborted) {
            throw new EvaluationFailure("authentication");
        }
    }

    function assertBelowLimit(): void {
        if (requests >= requestLimit) {
            throw new EvaluationFailure("request-limit");
        }

        if (options.maxCostUsd !== undefined && spend.costUsd + reservedCostUsd >= options.maxCostUsd) {
            throw new EvaluationFailure("request-limit", {
                message: `Cost budget of $${options.maxCostUsd} reached`,
            });
        }
    }

    async function acquire(): Promise<() => void> {
        assertActive();
        if (active < concurrency) {
            active++;
        } else {
            await new Promise<void>((resolve, reject) => waiting.push({ resolve, reject }));
        }

        return () => {
            const next = waiting.shift();
            if (next) {
                next.resolve();
            } else {
                active--;
            }
        };
    }

    /**
     * Wait out a 429 cooldown and the rate budget, validate the donors, recheck both, then claim the
     * request, its tokens and its estimated dollars in the same synchronous step as the check, so no
     * other worker can spend them in between.
     */
    async function claimSlot(reservedTokens: number, costTokens: number, policy?: EvaluationPolicy) {
        for (;;) {
            const wait = Math.max(cooldownUntil - now(), rateBudget?.waitMs(reservedTokens) ?? 0);
            if (wait > 0) {
                try {
                    await sleep(Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, wait)), stopped);
                } catch {
                    assertActive();
                    throw new EvaluationFailure("cancelled");
                }

                continue;
            }

            await policy?.beforeAttempt?.();
            assertActive();
            if (cooldownUntil <= now() && (rateBudget?.waitMs(reservedTokens) ?? 0) <= 0) {
                // Another worker may have spent the last request while this one waited.
                assertBelowLimit();
                requests++;
                const costUsd = costTokens * usdPerToken;
                reservedCostUsd += costUsd;
                return { tokens: rateBudget?.reserve(reservedTokens), costUsd };
            }
        }
    }

    return {
        provider: options.provider,
        model,
        get requests() {
            return requests;
        },
        get cacheHits() {
            return cacheHits;
        },
        get spend() {
            return { ...spend };
        },
        get cacheIssues() {
            return options.cache?.stats().warnings ?? [];
        },
        async evaluate(request, policy) {
            assertActive();
            const questionIds = Object.keys(request.questions);
            const keyInput = (answeredBy: string) => ({
                namespace: {
                    provider: options.provider,
                    model: answeredBy,
                    policyVersion: options.policyVersion ?? "{}",
                    promptVersion: PROMPT_VERSION,
                },
                sources: policy?.sources ?? [],
                request,
            });
            const cached = await options.cache?.get(keyInput(model));
            assertActive();
            if (
                cached &&
                Object.keys(cached).length === questionIds.length &&
                questionIds.every((id) => typeof cached[id] === "number" && cached[id]! >= 0 && cached[id]! <= 1)
            ) {
                // The key names content hashes; re-reading the donors is what makes the hit trustworthy.
                await policy?.beforeAttempt?.();
                assertActive();
                cacheHits++;
                return cached;
            }

            const navigation = policy?.navigation === true;
            const multiple = questionIds.length > 1;
            const reservedTokens = rateBudget ? estimatedInputTokens(request) : 0;
            const costTokens = options.maxCostUsd === undefined ? 0 : estimatedInputTokens(request);
            let attemptLimit = navigation && multiple ? 1 : 2;
            for (let attempt = 0; attempt < attemptLimit; attempt++) {
                assertActive();
                assertBelowLimit();
                const release = await acquire();
                let heldUsd = 0;
                const settle = () => {
                    reservedCostUsd -= heldUsd;
                    heldUsd = 0;
                };
                try {
                    assertActive();
                    const claimed = await claimSlot(reservedTokens, costTokens, policy);
                    heldUsd = claimed.costUsd;
                    const stop = prof.start("evaluate");
                    const response = await options
                        .evaluate({ input: request, timeoutMs, signal: stopped })
                        .finally(() => stop());
                    claimed.tokens?.reconcile(response.usage.inputTokens);
                    settle();
                    spend.inputTokens += response.usage.inputTokens ?? 0;
                    if (response.costUsd === undefined) {
                        spend.unpricedCalls++;
                    } else {
                        spend.costUsd += response.costUsd;
                        if (costTokens > 0) {
                            usdPerToken = Math.max(usdPerToken, response.costUsd / costTokens);
                        }
                    }

                    const scores = validScores(request, response.answers);
                    if (!scores) {
                        throw new Error("Invalid answer");
                    }

                    log.debug(
                        {
                            provider: options.provider,
                            model: response.model,
                            questions: questionIds.length,
                            requests,
                            cacheHits,
                        },
                        "Grep evaluation answered"
                    );
                    // Keyed by the model that answered: a renamed model is a miss next time, never a stale hit.
                    await options.cache?.put(keyInput(response.model), scores);
                    return scores;
                } catch (error) {
                    settle();
                    if (error instanceof EvaluationFailure) {
                        throw error;
                    }

                    assertActive();
                    if (error instanceof EvaluationError && error.code === "authentication") {
                        authenticationFailure.abort();
                        throw new EvaluationFailure("authentication", { message: error.message });
                    }

                    assertBelowLimit();
                    const rateLimit =
                        error instanceof EvaluationError && error.code === "rate-limit" ? error : undefined;
                    const rateLimited = rateLimit !== undefined;
                    if (rateLimit) {
                        cooldownUntil = Math.max(
                            cooldownUntil,
                            now() + (rateLimit.retryAfterMs ?? RATE_LIMIT_FALLBACK_MS)
                        );
                        if (navigation) {
                            attemptLimit = Math.max(attemptLimit, 2);
                        }
                    }

                    const transient = error instanceof EvaluationError && error.transient;
                    if ((navigation && !transient) || attempt + 1 === attemptLimit) {
                        const description =
                            error instanceof EvaluationError
                                ? error.message.slice(0, 500)
                                : "Invalid or incomplete provider response";
                        log.debug(
                            {
                                provider: options.provider,
                                questions: questionIds.length,
                                navigation,
                                transient,
                                attempt,
                            },
                            "Grep evaluation gave up"
                        );
                        throw new EvaluationFailure("provider", {
                            splitEligible: navigation && multiple && transient && !rateLimited,
                            message: `${description} (max concurrent requests: ${concurrency})`,
                        });
                    }
                } finally {
                    settle();
                    release();
                }
            }

            throw new EvaluationFailure("provider");
        },
    };
}
