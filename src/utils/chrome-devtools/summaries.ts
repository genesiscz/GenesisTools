import type { EventTiming, LayoutShift, LoafFrame, LoafScript, PerfSnapshot } from "./in-page/perf-observers.ts";

export interface Distribution {
    n: number;
    min: number;
    p50: number;
    p90: number;
    max: number;
    mean: number;
}

/** Linear-interpolated percentiles. All zeros for an empty list. Sub-1 values (CLS) keep 4 decimals, the rest 1. */
export function distribution(values: number[]): Distribution {
    if (values.length === 0) {
        return { n: 0, min: 0, p50: 0, p90: 0, max: 0, mean: 0 };
    }

    const sorted = [...values].sort((a, b) => a - b);
    const at = (p: number): number => {
        const index = (sorted.length - 1) * p;
        const low = Math.floor(index);
        const high = Math.ceil(index);
        return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
    };
    const round = (value: number): number =>
        Math.abs(value) >= 1 ? Math.round(value * 10) / 10 : Math.round(value * 10_000) / 10_000;
    return {
        n: sorted.length,
        min: round(sorted[0]),
        p50: round(at(0.5)),
        p90: round(at(0.9)),
        max: round(sorted[sorted.length - 1]),
        mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    };
}

/** `BUTTON#save.onclick` -> `BUTTON.onclick`; `MessagePort.onmessage` stays as it is. */
function eventListenerLabel(invoker: string): string {
    const dot = invoker.lastIndexOf(".");
    if (dot <= 0) {
        return invoker;
    }

    const target = invoker.slice(0, dot).replace(/[#[].*$/, "");
    return `${target || invoker.slice(0, dot)}${invoker.slice(dot)}`;
}

/**
 * A short label for what started a script: `Response.json.then`, `TimerHandler:setTimeout`,
 * `event-listener:BUTTON.onclick`, `event-listener:MessagePort.onmessage`, `classic-script`, `module-script`.
 * An event listener keeps its target type (element ids and attributes dropped), because `MessagePort.onmessage`
 * (a React scheduler tick) and `Worker.onmessage` (a worker reply) are different costs.
 */
export function invokerKind(script: Pick<LoafScript, "invoker" | "invokerType">): string {
    switch (script.invokerType) {
        case "classic-script":
        case "module-script":
            return script.invokerType;
        case "event-listener":
            return `event-listener:${eventListenerLabel(script.invoker)}`;
        default:
            return script.invoker || script.invokerType || "unknown";
    }
}

/** The script that cost the frame the most, or null for a frame with no script (style, layout, paint). */
export function topScript(frame: LoafFrame): LoafScript | null {
    return frame.scripts[0] ?? null;
}

/** `path/to/chunk.js:12345 fnName` for a script, with the origin cut off. */
export function scriptLocation(script: LoafScript): string {
    const path = script.sourceURL.replace(/^[a-z]+:\/\/[^/]+/i, "") || "(inline)";
    const at = script.sourceCharPosition >= 0 ? `:${script.sourceCharPosition}` : "";
    return `${path}${at}${script.sourceFunctionName ? ` ${script.sourceFunctionName}` : ""}`;
}

export interface FrameTotals {
    frames: number;
    totalMs: number;
    blockingMs: number;
    worstMs: number;
    over200: number;
}

export function frameTotals(frames: LoafFrame[]): FrameTotals {
    return {
        frames: frames.length,
        totalMs: Math.round(frames.reduce((sum, frame) => sum + frame.duration, 0)),
        blockingMs: Math.round(frames.reduce((sum, frame) => sum + frame.blockingDuration, 0)),
        worstMs: Math.round(Math.max(0, ...frames.map((frame) => frame.duration))),
        over200: frames.filter((frame) => frame.duration > 200).length,
    };
}

export interface InvokerGroup {
    kind: string;
    frames: number;
    totalMs: number;
    blockingMs: number;
    worstMs: number;
    /** The most expensive script locations of this kind, longest total first. */
    sources: Array<{ location: string; ms: number }>;
}

/** Attributes each frame to its most expensive script's kind (a frame without scripts is `rendering`). */
export function groupByInvoker(frames: LoafFrame[]): InvokerGroup[] {
    const groups = new Map<string, { frames: LoafFrame[]; sources: Map<string, number> }>();
    for (const frame of frames) {
        const top = topScript(frame);
        const kind = top ? invokerKind(top) : "rendering";
        const group = groups.get(kind) ?? { frames: [], sources: new Map<string, number>() };
        groups.set(kind, group);
        group.frames.push(frame);
        if (top) {
            const location = scriptLocation(top);
            group.sources.set(location, (group.sources.get(location) ?? 0) + top.duration);
        }
    }

    return [...groups.entries()]
        .map(([kind, group]) => {
            const totals = frameTotals(group.frames);
            return {
                kind,
                frames: totals.frames,
                totalMs: totals.totalMs,
                blockingMs: totals.blockingMs,
                worstMs: totals.worstMs,
                sources: [...group.sources.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 3)
                    .map(([location, ms]) => ({ location, ms: Math.round(ms) })),
            };
        })
        .sort((a, b) => b.totalMs - a.totalMs);
}

export interface WorstFrame {
    start: number;
    duration: number;
    blockingDuration: number;
    kind: string;
    location: string | null;
    /** The full script URL and character offset, when the script came over http(s): what a source-map lookup takes. */
    source: { url: string; offset: number } | null;
    forcedLayoutMs: number;
}

export function topFrames(frames: LoafFrame[], count = 5): WorstFrame[] {
    return [...frames]
        .sort((a, b) => b.duration - a.duration)
        .slice(0, count)
        .map((frame) => {
            const top = topScript(frame);
            return {
                start: frame.start,
                duration: frame.duration,
                blockingDuration: frame.blockingDuration,
                kind: top ? invokerKind(top) : "rendering",
                location: top ? scriptLocation(top) : null,
                source:
                    top && /^https?:\/\//.test(top.sourceURL) && top.sourceCharPosition >= 0
                        ? { url: top.sourceURL, offset: top.sourceCharPosition }
                        : null,
                forcedLayoutMs: top?.forcedStyleAndLayoutDuration ?? 0,
            };
        });
}

/** Cumulative Layout Shift: the largest session window (gaps under 1 s, at most 5 s), input-driven shifts excluded. */
export function cumulativeLayoutShift(shifts: LayoutShift[]): number {
    let best = 0;
    let windowSum = 0;
    let windowStart = Number.NEGATIVE_INFINITY;
    let previous = Number.NEGATIVE_INFINITY;
    for (const shift of [...shifts].sort((a, b) => a.start - b.start)) {
        if (shift.hadRecentInput) {
            continue;
        }

        if (shift.start - previous > 1000 || shift.start - windowStart > 5000) {
            windowSum = 0;
            windowStart = shift.start;
        }

        windowSum += shift.value;
        previous = shift.start;
        best = Math.max(best, windowSum);
    }

    return Number(best.toFixed(4));
}

/** Interaction to Next Paint: the worst interaction, or the 98th percentile once there are 50 or more. */
export function interactionToNextPaint(events: EventTiming[]): number | null {
    const worstPerInteraction = new Map<number, number>();
    for (const event of events) {
        if (event.interactionId > 0) {
            worstPerInteraction.set(
                event.interactionId,
                Math.max(worstPerInteraction.get(event.interactionId) ?? 0, event.duration)
            );
        }
    }

    const durations = [...worstPerInteraction.values()].sort((a, b) => b - a);
    if (durations.length === 0) {
        return null;
    }

    return durations[Math.min(durations.length - 1, Math.floor(durations.length / 50))];
}

export interface PerfSummary {
    url: string;
    frames: FrameTotals;
    byInvoker: InvokerGroup[];
    worst: WorstFrame[];
    longtasks: { count: number; totalMs: number; worstMs: number };
    cls: number;
    inp: number | null;
    maxLagMs: number;
    marks: Record<string, number>;
    unsupported: string[];
    /** Reasons the numbers may be invalid (a hidden tab, unsupported entry types). */
    warnings: string[];
}

export function summarizePerf(snapshot: PerfSnapshot, worstCount = 5): PerfSummary {
    return {
        url: snapshot.url,
        frames: frameTotals(snapshot.frames),
        byInvoker: groupByInvoker(snapshot.frames),
        worst: topFrames(snapshot.frames, worstCount),
        longtasks: {
            count: snapshot.longtasks.length,
            totalMs: Math.round(snapshot.longtasks.reduce((sum, task) => sum + task[1], 0)),
            worstMs: Math.round(Math.max(0, ...snapshot.longtasks.map((task) => task[1]))),
        },
        cls: cumulativeLayoutShift(snapshot.shifts),
        inp: interactionToNextPaint(snapshot.events),
        maxLagMs: Math.round(Math.max(0, ...snapshot.lags.map((lag) => lag[1]))),
        marks: snapshot.marks,
        unsupported: snapshot.unsupported,
        warnings: [
            ...(snapshot.visibleThroughout === false
                ? [
                      "the page was hidden (a background tab) during the measurement: timers are throttled and frames skipped, so these numbers are not valid",
                  ]
                : []),
            ...(snapshot.unsupported.length > 0
                ? [`this browser does not report: ${snapshot.unsupported.join(", ")}`]
                : []),
        ],
    };
}
