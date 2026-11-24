/**
 * Seconds as a clock: `1:23:50` from an hour on, `23:50` below it. It has its own file so a reader of a meeting
 * record can name a clock without loading the transcript renderer.
 */
export function formatClock(totalSec: number): string {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = Math.floor(totalSec % 60);
    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");

    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
