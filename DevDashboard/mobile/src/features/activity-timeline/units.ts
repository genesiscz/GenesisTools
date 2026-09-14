import type { TimelineEvent } from "@dd/contract";
import { eventKind, type EventTone } from "@dd/lib/timeline/units";

// The hour bucketing, the row time and the failed-run rule are shared with the web dashboard — see
// `@dd/lib/timeline/units`. Only the icon mapping below is mobile-specific.
export { DASH, eventTime, groupByHour, hourLabel } from "@dd/lib/timeline/units";
export type { EventTone };

export type EventIcon = "cpu" | "message-square" | "terminal";

export interface EventVisual {
    icon: EventIcon;
    tone: EventTone;
    /** Short label for the type pill, e.g. "RUN" / "Q&A" / "TERM". */
    pillLabel: string;
}

const ICON_BY_PILL: Record<string, EventIcon> = {
    RUN: "cpu",
    "Q&A": "message-square",
    TERM: "terminal",
};

/** Per-type icon + tone + pill label. A failed run is the only one that flips to `danger`. */
export function eventVisual(event: TimelineEvent): EventVisual {
    const kind = eventKind(event);

    return { icon: ICON_BY_PILL[kind.pillLabel] ?? "terminal", tone: kind.tone, pillLabel: kind.pillLabel };
}
