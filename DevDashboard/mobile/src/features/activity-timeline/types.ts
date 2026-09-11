import type { TimelineEvent, TimelineEventType } from "@dd/contract";

export type { TimelineEvent, TimelineEventType };

/**
 * A bucket of events that all fall in the same local hour, newest hour first. `hourKey` is also the
 * `timeline-hour-<HH>` testID suffix. Declared once in the shared lib so the two surfaces cannot
 * drift apart on the shape they both group into.
 */
export type { HourGroup } from "@dd/lib/timeline/units";
