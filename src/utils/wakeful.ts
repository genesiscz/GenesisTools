import { logger } from "@app/logger";

export const WAKEFUL_TICK_MS = 2_000;
export const WAKEFUL_JUMP_THRESHOLD_MS = WAKEFUL_TICK_MS * 5;

export interface WakefulSleepOptions {
    shouldAbort?: () => boolean;
    onWallClockJump?: (ctx: { elapsedMs: number; expectedMs: number }) => void;
    /** When true, timers do not keep the process alive (matches `setInterval().unref()`). */
    unref?: boolean;
}

function delayMs(ms: number, unref: boolean): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);

        if (unref) {
            timer.unref();
        }
    });
}

/**
 * One-shot sleep that survives macOS Low Power Sleep / hibernate. Long `Bun.sleep`
 * calls can wedge on a dropped kqueue timer; short ticks self-heal after wake.
 */
export async function wakefulSleep(totalMs: number, options: WakefulSleepOptions = {}): Promise<void> {
    const shouldAbort = options.shouldAbort ?? (() => false);
    const unref = options.unref ?? false;
    const deadline = Date.now() + totalMs;
    let lastTickAt = Date.now();

    while (!shouldAbort()) {
        const remaining = deadline - Date.now();

        if (remaining <= 0) {
            return;
        }

        const tickMs = Math.min(WAKEFUL_TICK_MS, remaining);

        if (unref) {
            await delayMs(tickMs, true);
        } else {
            await Bun.sleep(tickMs);
        }

        const now = Date.now();
        const elapsed = now - lastTickAt;

        if (elapsed > WAKEFUL_JUMP_THRESHOLD_MS) {
            const ctx = { elapsedMs: elapsed, expectedMs: WAKEFUL_TICK_MS };

            if (options.onWallClockJump) {
                options.onWallClockJump(ctx);
            } else {
                logger.info(ctx, "wakeful sleep: wall-clock jumped (likely wake from sleep); resuming");
            }
        }

        lastTickAt = now;
    }
}

export interface WakefulInterval {
    stop: () => void;
}

export interface WakefulIntervalOptions {
    /**
     * If true (default), fire `tick` once immediately on start, then repeat.
     * If false, wait `intervalMs` before the first fire — matches raw
     * `setInterval(fn, ms)` semantics.
     */
    leading?: boolean;
    onWallClockJump?: WakefulSleepOptions["onWallClockJump"];
    /** When true, the interval does not keep the process alive. */
    unref?: boolean;
}

/**
 * Drop-in replacement for `setInterval(tick, ms)` that survives macOS sleep.
 * Errors thrown by `tick` are logged at debug level; the loop never dies.
 */
export function startWakefulInterval(
    intervalMs: number,
    tick: () => Promise<void> | void,
    options: WakefulIntervalOptions = {}
): WakefulInterval {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        throw new Error(`startWakefulInterval: intervalMs must be a positive finite number, got ${intervalMs}`);
    }

    const leading = options.leading ?? true;
    let running = true;

    const waitInterval = async (): Promise<void> => {
        await wakefulSleep(intervalMs, {
            shouldAbort: () => !running,
            onWallClockJump: options.onWallClockJump,
            unref: options.unref,
        });
    };

    (async () => {
        if (!leading) {
            await waitInterval();
        }

        while (running) {
            try {
                await tick();
            } catch (err) {
                logger.debug({ err }, "wakeful interval tick failed");
            }

            await waitInterval();
        }
    })().catch((err) => logger.error({ err }, "wakeful interval loop died"));

    return {
        stop: () => {
            running = false;
        },
    };
}
