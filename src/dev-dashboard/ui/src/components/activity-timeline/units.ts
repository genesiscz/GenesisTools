import type { TimelineEvent } from "@app/dev-dashboard/lib/timeline/types";

/** A bucket of events that all fall in the same local hour, newest hour first. */
export interface HourGroup {
    /** Local hour as "HH" (00–23), the grouping key. */
    hourKey: string;
    /** Human label for the hour header, e.g. "14:00". */
    label: string;
    /** Events in this hour, descending by ts (inherits the merged order). */
    events: TimelineEvent[];
}

/** Local hour of a timestamp as a zero-padded "HH". */
function hourKeyOf(ts: number): string {
    return String(new Date(ts).getHours()).padStart(2, "0");
}

/** "09" → "09:00". */
export function hourLabel(hourKey: string): string {
    return `${hourKey}:00`;
}

/**
 * Group an already-descending event list into descending hour buckets. Stable: within a bucket the
 * incoming order is preserved (the merged stream is already ts-desc). A new bucket starts whenever
 * the hour key changes, so a single linear pass keeps the global descending order intact.
 */
export function groupByHour(events: TimelineEvent[]): HourGroup[] {
    const groups: HourGroup[] = [];

    for (const event of events) {
        const hourKey = hourKeyOf(event.ts);
        const last = groups[groups.length - 1];
        if (last && last.hourKey === hourKey) {
            last.events.push(event);
            continue;
        }

        groups.push({ hourKey, label: hourLabel(hourKey), events: [event] });
    }

    return groups;
}

/** Local HH:mm of an event (the leading time on each row). */
export function eventTime(ts: number): string {
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) {
        return "—";
    }

    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

export type EventTone = "accent" | "muted" | "danger";

export interface EventVisual {
    /** CSS color var for the type dot/icon. */
    color: string;
    tone: EventTone;
    /** Short label for the type pill, e.g. "RUN" / "Q&A" / "TERM". */
    pillLabel: string;
}

/** Per-type color + tone + pill label. A failed run is the only one that flips to `danger`. */
export function eventVisual(event: TimelineEvent): EventVisual {
    if (event.type === "run") {
        const failed = event.exitCode !== null && event.exitCode !== 0;
        return {
            color: failed ? "var(--dd-danger)" : "var(--dd-accent-from)",
            tone: failed ? "danger" : "accent",
            pillLabel: "RUN",
        };
    }

    if (event.type === "qa") {
        return { color: "var(--dd-accent-to)", tone: "muted", pillLabel: "Q&A" };
    }

    return { color: "var(--dd-text-secondary)", tone: "muted", pillLabel: "TERM" };
}
