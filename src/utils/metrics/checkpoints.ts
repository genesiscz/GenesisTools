import { SafeJSON } from "@genesiscz/utils/json";
import { MetricsInputError } from "./dims";
import type { CheckpointSpan, MetricFilter } from "./types";

/** A checkpoint as a query needs it: its name and time. A list is sorted by time, then by when it was made. */
export interface CheckpointMark {
    name: string;
    at: number;
}

/** The group of a project with no checkpoint. */
export const NO_CHECKPOINT = "(none)";

/** The group of the events before the project's first checkpoint. */
export function beforeLabel(first: string): string {
    return `(before ${first})`;
}

/**
 * The label of an event at `at`: the latest checkpoint at or before it, else `(before <first name>)`, or `(none)` when
 * the project has none. `marks` is sorted by time; of two at the same time the later one wins.
 */
export function checkpointAt(marks: readonly CheckpointMark[], at: number): string {
    const first = marks[0];

    if (!first) {
        return NO_CHECKPOINT;
    }

    for (let index = marks.length - 1; index >= 0; index--) {
        const mark = marks[index];

        if (mark && mark.at <= at) {
            return mark.name;
        }
    }

    return beforeLabel(first.name);
}

/** The time each label covers: from its checkpoint to the next one; the open ends are left to the caller. */
export function checkpointWindows(
    marks: readonly CheckpointMark[]
): Map<string, { from: number | undefined; to: number | undefined }> {
    const windows = new Map<string, { from: number | undefined; to: number | undefined }>();
    const first = marks[0];

    if (!first) {
        windows.set(NO_CHECKPOINT, { from: undefined, to: undefined });
        return windows;
    }

    windows.set(beforeLabel(first.name), { from: undefined, to: first.at });

    for (const [index, mark] of marks.entries()) {
        windows.set(mark.name, { from: mark.at, to: marks[index + 1]?.at });
    }

    return windows;
}

/**
 * A filter with `sinceCheckpoint` and `untilCheckpoint` turned into times: the later start and the earlier end when a
 * time is given too. An unknown name is refused, with the names the project has.
 */
export function resolveCheckpointBounds<F extends MetricFilter>(
    filter: F,
    marks: readonly CheckpointMark[]
): Omit<F, "sinceCheckpoint" | "untilCheckpoint"> {
    const { sinceCheckpoint, untilCheckpoint, ...rest } = filter;
    const timeOf = (name: string, flag: string): number => {
        const mark = marks.find((each) => each.name === name);

        if (!mark) {
            throw new MetricsInputError(
                `${flag} ${SafeJSON.stringify(name)}: no such checkpoint in project ${filter.project} (${marks.map((each) => each.name).join(", ") || "it has none"})`
            );
        }

        return mark.at;
    };
    const since =
        sinceCheckpoint === undefined ? rest.since : Math.max(timeOf(sinceCheckpoint, "since"), rest.since ?? 0);
    const until =
        untilCheckpoint === undefined
            ? rest.until
            : Math.min(timeOf(untilCheckpoint, "until"), rest.until ?? Number.MAX_SAFE_INTEGER);

    return { ...rest, ...(since === undefined ? {} : { since }), ...(until === undefined ? {} : { until }) };
}

const DAY_MS = 86_400_000;

/**
 * A label's span clipped to the query's window: an open start is the query's `since`, else the first event's time;
 * an open end is the query's `until`, else `now`.
 */
export function checkpointSpan(
    window: { from: number | undefined; to: number | undefined },
    bounds: { since: number | undefined; until: number | undefined; firstAt: number | undefined; now: number }
): CheckpointSpan {
    const start = window.from ?? bounds.since ?? bounds.firstAt ?? bounds.now;
    const end = window.to ?? bounds.until ?? bounds.now;
    const from = bounds.since === undefined ? start : Math.max(start, bounds.since);
    const to = Math.max(from, bounds.until === undefined ? end : Math.min(end, bounds.until));

    return { from, to, days: (to - from) / DAY_MS };
}
