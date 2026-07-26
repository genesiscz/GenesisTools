/**
 * Streaming stage pipeline: items flow through stages individually, with NO
 * barrier between stages. Stage 2 starts on the first item stage 1 finishes,
 * while stage 1 is still working on the rest.
 *
 * Contrast with `concurrentMap` (@genesiscz/utils/async), which is a barrier:
 * every item must finish stage 1 before stage 2 begins. For a 3-stage pipeline
 * over N items, the barrier costs sum(slowest-per-stage); flow-through costs
 * roughly the slowest single-item chain plus queueing.
 *
 * Each stage has its own concurrency budget, so a slow stage can run 8-wide
 * while a cheap one runs 2-wide, and the stages all run at the same time.
 *
 *   const out = pipeline(sourceArray)
 *       .map("mine", mineWindow, { concurrency: 6 })   // 1 window  -> N episodes
 *       .batch("judge-batch", { size: 4 })             // N episodes -> batches
 *       .map("judge", judgeBatch, { concurrency: 3 })  // 1 batch   -> N verdicts
 *       .collect();
 */

import { type ProfilerScope, profiler } from "@genesiscz/utils/profile";

export type StageResult<O> = O | O[] | undefined | null;

export interface MapStageOptions {
    /** Items processed at once by this stage. Default 4. */
    concurrency?: number;
    /** Called for each item whose fn threw; the item is dropped. Default: rethrow. */
    onError?: (error: unknown, item: unknown) => void;
    /**
     * Tail-latency hedge: after this long, start a SECOND attempt for the same
     * item and keep whichever finishes first. Costs one extra call per straggler
     * and only helps when the slowness is upstream variance rather than the work
     * itself being big. Omit to disable.
     */
    hedgeAfterMs?: number;
    /** Called when a hedge attempt is launched (for logging/metrics). */
    onHedge?: (item: unknown) => void;
}

/**
 * Run `start()`, and if it has not settled within `afterMs`, run it once more in
 * parallel. Resolves with the first success; rejects only if every attempt failed.
 */
export function hedge<O>(start: () => Promise<O>, afterMs: number, onHedge?: () => void): Promise<O> {
    return new Promise<O>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        let pending = 0;
        let lastError: unknown;

        const succeed = (value: O) => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timer);
            resolve(value);
        };

        const fail = (error: unknown) => {
            pending--;
            lastError = error;
            if (!settled && pending === 0) {
                clearTimeout(timer);
                reject(lastError);
            }
        };

        const launch = () => {
            pending++;
            start().then(succeed, fail);
        };

        launch();
        timer = setTimeout(() => {
            if (!settled) {
                onHedge?.();
                launch();
            }
        }, afterMs);
    });
}

export interface BatchOptions {
    /** Flush once this many items are buffered. */
    size: number;
    /**
     * Flush a partial batch after this long with no new item, so a slow upstream
     * doesn't hold a half-full batch hostage. Omit to only flush on size/end.
     */
    maxWaitMs?: number;
}

async function* fromIterable<T>(source: Iterable<T> | AsyncIterable<T>): AsyncGenerator<T> {
    if (Symbol.asyncIterator in Object(source)) {
        yield* source as AsyncIterable<T>;
        return;
    }

    for (const item of source as Iterable<T>) {
        yield item;
    }
}

function normalize<O>(value: StageResult<O>): O[] {
    if (value === undefined || value === null) {
        return [];
    }

    return Array.isArray(value) ? value : [value];
}

/**
 * Map with bounded concurrency, yielding each result the moment it is ready
 * (completion order, NOT input order). A stage fn may return one value, an
 * array (fan-out), or undefined/null (drop the item).
 */
export async function* mapStream<I, O>(
    source: AsyncIterable<I>,
    fn: (item: I) => Promise<StageResult<O>> | StageResult<O>,
    options: MapStageOptions = {}
): AsyncGenerator<O> {
    const concurrency = Math.max(1, options.concurrency ?? 4);
    const iterator = source[Symbol.asyncIterator]();
    const inflight = new Map<
        number,
        Promise<{ id: number; ok: true; out: O[] } | { id: number; ok: false; error: unknown; item: I }>
    >();
    let nextId = 0;
    let drained = false;

    const fill = async (): Promise<void> => {
        while (!drained && inflight.size < concurrency) {
            const next = await iterator.next();
            if (next.done) {
                drained = true;
                return;
            }

            const id = nextId++;
            const item = next.value;
            inflight.set(
                id,
                (async () => {
                    try {
                        const run = () => Promise.resolve(fn(item));
                        const value = options.hedgeAfterMs
                            ? await hedge(run, options.hedgeAfterMs, () => options.onHedge?.(item))
                            : await run();
                        return { id, ok: true as const, out: normalize(value) };
                    } catch (error) {
                        return { id, ok: false as const, error, item };
                    }
                })()
            );
        }
    };

    await fill();

    while (inflight.size > 0) {
        const settled = await Promise.race(inflight.values());
        inflight.delete(settled.id);

        // Discriminate on `ok`, never on the presence of `error`: a stage that
        // throws `undefined` is still a failure and must not be read as output.
        if (!settled.ok) {
            if (!options.onError) {
                throw settled.error;
            }

            options.onError(settled.error, settled.item);
        } else {
            for (const value of settled.out) {
                yield value;
            }
        }

        await fill();
    }
}

/** Group a stream into arrays of `size`, flushing early on `maxWaitMs` idle or at end of stream. */
export async function* batchStream<T>(source: AsyncIterable<T>, options: BatchOptions): AsyncGenerator<T[]> {
    const size = Math.max(1, options.size);
    const iterator = source[Symbol.asyncIterator]();
    let buffer: T[] = [];
    let pending: Promise<IteratorResult<T>> | undefined;

    for (;;) {
        pending ??= iterator.next();

        let result: IteratorResult<T> | "timeout";
        if (options.maxWaitMs !== undefined && buffer.length > 0) {
            // Clear the timer when `pending` wins the race, or every buffered
            // iteration leaves a live timeout behind for the whole wait.
            let handle: ReturnType<typeof setTimeout> | undefined;
            const timer = new Promise<"timeout">((resolve) => {
                handle = setTimeout(() => resolve("timeout"), options.maxWaitMs);
            });

            try {
                result = await Promise.race([pending, timer]);
            } finally {
                clearTimeout(handle);
            }
        } else {
            result = await pending;
        }

        if (result === "timeout") {
            yield buffer;
            buffer = [];
            continue; // keep the same `pending` — the item is still on its way
        }

        pending = undefined;
        if (result.done) {
            break;
        }

        buffer.push(result.value);
        if (buffer.length >= size) {
            yield buffer;
            buffer = [];
        }
    }

    if (buffer.length > 0) {
        yield buffer;
    }
}

export interface PipelineStream<T> extends AsyncIterable<T> {
    /** Add a concurrent stage. Return an array to fan out, undefined to drop. */
    map<O>(
        name: string,
        fn: (item: T) => Promise<StageResult<O>> | StageResult<O>,
        options?: MapStageOptions
    ): PipelineStream<O>;
    /** Group items into arrays; downstream stages receive whole batches. */
    batch(name: string, options: BatchOptions): PipelineStream<T[]>;
    /** Observe items as they pass, without changing them. */
    tap(fn: (item: T) => void): PipelineStream<T>;
    /** Drain the whole pipeline into an array. */
    collect(): Promise<T[]>;
    /** Drain the pipeline, discarding items. */
    drain(): Promise<number>;
}

function wrap<T>(source: AsyncIterable<T>, scope: ProfilerScope, started: number): PipelineStream<T> {
    /** Per-job timing + per-stage totals, so a slow stage is visible without extra plumbing. */
    const timed =
        <I, O>(name: string, fn: (item: I) => Promise<StageResult<O>> | StageResult<O>) =>
        async (item: I): Promise<StageResult<O>> => {
            if (!scope.enabled) {
                return fn(item);
            }

            return scope.measureAsync(name, async () => fn(item));
        };

    const stream: PipelineStream<T> = {
        [Symbol.asyncIterator]: () => source[Symbol.asyncIterator](),
        map: (name, fn, options) => wrap(mapStream(source, timed(name, fn), options), scope, started),
        batch: (name, options) =>
            wrap(
                (async function* () {
                    for await (const batch of batchStream(source, options)) {
                        scope.mark(`${name} n=${batch.length}`);
                        yield batch;
                    }
                })(),
                scope,
                started
            ),
        tap: (fn) =>
            wrap(
                (async function* () {
                    for await (const item of source) {
                        fn(item);
                        yield item;
                    }
                })(),
                scope,
                started
            ),
        collect: async () => {
            const items: T[] = [];
            for await (const item of source) {
                items.push(item);
            }

            summarize(scope, started);
            return items;
        },
        drain: async () => {
            let n = 0;
            for await (const _ of source) {
                n++;
            }

            summarize(scope, started);
            return n;
        },
    };

    return stream;
}

function summarize(scope: ProfilerScope, started: number): void {
    if (!scope.enabled) {
        return;
    }

    scope.mark(`pipeline wall ${((performance.now() - started) / 1000).toFixed(2)}s`);
    scope.summary("per-stage jobs");
}

export interface PipelineOptions {
    /** Profiler scope name; enable with PROFILE=1 or PROFILE=<name>. Default "pipeline". */
    scope?: string;
}

/** Start a flow-through pipeline from any (async) iterable or array. */
export function pipeline<T>(source: Iterable<T> | AsyncIterable<T>, options: PipelineOptions = {}): PipelineStream<T> {
    return wrap(fromIterable(source), profiler.scope(options.scope ?? "pipeline"), performance.now());
}
