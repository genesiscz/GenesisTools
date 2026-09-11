import type { TimelineEvent } from "@app/dev-dashboard/lib/timeline/types";
import { type EventKind, type EventTone, eventKind } from "@app/dev-dashboard/lib/timeline/units";

// The hour bucketing, the row time and the failed-run rule are shared with the mobile app — see
// `@app/dev-dashboard/lib/timeline/units`. Only the colour mapping below is web-specific.
export { eventTime, groupByHour, type HourGroup, hourLabel } from "@app/dev-dashboard/lib/timeline/units";
export type { EventTone };

export interface EventVisual {
    /** CSS color var for the type dot/icon. */
    color: string;
    tone: EventTone;
    /** Short label for the type pill, e.g. "RUN" / "Q&A" / "TERM". */
    pillLabel: string;
}

function colorFor(kind: EventKind): string {
    if (kind.tone === "danger") {
        return "var(--dd-danger)";
    }

    if (kind.pillLabel === "RUN") {
        return "var(--dd-accent-from)";
    }

    if (kind.pillLabel === "Q&A") {
        return "var(--dd-accent-to)";
    }

    return "var(--dd-text-secondary)";
}

/** Per-type color + tone + pill label. A failed run is the only one that flips to `danger`. */
export function eventVisual(event: TimelineEvent): EventVisual {
    const kind = eventKind(event);

    return { color: colorFor(kind), tone: kind.tone, pillLabel: kind.pillLabel };
}
