import type { TimelineEvent, TimelineEventType } from "@dd/contract";

export type { TimelineEvent, TimelineEventType };

/** A bucket of events that all fall in the same local hour, newest hour first. */
export interface HourGroup {
    /** Local hour as "HH" (00–23), the grouping key + `timeline-hour-<HH>` testID suffix. */
    hourKey: string;
    /** Human label for the hour header, e.g. "14:00". */
    label: string;
    /** Events in this hour, descending by ts (inherits the merged order). */
    events: TimelineEvent[];
}
