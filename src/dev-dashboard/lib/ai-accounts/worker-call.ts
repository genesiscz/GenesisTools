import { logger } from "@genesiscz/utils/logger";

export interface WorkerCallOptions {
    /** Rejects and terminates the worker after this long. */
    timeoutMs: number;
    /** Names the work in the error and the log line. */
    label: string;
}

export class WorkerCallTimeoutError extends Error {
    constructor(label: string, timeoutMs: number) {
        super(`${label} did not finish within ${Math.round(timeoutMs / 1000)}s`);
        this.name = "WorkerCallTimeoutError";
    }
}

/**
 * Run one job on a Bun worker and await its single reply.
 *
 * The point is the thread, not the parallelism: a synchronous job on the request
 * thread holds the whole server, so an unrelated endpoint waits behind it and the
 * front proxy answers 502 (sweep 2026-09-04, defect 3). One worker per call keeps
 * the caller simple and costs a module load, which the caller amortises with its
 * own cache.
 */
export function callWorker<TIn, TOut>(url: URL, payload: TIn, options: WorkerCallOptions): Promise<TOut> {
    const { timeoutMs, label } = options;

    return new Promise<TOut>((resolve, reject) => {
        const worker = new Worker(url);
        let settled = false;

        const finish = (act: () => void): void => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timer);
            worker.terminate();
            act();
        };

        const timer = setTimeout(() => {
            finish(() => {
                logger.warn({ label, timeoutMs }, "[ai-dashboard] worker call timed out");
                reject(new WorkerCallTimeoutError(label, timeoutMs));
            });
        }, timeoutMs);

        worker.onmessage = (event: MessageEvent<TOut>) => {
            finish(() => resolve(event.data));
        };

        worker.onerror = (event) => {
            finish(() => {
                const message = event.message ?? `${label} worker failed`;
                logger.debug({ label, message }, "[ai-dashboard] worker call errored");
                reject(new Error(message));
            });
        };

        worker.postMessage(payload);
    });
}
