/**
 * Settle with `promise`, or reject as soon as `signal` aborts. Work that takes no signal keeps running;
 * only the wait ends.
 */
export function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) {
        return promise;
    }

    if (signal.aborted) {
        // Observe a later rejection even though the caller already received the abort.
        promise.catch(() => undefined);
        return Promise.reject(signal.reason);
    }

    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
            }
        );
    });
}
