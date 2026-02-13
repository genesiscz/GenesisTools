/**
 * Shared formatting utilities for CLI tools.
 * Consolidates formatDuration, formatBytes, formatCost, formatTokens,
 * formatRelativeTime, formatList, and formatNumber from across the codebase.
 */

// ============= Duration Formatting =============

type DurationUnit = "ms" | "s" | "min";
type DurationStyle = "tiered" | "hm-always" | "hm-smart" | "hms";

/**
 * Format a duration to a human-readable string.
 *
 * @param value - The numeric duration value
 * @param unit - The unit of the input value: "ms" (default), "s", or "min"
 * @param style - Output format style:
 *   - "tiered" (default): ms → s → m+s → h+m (from colors.ts)
 *   - "hm-always": Always "Xh Ym" (from timely/date.ts)
 *   - "hm-smart": Omits zeros, "< 1m" for sub-minute, rounds minutes (from history.ts)
 *   - "hms": Includes seconds at all levels (from ask/cli.ts)
 */
export function formatDuration(
    value: number,
    unit: DurationUnit = "ms",
    style: DurationStyle = "tiered",
): string {
    // Normalize to milliseconds
    let ms: number;
    switch (unit) {
        case "s":
            ms = value * 1000;
            break;
        case "min":
            ms = value * 60000;
            break;
        default:
            ms = value;
    }

    const totalSeconds = Math.floor(ms / 1000);
    const totalMinutes = ms / 60000;

    switch (style) {
        case "tiered": {
            if (ms < 1000) return `${Math.round(ms)}ms`;
            if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
            if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
            return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
        }

        case "hm-always": {
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            return `${hours}h ${minutes}m`;
        }

        case "hm-smart": {
            if (totalMinutes < 1) return "< 1m";
            let hours = Math.floor(totalMinutes / 60);
            let mins = Math.round(totalMinutes % 60);
            if (mins === 60) { hours++; mins = 0; }
            if (hours === 0) return `${mins}m`;
            if (mins === 0) return `${hours}h`;
            return `${hours}h ${mins}m`;
        }

        case "hms": {
            const seconds = Math.floor(ms / 1000);
            const minutes = Math.floor(seconds / 60);
            const hours = Math.floor(minutes / 60);
            if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
            if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
            return `${seconds}s`;
        }

        default: {
            const _exhaustive: never = style;
            return `${ms}ms`;
        }
    }
}

// ============= Relative Time =============

interface FormatRelativeTimeOptions {
    /** Maximum days before falling back to absolute date. Default: Infinity */
    maxDays?: number;
    /** Fallback formatter when age exceeds maxDays */
    fallbackFormat?: (date: Date) => string;
    /** Rounding mode for time units. Default: "floor" */
    rounding?: "floor" | "round";
    /** Compact output: "5m ago", "3h ago", "2d ago". Default: false */
    compact?: boolean;
}

/**
 * Format a Date as a relative time string like "5 minutes ago".
 * With compact: true, returns "5m ago", "3h ago", "2d ago".
 *
 * @param date - The date to format
 * @param options - Formatting options
 */
export function formatRelativeTime(date: Date, options?: FormatRelativeTimeOptions): string {
    const { maxDays = Infinity, fallbackFormat, rounding = "floor", compact = false } = options ?? {};
    const round = rounding === "round" ? Math.round : Math.floor;

    const diffMs = Date.now() - date.getTime();
    const diffMinutes = round(diffMs / 60000);
    const diffHours = round(diffMs / 3600000);
    const diffDays = round(diffMs / 86400000);

    if (maxDays !== Infinity && diffDays >= maxDays && fallbackFormat) {
        return fallbackFormat(date);
    }

    if (compact) {
        if (diffMinutes < 1) return "now";
        if (diffHours < 1) return `${diffMinutes}m ago`;
        if (diffDays < 1) return `${diffHours}h ago`;
        if (diffDays < 7) return `${diffDays}d ago`;
        return date.toISOString().slice(0, 10);
    }

    if (diffMinutes < 1) return "just now";
    if (diffMinutes === 1) return "1 minute ago";
    if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes !== 1 ? "s" : ""} ago`;
    if (diffHours === 1) return "1 hour ago";
    if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? "s" : ""} ago`;
    return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
}

// ============= Bytes =============

/**
 * Format bytes to human-readable size string.
 * Sub-KB values show no decimals; larger values show 1 decimal place.
 */
export function formatBytes(bytes: number): string {
    const units = ["B", "KB", "MB", "GB", "TB"];
    if (bytes < 1024) return `${bytes} B`;
    let size = bytes;
    let i = 0;
    while (size >= 1024 && i < units.length - 1) {
        size /= 1024;
        i++;
    }
    return `${size.toFixed(1)} ${units[i]}`;
}

// ============= Cost & Tokens =============

/**
 * Format a cost value as "$X.XXXX" (4 decimal places).
 */
export function formatCost(cost: number): string {
    return `$${cost.toFixed(4)}`;
}

/**
 * Format a token count with K/M abbreviations.
 */
export function formatTokens(tokens: number): string {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
    return tokens.toString();
}

// ============= List =============

/**
 * Format a list of items, truncating if too long.
 */
export function formatList(items: string[], maxShow = 5): string {
    if (items.length <= maxShow) return items.join(", ");
    const shown = items.slice(0, maxShow);
    const remaining = items.length - maxShow;
    return `${shown.join(", ")} +${remaining} more`;
}

// ============= Number =============

/**
 * Format a large number with K/M/B abbreviations.
 */
export function formatNumber(n: number): string {
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toString();
}
