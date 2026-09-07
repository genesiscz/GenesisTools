export interface BlockFixtureInput {
    /** Busy-loop this long, holding the worker's own thread the way a sync scan does. */
    blockMs: number;
}

export interface BlockFixtureOutput {
    blockedMs: number;
}

declare const self: Worker;

/** Stands in for the transcript scan in `worker-call.test.ts`: synchronous, and slow on purpose. */
self.onmessage = (event: MessageEvent<BlockFixtureInput>) => {
    const started = Date.now();

    while (Date.now() - started < event.data.blockMs) {
        // Busy on purpose: a sleep would yield, and yielding is what this proves is not needed.
    }

    self.postMessage({ blockedMs: Date.now() - started } satisfies BlockFixtureOutput);
};
