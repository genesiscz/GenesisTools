import { setImmediate } from "node:timers";

/**
 * Time, injectable. The coordinator has three timers (slurp idle, tool grace, heartbeat) and
 * the Go tests drive them with `testing/synctest`; `VirtualClock` is that: tests advance time
 * by hand and every timer due by then fires in order, with the microtask queue drained
 * between firings so a fired timer's consequences land before the next one.
 */

export interface Clock {
    now(): number;
    /** Resolves after `ms`. Rejects with the signal's reason when aborted first. */
    sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export class AbortedError extends Error {
    constructor(message = "aborted") {
        super(message);
        this.name = "AbortedError";
    }
}

export const realClock: Clock = {
    now: () => Date.now(),
    sleep(ms, signal) {
        if (signal?.aborted) {
            return Promise.reject(signal.reason ?? new AbortedError());
        }

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                signal?.removeEventListener("abort", onAbort);
                resolve();
            }, ms);
            const onAbort = () => {
                clearTimeout(timer);
                reject(signal?.reason ?? new AbortedError());
            };
            signal?.addEventListener("abort", onAbort, { once: true });
        });
    },
};

interface PendingTimer {
    due: number;
    sequence: number;
    fire: () => void;
    cancel: () => void;
}

/** Let every queued microtask and immediate callback run. */
export async function drainTasks(rounds = 8): Promise<void> {
    for (let i = 0; i < rounds; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
}

export class VirtualClock implements Clock {
    private current: number;
    private sequence = 0;
    private timers: PendingTimer[] = [];

    constructor(start = 0) {
        this.current = start;
    }

    now(): number {
        return this.current;
    }

    sleep(ms: number, signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) {
            return Promise.reject(signal.reason ?? new AbortedError());
        }

        return new Promise((resolve, reject) => {
            const timer: PendingTimer = {
                due: this.current + Math.max(0, ms),
                sequence: this.sequence++,
                fire: () => {
                    signal?.removeEventListener("abort", onAbort);
                    resolve();
                },
                cancel: () => reject(signal?.reason ?? new AbortedError()),
            };
            const onAbort = () => {
                this.timers = this.timers.filter((entry) => entry !== timer);
                timer.cancel();
            };
            signal?.addEventListener("abort", onAbort, { once: true });
            this.timers.push(timer);
        });
    }

    /** Timers that have not fired yet, nearest first. */
    pending(): number {
        return this.timers.length;
    }

    /**
     * Move time forward by `ms`, firing every timer due on the way in due-then-creation order,
     * and letting the consequences of each settle before the next fires.
     */
    async advance(ms: number): Promise<void> {
        const target = this.current + Math.max(0, ms);

        while (true) {
            await drainTasks();
            this.timers.sort((a, b) => a.due - b.due || a.sequence - b.sequence);
            const next = this.timers[0];

            if (!next || next.due > target) {
                break;
            }

            this.timers.shift();
            this.current = Math.max(this.current, next.due);
            next.fire();
        }

        this.current = target;
        await drainTasks();
    }
}
