import { logger } from "@genesiscz/utils/logger";

/**
 * A queue that buffers async operations and drains them sequentially.
 * Used by vector stores that wrap async backends behind a sync interface.
 */
export class AsyncOpQueue {
    private pendingOps: Array<() => Promise<void>> = [];
    private flushPromise: Promise<void> | null = null;
    private label: string;
    private firstError: unknown = null;

    constructor(label: string = "AsyncOpQueue") {
        this.label = label;
    }

    enqueue(op: () => Promise<void>): void {
        this.pendingOps.push(op);
        this.scheduleFlush();
    }

    async flush(): Promise<void> {
        while (this.flushPromise || this.pendingOps.length > 0) {
            if (this.flushPromise) {
                await this.flushPromise;
            }

            if (this.pendingOps.length > 0) {
                this.scheduleFlush();
                await this.flushPromise;
            }
        }

        if (this.firstError) {
            const err = this.firstError;
            this.firstError = null;
            throw err;
        }
    }

    get pending(): number {
        return this.pendingOps.length;
    }

    private scheduleFlush(): void {
        if (this.flushPromise) {
            return;
        }

        this.flushPromise = this.drainQueue().finally(() => {
            this.flushPromise = null;

            if (this.pendingOps.length > 0) {
                this.scheduleFlush();
            }
        });
    }

    private async drainQueue(): Promise<void> {
        while (this.pendingOps.length > 0) {
            const op = this.pendingOps.shift()!;

            try {
                await op();
            } catch (err) {
                logger.error({ err, label: this.label }, "background queue error");

                if (!this.firstError) {
                    this.firstError = err;
                }
            }
        }
    }
}
