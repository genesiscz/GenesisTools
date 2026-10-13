import { abortableSleep } from "@genesiscz/utils/async";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import type { CdpLike } from "./cdp-like.ts";
import { addInitScript, callInPage, type InitScript, InPageError } from "./evaluate.ts";
import {
    type CollectPerfArgs,
    collectPerf as collectPerfInPage,
    disposePerfObservers,
    type InstallPerfResult,
    installPerfObservers,
    type PerfObserverConfig,
    type PerfSnapshot,
    type ResetMarksArgs,
    resetPerfMarks as resetPerfMarksInPage,
} from "./in-page/perf-observers.ts";
import type { PageCondition, WaitForResult } from "./in-page/wait-for.ts";
import { waitForPage } from "./spa.ts";

const prof = profiler.scope("chrome-devtools");

export type {
    CollectPerfArgs,
    EventTiming,
    InstallPerfResult,
    LayoutShift,
    LoafFrame,
    LoafScript,
    PerfMark,
    PerfObserverConfig,
    PerfSnapshot,
    ResetMarksArgs,
    ResourceTiming,
    ShiftSource,
} from "./in-page/perf-observers.ts";

export interface InstalledPerf extends InitScript {
    /** Set when `now` was requested: the result of installing into the current document too. */
    current?: InstallPerfResult;
}

/**
 * Registers the perf observers as an init script (every new document of this target, before its own
 * scripts) and, with `now`, installs them into the current document as well. Init scripts belong to the
 * CDP session: they stop when it detaches. A document that already has observers under the same `key` keeps
 * its first config (`current.installed` is false then); pass another `key` for a different config.
 * `remove()` unregisters the init script and stops the observers in the current document, so a measurement
 * leaves nothing running in the tab; a flow that keeps observing across steps simply does not call it yet.
 */
export async function installPerf(
    cdp: CdpLike,
    config: PerfObserverConfig = {},
    options: { now?: boolean } = {}
): Promise<InstalledPerf> {
    const script = await addInitScript(cdp, installPerfObservers, config);
    const current = options.now ? await callInPage(cdp, installPerfObservers, config) : undefined;
    return {
        ...script,
        current,
        async remove() {
            await script.remove();
            await callInPage(cdp, disposePerfObservers, { key: config.key }).catch((err: unknown) => {
                // The tab may already be gone or on another document; there is nothing left to stop then.
                logger.debug({ err }, "perf observers: dispose in the current document failed");
            });
        },
    };
}

/** What the observers recorded; `since` and `drain` let each step of a flow read only its own entries. */
export async function collectPerf(cdp: CdpLike, args: CollectPerfArgs = {}): Promise<PerfSnapshot> {
    const snapshot = await callInPage(cdp, collectPerfInPage, args);
    if ("error" in snapshot) {
        throw new InPageError(snapshot.error);
    }

    return snapshot;
}

/** Re-arms the marks (optionally a new list) with times relative to `t0` or now. */
export async function resetPerfMarks(cdp: CdpLike, args: ResetMarksArgs = {}): Promise<number> {
    const result = await callInPage(cdp, resetPerfMarksInPage, args);
    if ("error" in result) {
        throw new InPageError(result.error);
    }

    return result.markBase;
}

/**
 * Waits for one CDP event, or rejects at the deadline. The listener and the timer always go. `cancel()` settles
 * `done` (it rejects with "cancelled", already handled), so a wait nobody awaits any more never rejects later.
 */
export function waitForEvent(
    cdp: CdpLike,
    event: string,
    timeoutMs: number
): { done: Promise<unknown>; cancel(): void } {
    let settle: (error: Error | null, value?: unknown) => void = () => undefined;
    const done = new Promise<unknown>((resolve, reject) => {
        let finished = false;
        const listener = (params: unknown): void => settle(null, params);
        const timer = setTimeout(() => settle(new Error(`${event} did not arrive within ${timeoutMs} ms`)), timeoutMs);
        settle = (error, value) => {
            if (finished) {
                return;
            }

            finished = true;
            clearTimeout(timer);
            cdp.off(event, listener);
            if (error) {
                reject(error);
            } else {
                resolve(value);
            }
        };
        cdp.on(event, listener);
    });
    return {
        done,
        cancel: () => {
            done.catch((err: unknown) => logger.debug({ err, event }, "waitForEvent cancelled"));
            settle(new Error(`waiting for ${event} was cancelled`));
        },
    };
}

export interface MeasureLoadOptions {
    /** Navigate here. Default: reload the current document. */
    url?: string;
    /** Reload bypassing the cache (only for a reload). */
    ignoreCache?: boolean;
    config?: PerfObserverConfig;
    /** After the load event, wait until this holds (bounded by `waitMs`). Without it, wait `waitMs` flat. */
    until?: PageCondition;
    /** Default 10 000 ms. */
    waitMs?: number;
    /** Deadline for the load event. Default 60 000 ms. */
    loadTimeoutMs?: number;
    /** Resource timings to include (URL substrings). */
    resources?: string[];
    /**
     * Activate the tab first (Page.bringToFront). Default true: a background tab throttles timers and skips
     * frames, so a load measured there is not valid. In a headed browser this switches the visible tab.
     */
    bringToFront?: boolean;
}

export interface LoadSample {
    /** Wall time from the navigate/reload command to the load event, measured by the caller's clock. */
    loadEventMs: number;
    until?: WaitForResult;
    snapshot: PerfSnapshot;
}

/**
 * One measured page load: observers as an init script, reload (or navigate), the load event, then a fixed
 * wait or a condition, then the snapshot. The init script is removed afterwards, so repeated calls never
 * stack observers.
 */
export async function measureLoad(cdp: CdpLike, options: MeasureLoadOptions = {}): Promise<LoadSample> {
    const stopProfile = prof.start("perf.load");
    try {
        await cdp.send("Page.enable");
        if (options.bringToFront !== false) {
            await cdp.send("Page.bringToFront");
        }

        const installed = await installPerf(cdp, options.config);
        try {
            const loaded = waitForEvent(cdp, "Page.loadEventFired", options.loadTimeoutMs ?? 60_000);
            const started = performance.now();
            try {
                if (options.url) {
                    await cdp.send("Page.navigate", { url: options.url });
                } else {
                    await cdp.send("Page.reload", { ignoreCache: options.ignoreCache === true });
                }
            } catch (error) {
                loaded.cancel();
                throw error;
            }

            await loaded.done;
            const loadEventMs = Math.round(performance.now() - started);
            const waitMs = options.waitMs ?? 10_000;
            let until: WaitForResult | undefined;
            if (options.until) {
                until = await waitForPage(cdp, options.until, waitMs);
            } else {
                await abortableSleep(waitMs);
            }

            const snapshot = await collectPerf(cdp, { key: options.config?.key, resources: options.resources });
            return { loadEventMs, until, snapshot };
        } finally {
            await installed.remove();
        }
    } finally {
        stopProfile();
    }
}
