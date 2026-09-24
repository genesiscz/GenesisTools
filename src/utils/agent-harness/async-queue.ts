/**
 * An unbounded FIFO with async consumers, standing in for a Go channel.
 *
 * `tryTake()` is the synchronous probe the coordinator's slurp needs ("is anything queued
 * right now"); `available()` is the notification a select can race against a timer without
 * consuming the item; `take()` consumes. `close()` wakes every waiter with `undefined`.
 */
export class AsyncQueue<T> {
    private readonly items: T[] = [];
    private readonly waiters: Array<() => void> = [];
    private closedFlag = false;

    get length(): number {
        return this.items.length;
    }

    get closed(): boolean {
        return this.closedFlag;
    }

    push(item: T): void {
        if (this.closedFlag) {
            throw new Error("push on a closed queue");
        }

        this.items.push(item);
        this.wake();
    }

    close(): void {
        this.closedFlag = true;
        this.wake();
    }

    tryTake(): T | undefined {
        return this.items.shift();
    }

    /** Resolves when an item is queued or the queue is closed. Never consumes. */
    available(signal?: AbortSignal): Promise<void> {
        if (this.items.length > 0 || this.closedFlag || signal?.aborted) {
            return Promise.resolve();
        }

        return new Promise((resolve) => {
            const done = () => {
                signal?.removeEventListener("abort", done);
                const index = this.waiters.indexOf(done);

                if (index >= 0) {
                    this.waiters.splice(index, 1);
                }

                resolve();
            };
            this.waiters.push(done);
            signal?.addEventListener("abort", done, { once: true });
        });
    }

    /** Consumes the next item; `undefined` once the queue is closed and drained, or on abort. */
    async take(signal?: AbortSignal): Promise<T | undefined> {
        while (true) {
            const item = this.items.shift();

            if (item !== undefined) {
                return item;
            }

            if (this.closedFlag || signal?.aborted) {
                return undefined;
            }

            await this.available(signal);
        }
    }

    private wake(): void {
        const waiters = this.waiters.splice(0);

        for (const waiter of waiters) {
            waiter();
        }
    }
}
