import { profiler } from "@genesiscz/utils/profile";
import { type Distribution, distribution } from "./summaries.ts";

const prof = profiler.scope("chrome-devtools");

export interface AbVariant<V = unknown> {
    name: string;
    /** Whatever the caller's setup needs to apply this variant. */
    config?: V;
}

export type AbOrder = "abba" | "same";

export interface AbRun<V> {
    variant: AbVariant<V>;
    /** 1-based round. */
    round: number;
    /** 0-based index over all runs. */
    index: number;
}

export interface AbSample<S> {
    variant: string;
    round: number;
    index: number;
    startedAt: string;
    wallMs: number;
    sample?: S;
    metrics?: Record<string, number>;
    error?: string;
}

export interface AbVariantSummary {
    variant: string;
    runs: number;
    failed: number;
    metrics: Record<string, Distribution>;
}

export interface AbResult<S> {
    samples: AbSample<S>[];
    summary: AbVariantSummary[];
    aborted: boolean;
}

export interface AbOptions<V, S> {
    variants: AbVariant<V>[];
    rounds: number;
    /** `abba` (default) reverses the order every other round, so drift over time hits every variant alike. */
    order?: AbOrder;
    /** Applies the variant before the run: rewrite rules, storage reset, emulation. */
    setup?(run: AbRun<V>): Promise<void> | void;
    /** Performs one run and returns its sample. A throw is recorded and the harness moves on. */
    measure(run: AbRun<V>): Promise<S>;
    /** The numbers compared across variants. */
    metrics(sample: S): Record<string, number>;
    /** Undoes `setup`. Runs after every run, also a failed one. */
    teardown?(run: AbRun<V>): Promise<void> | void;
    /** Called after every run with all samples so far: persist here, so a crash keeps the finished runs. */
    onSample?(sample: AbSample<S>, all: AbSample<S>[]): Promise<void> | void;
    signal?: AbortSignal;
}

/** The run order: `abba` gives ABCD, DCBA, ABCD, ... */
export function abSchedule<V>(variants: AbVariant<V>[], rounds: number, order: AbOrder = "abba"): AbRun<V>[] {
    const runs: AbRun<V>[] = [];
    for (let round = 1; round <= rounds; round++) {
        const sequence = order === "abba" && round % 2 === 0 ? [...variants].reverse() : variants;
        for (const variant of sequence) {
            runs.push({ variant, round, index: runs.length });
        }
    }

    return runs;
}

/** Per-variant distributions of every metric, in the variants' order. */
export function summarizeAb<S>(samples: AbSample<S>[], variantNames?: string[]): AbVariantSummary[] {
    const names = variantNames ?? [...new Set(samples.map((sample) => sample.variant))];
    return names.map((variant) => {
        const own = samples.filter((sample) => sample.variant === variant);
        const ok = own.filter((sample) => sample.metrics);
        const keys = [...new Set(ok.flatMap((sample) => Object.keys(sample.metrics ?? {})))];
        return {
            variant,
            runs: own.length,
            failed: own.length - ok.length,
            metrics: Object.fromEntries(
                keys.map((key) => [
                    key,
                    distribution(
                        ok
                            .map((sample) => sample.metrics?.[key])
                            .filter((value): value is number => typeof value === "number")
                    ),
                ])
            ),
        };
    });
}

/**
 * Runs every variant `rounds` times in interleaved order and reports per-variant distributions, never a
 * single sample. The harness knows nothing about what a variant means: `setup` applies it, `measure` runs it.
 */
export async function runAb<V, S>(options: AbOptions<V, S>): Promise<AbResult<S>> {
    const stopProfile = prof.start("ab.run");
    try {
        const samples: AbSample<S>[] = [];
        let aborted = false;
        for (const run of abSchedule(options.variants, options.rounds, options.order)) {
            if (options.signal?.aborted) {
                aborted = true;
                break;
            }

            const started = performance.now();
            const entry: AbSample<S> = {
                variant: run.variant.name,
                round: run.round,
                index: run.index,
                startedAt: new Date().toISOString(),
                wallMs: 0,
            };
            try {
                await options.setup?.(run);
                entry.sample = await options.measure(run);
                entry.metrics = options.metrics(entry.sample);
            } catch (error) {
                entry.error = error instanceof Error ? error.message : String(error);
            } finally {
                try {
                    await options.teardown?.(run);
                } catch (error) {
                    entry.error = `${entry.error ? `${entry.error}; ` : ""}teardown: ${error instanceof Error ? error.message : String(error)}`;
                }
            }

            entry.wallMs = Math.round(performance.now() - started);
            samples.push(entry);
            await options.onSample?.(entry, samples);
        }

        return {
            samples,
            summary: summarizeAb(
                samples,
                options.variants.map((variant) => variant.name)
            ),
            aborted,
        };
    } finally {
        stopProfile();
    }
}
