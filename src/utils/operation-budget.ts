import { z } from "zod";

export const operationLimitsSchema = z.object({
    timeoutMs: z.number().int().min(1).max(300000).default(120000),
    maxActions: z.number().int().min(0).max(50).default(8),
    maxRequests: z.number().int().min(0).max(100).default(20),
});
export type OperationLimits = z.input<typeof operationLimitsSchema>;

export class OperationBudget {
    readonly limits;
    readonly signal: AbortSignal;
    readonly started: number;
    private readonly clock: { now(): number };
    actions = 0;
    requests = 0;
    constructor(options: OperationLimits & { signal?: AbortSignal; clock?: { now(): number } }) {
        this.clock = options.clock ?? { now: () => performance.now() };
        this.started = this.clock.now();
        this.limits = operationLimitsSchema.parse(options);
        const deadline = AbortSignal.timeout(this.limits.timeoutMs);
        this.signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    }
    remaining(): number {
        this.signal.throwIfAborted();
        const remaining = Math.floor(this.limits.timeoutMs - (this.clock.now() - this.started));
        if (remaining <= 0) {
            throw new Error("Operation deadline reached.");
        }
        return remaining;
    }
    take(kind: "action" | "request"): void {
        this.remaining();
        const count = kind === "action" ? this.actions : this.requests;
        const limit = kind === "action" ? this.limits.maxActions : this.limits.maxRequests;
        if (count >= limit) {
            throw new Error(`Operation ${kind} budget exhausted (${limit}).`);
        }
        if (kind === "action") {
            this.actions++;
        } else {
            this.requests++;
        }
    }
    snapshot() {
        return {
            actions: this.actions,
            requests: this.requests,
            elapsedMs: this.clock.now() - this.started,
            limits: this.limits,
        };
    }
}
