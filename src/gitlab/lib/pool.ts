import pLimit from "p-limit";

/** Run `fn` over `items` with at most `concurrency` in flight. Results keep input order; the first rejection wins. */
export async function pool<I, O>(
    items: readonly I[],
    concurrency: number,
    fn: (item: I, index: number) => Promise<O>
): Promise<O[]> {
    // p-limit would reject a non-integer later with a less useful message.
    if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new Error("Concurrency must be at least 1");
    }

    const limit = pLimit(concurrency);

    return Promise.all(items.map((item, index) => limit(() => fn(item, index))));
}
