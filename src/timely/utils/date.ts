/**
 * Date utilities for Timely commands.
 * Re-exports shared utilities and provides timely-specific formatDuration.
 */
import { formatDuration as _formatDuration } from "@genesiscz/utils/format";

export { getDatesInMonth, getMonthDateRange } from "@genesiscz/utils/date";

/**
 * Format total seconds as "Xh Ym"
 */
export function formatDuration(totalSeconds: number): string {
    return _formatDuration(totalSeconds, "s", "hm-always");
}
