import { useSettings } from "@/lib/hooks/useSettings";

/**
 * Resolves the persisted 12h/24h preference into the `hour12` boolean for
 * `Date.prototype.toLocaleTimeString` option objects.
 */
export function useTimeFormat(): { hour12: boolean } {
    return { hour12: useSettings().settings.timeFormat === "12h" };
}
