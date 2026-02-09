/**
 * Date utilities for Timely commands.
 * Re-exports shared utilities and provides timely-specific formatDuration.
 */
import { formatDuration as _formatDuration } from "@app/utils/format";

export { getMonthDateRange, getDatesInMonth } from "@app/utils/date";

/**
 * Format total seconds as "Xh Ym"
 */
export function formatDuration(totalSeconds: number): string {
    return _formatDuration(totalSeconds, "s", "hm-always");
}
