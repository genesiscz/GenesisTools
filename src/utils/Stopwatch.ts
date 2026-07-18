import { formatDuration, formatTimestamp } from "./format";

/**
 * High-resolution stopwatch using performance.now() for measuring elapsed time.
 *
 * @example
 * const sw = new Stopwatch();
 * // ... do work ...
 * console.log(sw.elapsed());    // "1.5s"
 * console.log(sw.elapsedMs);    // 1523.45
 * console.log(sw.lap());        // "0.3s" (since last lap)
 * console.log(sw.stamp());      // "18:35:30.123 [2.1s]"
 */
export class Stopwatch {
    private startMs: number;
    private lapMs: number;

    constructor() {
        this.startMs = performance.now();
        this.lapMs = this.startMs;
    }

    /** Milliseconds since construction (high-resolution). */
    get elapsedMs(): number {
        return performance.now() - this.startMs;
    }

    /** Formatted elapsed since construction (e.g. "1.5s", "2m 30s"). */
    elapsed(): string {
        return formatDuration(this.elapsedMs);
    }

    /** Formatted time since last lap() call (or construction). Resets lap timer. */
    lap(): string {
        const now = performance.now();
        const lapDuration = now - this.lapMs;
        this.lapMs = now;
        return formatDuration(lapDuration);
    }

    /** Current wall-clock timestamp with ms (e.g. "18:35:30.123"). */
    now(): string {
        return formatTimestamp();
    }

    /** Timestamp + elapsed — useful as a log prefix (e.g. "18:35:30.123 [1.5s]"). */
    stamp(): string {
        return `${formatTimestamp()} [${this.elapsed()}]`;
    }

    /** Reset the stopwatch to now. */
    reset(): void {
        this.startMs = performance.now();
        this.lapMs = this.startMs;
    }

    /** "[1.5s]" — for use in template literals. */
    toString(): string {
        return `[${this.elapsed()}]`;
    }
}
