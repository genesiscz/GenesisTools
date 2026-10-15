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

/** The script that cost the frame the most, or null for a frame no script of 5 ms or more accounts for. */
export function topScript(frame: LoafFrame): LoafScript | null {
    return frame.scripts[0] ?? null;
}

/** The kind of a script-less frame whose time passed before its render phase: not style, layout or paint. */
export const UNTRACKED_KIND = "untracked (no script, before render)";

/** Milliseconds from a phase start (`renderStart`, `styleAndLayoutStart`) to the frame's end; 0 when it did not run. */
function phaseMs(frame: LoafFrame, phaseStart: number): number {
    return phaseStart > 0 ? Math.max(0, frame.start + frame.duration - phaseStart) : 0;
}

/** The render phase: `renderStart` to the frame's end (style, layout, paint and the rAF callbacks). */
export function renderPhaseMs(frame: LoafFrame): number {
    return phaseMs(frame, frame.renderStart);
}

/** Style and layout: `styleAndLayoutStart` to the frame's end. */
export function styleAndLayoutMs(frame: LoafFrame): number {
    return phaseMs(frame, frame.styleAndLayoutStart);
}

/**
 * The kind of a frame: its most expensive script's kind, or for a frame with no script, `rendering` when the render
 * phase is most of it and `UNTRACKED_KIND` otherwise. Untracked time is main-thread work LoAF attributes to no script:
 * scripts under 5 ms, garbage collection, parsing, or a DevTools call such as `Profiler.stop` serializing a profile.
 */
export function frameKind(frame: LoafFrame): string {
    const top = topScript(frame);
    if (top) {
        return invokerKind(top);
    }

    return renderPhaseMs(frame) > frame.duration / 2 ? "rendering" : UNTRACKED_KIND;
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

/** Attributes each frame to its `frameKind`: its most expensive script's kind, `rendering` or `UNTRACKED_KIND`. */
export function groupByInvoker(frames: LoafFrame[]): InvokerGroup[] {
    const groups = new Map<string, { frames: LoafFrame[]; sources: Map<string, number> }>();
    for (const frame of frames) {
        const top = topScript(frame);
        const kind = frameKind(frame);
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
    /** The render phase (`renderPhaseMs`), so a script-less frame shows whether rendering really took its time. */
    renderMs: number;
    styleAndLayoutMs: number;
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
                kind: frameKind(frame),
                location: top ? scriptLocation(top) : null,
                source:
                    top && /^https?:\/\//.test(top.sourceURL) && top.sourceCharPosition >= 0
                        ? { url: top.sourceURL, offset: top.sourceCharPosition }
                        : null,
                forcedLayoutMs: top?.forcedStyleAndLayoutDuration ?? 0,
                renderMs: renderPhaseMs(frame),
                styleAndLayoutMs: styleAndLayoutMs(frame),
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
    /** The longest lag while the page was visible (`visibleMaxLagMs`). */
    maxLagMs: number;
    /** Milliseconds the page spent hidden; 0 when it stayed visible or the snapshot does not say. */
    hiddenMs: number;
    marks: Record<string, number>;
    unsupported: string[];
    /** Reasons the numbers may be invalid (a hidden tab, unsupported entry types). */
    warnings: string[];
}

/** Whether a lag `[start, ms]` overlaps a range the page spent hidden. */
function overlapsHidden([start, late]: [number, number], spans: Array<[number, number]>): boolean {
    return spans.some(([from, to]) => start < to && start + late > from);
}

/**
 * The longest main-thread lag while the page was visible. A hidden tab runs its timers about once a second, which
 * the lag sampler would report as ~950 ms lags that are background throttling, not lag.
 */
export function visibleMaxLagMs(snapshot: Pick<PerfSnapshot, "lags" | "hiddenSpans">): number {
    const spans = snapshot.hiddenSpans ?? [];
    const visible = snapshot.lags.filter((lag) => !overlapsHidden(lag, spans));
    return Math.round(Math.max(0, ...visible.map((lag) => lag[1])));
}

/** Why a measurement of a page that was hidden part of the time is suspect; nothing when it stayed visible. */
function hiddenWarnings(snapshot: PerfSnapshot, hiddenMs: number): string[] {
    const spans = snapshot.hiddenSpans ?? [];
    if (spans.length > 0) {
        return [
            `the page was hidden (a background tab) for ${hiddenMs} ms from page time ${Math.round(spans[0][0])} ms: its timers were throttled, so max lag counts only the visible time, while frames and long tasks still include the hidden part`,
        ];
    }

    if (snapshot.visibleThroughout === false) {
        return [
            "the page was hidden (a background tab) during the measurement: timers are throttled and frames skipped, so these numbers are not valid, and this snapshot does not say when, so max lag includes the throttled timers",
        ];
    }

    return [];
}

export function summarizePerf(snapshot: PerfSnapshot, worstCount = 5): PerfSummary {
    const hiddenMs = Math.round((snapshot.hiddenSpans ?? []).reduce((sum, [from, to]) => sum + (to - from), 0));
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
        maxLagMs: visibleMaxLagMs(snapshot),
        hiddenMs,
        marks: snapshot.marks,
        unsupported: snapshot.unsupported,
        warnings: [
            ...hiddenWarnings(snapshot, hiddenMs),
            ...(snapshot.unsupported.length > 0
                ? [`this browser does not report: ${snapshot.unsupported.join(", ")}`]
                : []),
        ],
    };
}
