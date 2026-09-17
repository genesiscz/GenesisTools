import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { logger } from "@genesiscz/utils/logger";
import { OperationBudget, type OperationLimits } from "@genesiscz/utils/operation-budget";
import { Stopwatch } from "@genesiscz/utils/Stopwatch";
import type { ControlDriver } from "./native";
import { type Candidate, candidatesFor, type Observation, sameScope } from "./observation";

export class ControlSession {
    readonly budget: OperationBudget;
    readonly timings = { observationMs: 0, decisionMs: 0, dispatchMs: 0 };
    readonly usage = { inputTokens: 0, outputTokens: 0 };
    private pinned?: Observation;
    private current?: Observation;
    readonly evaluate: Evaluator;
    constructor(
        readonly options: { driver: ControlDriver; evaluate: Evaluator; limits?: OperationLimits; signal?: AbortSignal }
    ) {
        this.budget = new OperationBudget({ ...options.limits, signal: options.signal });
        this.evaluate = async (call) => {
            this.budget.take("request");
            const clock = new Stopwatch();
            try {
                const result = await options.evaluate({
                    ...call,
                    signal: this.budget.signal,
                    timeoutMs: Math.min(30000, this.budget.remaining()),
                });
                this.usage.inputTokens += result.usage.inputTokens ?? 0;
                this.usage.outputTokens += result.usage.outputTokens ?? 0;
                this.budget.remaining();
                return result;
            } finally {
                this.timings.decisionMs += clock.elapsedMs;
            }
        };
    }
    async observe(): Promise<Observation> {
        const clock = new Stopwatch();
        try {
            const next = await this.options.driver.observe({
                signal: this.budget.signal,
                timeoutMs: Math.min(10000, this.budget.remaining()),
            });
            this.budget.remaining();
            if (this.pinned && !sameScope(this.pinned, next)) {
                throw new Error("App instance or window changed; stopping.");
            }
            this.pinned ??= next;
            this.current = next;
            return next;
        } finally {
            this.timings.observationMs += clock.elapsedMs;
        }
    }
    async dispatch(options: { observation: Observation; candidate: Candidate; value?: string }) {
        const { observation, candidate } = options;
        if (
            !this.pinned ||
            !sameScope(this.pinned, observation) ||
            this.current?.snapshot !== observation.snapshot ||
            !candidatesFor({ observation, action: candidate.action }).some(
                (item) => item.id === candidate.id && item.element === candidate.element
            )
        ) {
            throw new Error("Candidate is outside the current observed scope.");
        }
        this.budget.take("action");
        const clock = new Stopwatch();
        let result: Awaited<ReturnType<ControlDriver["act"]>>;
        try {
            result = await this.options.driver.act({
                ...options,
                signal: this.budget.signal,
                timeoutMs: Math.min(10000, this.budget.remaining()),
            });
        } catch (error) {
            logger.debug({ error }, "Control action transport failed; outcome unknown");
            result = { ok: false, error: "Action transport failed; outcome may be partial. No retry." };
        } finally {
            this.timings.dispatchMs += clock.elapsedMs;
        }
        let after: Observation | undefined;
        let observationError: string | undefined;
        try {
            after = await this.observe();
        } catch (error) {
            observationError = error instanceof Error ? error.message : "Fresh observation failed.";
            logger.debug({ observationError }, "Control could not observe after action");
        }
        return { result, after, observationError };
    }
    report() {
        return { ...this.budget.snapshot(), timings: this.timings, usage: this.usage };
    }
}
