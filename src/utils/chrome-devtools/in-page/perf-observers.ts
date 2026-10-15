export interface PerfMark {
    name: string;
    /** The element(s) to look at. Without it, the mark looks at `document.body`. */
    selector?: string;
    /** Text that the element's textContent must contain. */
    text?: string;
    /** Minimum rendered height in px (laid out, not just mounted). */
    minHeight?: number;
    /** Exact `location.pathname` the page must be on. */
    path?: string;
}

export interface PerfObserverConfig {
    /** window slot for the state. Default `__gtPerf`. */
    key?: string;
    /** Keep long animation frames at least this long. Default 50 ms. */
    loafMinMs?: number;
    /** Scripts kept per frame, longest first. Default 8. */
    scriptsPerFrame?: number;
    /** Default true. */
    longtasks?: boolean;
    /** Default true. */
    layoutShifts?: boolean;
    /** Event-timing threshold (the platform minimum is 16). 0 turns event timing off. Default 16. */
    eventMinMs?: number;
    /** Lag sampler interval. 0 turns the sampler (and mark checks) off. Default 50 ms. */
    tickMs?: number;
    /** Record a lag when a tick arrives at least this late. Default 50 ms. */
    lagMinMs?: number;
    marks?: PerfMark[];
    /** Stop ticking this long after install or the last resetMarks. Default 120 000 ms. */
    activeMs?: number;
}

export interface LoafScript {
    duration: number;
    invoker: string;
    invokerType: string;
    sourceURL: string;
    sourceFunctionName: string;
    sourceCharPosition: number;
    forcedStyleAndLayoutDuration: number;
    pauseDuration: number;
}

export interface LoafFrame {
    start: number;
    duration: number;
    blockingDuration: number;
    renderStart: number;
    styleAndLayoutStart: number;
    scripts: LoafScript[];
}

export interface ShiftSource {
    node: string;
    testId: string | null;
    text: string;
    from: [number, number, number, number];
    to: [number, number, number, number];
}

export interface LayoutShift {
    start: number;
    value: number;
    hadRecentInput: boolean;
    sources: ShiftSource[];
}

export interface EventTiming {
    name: string;
    start: number;
    duration: number;
    inputDelay: number;
    processing: number;
    interactionId: number;
    target: string | null;
}

export interface PerfState {
    installedAt: number;
    markBase: number;
    frames: LoafFrame[];
    longtasks: Array<[number, number]>;
    shifts: LayoutShift[];
    events: EventTiming[];
    lags: Array<[number, number]>;
    marks: Record<string, number>;
    unsupported: string[];
    /** `document.visibilityState` at install, then every change as [time, state]. */
    visibility: { atInstall: string; changes: Array<[number, string]> };
}

export interface InstallPerfResult {
    /** False when `window[key]` already held observers: nothing changed, and the earlier config stays. */
    installed: boolean;
    unsupported: string[];
}

/**
 * Installs PerformanceObservers (long-animation-frame with script attribution, longtask, layout-shift with
 * source nodes, event timing) plus a lag sampler that also checks the marks, on `window[key]`. Run it as an
 * init script so it sees the page from its first script; `buffered: true` still catches earlier entries when
 * it is installed late. Idempotent per document: a second call with another config (say `loafMinMs: 30`)
 * keeps the first config and returns `installed: false`; use another `key` to run a second set side by side.
 * The sampler stops ticking once `activeMs` passed (`resetPerfMarks` starts it again); `disposePerfObservers`
 * stops everything this installed. Self-contained: only its source reaches the page.
 */
export function installPerfObservers(config: PerfObserverConfig): InstallPerfResult {
    const key = config.key ?? "__gtPerf";
    const host = window as unknown as Record<string, unknown>;
    const existing = host[key] as PerfState | undefined;
    if (existing) {
        return { installed: false, unsupported: existing.unsupported };
    }

    const round = (value: number): number => Math.round(value * 10) / 10;
    const state: PerfState = {
        installedAt: round(performance.now()),
        markBase: 0,
        frames: [],
        longtasks: [],
        shifts: [],
        events: [],
        lags: [],
        marks: {},
        unsupported: [],
        visibility: { atInstall: document.visibilityState, changes: [] },
    };
    host[key] = state;
    const observers: PerformanceObserver[] = [];
    let timer: ReturnType<typeof setInterval> | undefined;
    // A hidden (background) tab throttles timers and skips frames, so its numbers are not valid.
    const onVisibility = (): void => {
        state.visibility.changes.push([round(performance.now()), document.visibilityState]);
    };
    document.addEventListener("visibilitychange", onVisibility);
    host[`${key}Dispose`] = () => {
        for (const observer of observers) {
            observer.disconnect();
        }

        if (timer !== undefined) {
            clearInterval(timer);
            timer = undefined;
        }

        document.removeEventListener("visibilitychange", onVisibility);
        delete host[key];
        delete host[`${key}Control`];
        delete host[`${key}Dispose`];
    };
    const supported = (PerformanceObserver.supportedEntryTypes ?? []) as string[];

    const describe = (node: Node | null | undefined): { node: string; testId: string | null; text: string } => {
        const element = node instanceof Element ? node : (node?.parentElement ?? null);
        if (!element) {
            return { node: node ? node.nodeName : "?", testId: null, text: "" };
        }

        const className = typeof element.className === "string" ? element.className.trim().split(/\s+/)[0] : "";
        return {
            node: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${className ? `.${className}` : ""}`,
            testId: element.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
            text: (element.textContent ?? "").trim().slice(0, 40),
        };
    };

    const rect = (r: DOMRectReadOnly): [number, number, number, number] => [
        Math.round(r.x),
        Math.round(r.y),
        Math.round(r.width),
        Math.round(r.height),
    ];

    const observe = (type: string, options: Record<string, unknown>, onEntry: (entry: PerformanceEntry) => void) => {
        if (!supported.includes(type)) {
            state.unsupported.push(type);
            return;
        }

        const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                onEntry(entry);
            }
        });
        observer.observe({ type, buffered: true, ...options } as PerformanceObserverInit);
        observers.push(observer);
    };

    const loafMin = config.loafMinMs ?? 50;
    const scriptsPerFrame = config.scriptsPerFrame ?? 8;
    observe("long-animation-frame", {}, (entry) => {
        if (entry.duration < loafMin) {
            return;
        }

        const frame = entry as PerformanceEntry & {
            blockingDuration: number;
            renderStart: number;
            styleAndLayoutStart: number;
            scripts?: Array<Record<string, unknown>>;
        };
        state.frames.push({
            start: round(frame.startTime),
            duration: round(frame.duration),
            blockingDuration: round(frame.blockingDuration ?? 0),
            renderStart: round(frame.renderStart ?? 0),
            styleAndLayoutStart: round(frame.styleAndLayoutStart ?? 0),
            scripts: (frame.scripts ?? [])
                .map((script) => ({
                    duration: round(Number(script.duration ?? 0)),
                    invoker: String(script.invoker ?? ""),
                    invokerType: String(script.invokerType ?? ""),
                    sourceURL: String(script.sourceURL ?? ""),
                    sourceFunctionName: String(script.sourceFunctionName ?? ""),
                    sourceCharPosition: Number(script.sourceCharPosition ?? -1),
                    forcedStyleAndLayoutDuration: round(Number(script.forcedStyleAndLayoutDuration ?? 0)),
                    pauseDuration: round(Number(script.pauseDuration ?? 0)),
                }))
                .sort((a, b) => b.duration - a.duration)
                .slice(0, scriptsPerFrame),
        });
    });

    if (config.longtasks !== false) {
        observe("longtask", {}, (entry) => {
            state.longtasks.push([round(entry.startTime), round(entry.duration)]);
        });
    }

    if (config.layoutShifts !== false) {
        observe("layout-shift", {}, (entry) => {
            const shift = entry as PerformanceEntry & {
                value: number;
                hadRecentInput: boolean;
                sources?: Array<{ node?: Node | null; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }>;
            };
            state.shifts.push({
                start: round(shift.startTime),
                value: Number(shift.value.toFixed(5)),
                hadRecentInput: shift.hadRecentInput,
                sources: (shift.sources ?? []).slice(0, 5).map((source) => ({
                    ...describe(source.node),
                    from: rect(source.previousRect),
                    to: rect(source.currentRect),
                })),
            });
        });
    }

    const eventMin = config.eventMinMs ?? 16;
    if (eventMin > 0) {
        observe("event", { durationThreshold: Math.max(16, eventMin) }, (entry) => {
            const event = entry as PerformanceEntry & {
                processingStart: number;
                processingEnd: number;
                interactionId?: number;
                target?: Node | null;
            };
            const target = event.target ? describe(event.target) : null;
            state.events.push({
                name: event.name,
                start: round(event.startTime),
                duration: round(event.duration),
                inputDelay: round(event.processingStart - event.startTime),
                processing: round(event.processingEnd - event.processingStart),
                interactionId: event.interactionId ?? 0,
                target: target ? `${target.node}${target.testId ? ` [${target.testId}]` : ""}` : null,
            });
        });
    }

    const tickMs = config.tickMs ?? 50;
    if (tickMs > 0) {
        const lagMin = config.lagMinMs ?? 50;
        const activeMs = config.activeMs ?? 120_000;
        const control: {
            last: number;
            until: number;
            marks: PerfMark[];
            checkMarks?: () => void;
            start?: () => void;
        } = {
            last: performance.now(),
            until: performance.now() + activeMs,
            marks: config.marks ?? [],
        };
        host[`${key}Control`] = control;

        const holds = (mark: PerfMark): boolean => {
            if (mark.path !== undefined && location.pathname !== mark.path) {
                return false;
            }

            const elements: Element[] = mark.selector
                ? Array.from(document.querySelectorAll(mark.selector))
                : document.body
                  ? [document.body]
                  : [];
            return elements.some((element) => {
                if (mark.text !== undefined && !(element.textContent ?? "").includes(mark.text)) {
                    return false;
                }

                return mark.minHeight === undefined || element.getBoundingClientRect().height >= mark.minHeight;
            });
        };

        // Also called by collectPerf, so a mark that holds when a snapshot is taken (the moment an `until`
        // condition fired) is recorded even though the next tick has not come yet.
        control.checkMarks = () => {
            const now = performance.now();
            if (now > control.until) {
                return;
            }

            for (const mark of control.marks) {
                if (state.marks[mark.name] === undefined && holds(mark)) {
                    state.marks[mark.name] = round(now - state.markBase);
                }
            }
        };

        const tick = (): void => {
            const now = performance.now();
            if (now > control.until) {
                // Past activeMs nothing is recorded, so stop waking the page; resetPerfMarks starts it again.
                clearInterval(timer);
                timer = undefined;
                return;
            }

            const late = now - control.last - tickMs;
            if (late >= lagMin) {
                state.lags.push([round(control.last), round(late)]);
            }

            control.last = now;
            control.checkMarks?.();
        };
        control.start = () => {
            if (timer === undefined) {
                control.last = performance.now();
                timer = setInterval(tick, tickMs);
            }
        };
        control.start();
    }

    return { installed: true, unsupported: state.unsupported };
}

export interface ResetMarksArgs {
    key?: string;
    /** New marks to watch. Default: keep the current list. */
    marks?: PerfMark[];
    /** Base for mark times (a `performance.now()` value). Default: now. */
    t0?: number;
    /** Keep ticking this long from now. Default 120 000 ms. */
    activeMs?: number;
}

/** Re-arms the marks for the next step of a single-page flow. Returns the new base time. */
export function resetPerfMarks(args: ResetMarksArgs): { markBase: number } | { error: string } {
    const key = args.key ?? "__gtPerf";
    const host = window as unknown as Record<string, unknown>;
    const state = host[key] as PerfState | undefined;
    const control = host[`${key}Control`] as { until: number; marks: PerfMark[]; start?: () => void } | undefined;
    if (!state) {
        return { error: `perf observers are not installed on window.${key}` };
    }

    state.markBase = args.t0 ?? performance.now();
    state.marks = {};
    if (control) {
        control.until = performance.now() + (args.activeMs ?? 120_000);
        control.marks = args.marks ?? control.marks;
        control.start?.();
    }

    return { markBase: state.markBase };
}

export interface DisposePerfArgs {
    key?: string;
}

/**
 * Stops what `installPerfObservers` started in this document (observers, lag sampler, visibility listener) and
 * drops its buffers, so the page is left as it was. False when nothing was installed under `key`.
 */
export function disposePerfObservers(args: DisposePerfArgs): { disposed: boolean } {
    const dispose = (window as unknown as Record<string, unknown>)[`${args.key ?? "__gtPerf"}Dispose`];
    if (typeof dispose !== "function") {
        return { disposed: false };
    }

    dispose();
    return { disposed: true };
}

export interface CollectPerfArgs {
    key?: string;
    /** Only entries that start at or after this `performance.now()` time. */
    since?: number;
    /** Remove the returned entries from the page's buffers. */
    drain?: boolean;
    /** Resource timings whose URL contains one of these strings (none when absent). */
    resources?: string[];
}

export interface ResourceTiming {
    name: string;
    initiatorType: string;
    start: number;
    duration: number;
    transferSize: number;
}

export interface PerfSnapshot {
    url: string;
    now: number;
    installedAt: number;
    markBase: number;
    frames: LoafFrame[];
    longtasks: Array<[number, number]>;
    shifts: LayoutShift[];
    events: EventTiming[];
    lags: Array<[number, number]>;
    marks: Record<string, number>;
    unsupported: string[];
    /** The page was visible the whole time (a hidden tab throttles timers and skips frames). */
    visibleThroughout: boolean;
    /** Page-time ranges `[from, to]` the page spent hidden. Absent in snapshots saved before 2026-10-13. */
    hiddenSpans?: Array<[number, number]>;
    navigation: { domContentLoaded: number; load: number } | null;
    resources: ResourceTiming[];
}

/** Reads (and optionally drains) what the observers recorded. */
export function collectPerf(args: CollectPerfArgs): PerfSnapshot | { error: string } {
    const key = args.key ?? "__gtPerf";
    const state = (window as unknown as Record<string, unknown>)[key] as PerfState | undefined;
    if (!state) {
        return { error: `perf observers are not installed on window.${key}` };
    }

    const control = (window as unknown as Record<string, unknown>)[`${key}Control`] as
        | { checkMarks?: () => void }
        | undefined;
    control?.checkMarks?.();
    const since = args.since ?? Number.NEGATIVE_INFINITY;
    const take = <T>(list: T[], startOf: (item: T) => number): T[] => {
        const picked = list.filter((item) => startOf(item) >= since);
        if (args.drain) {
            const keep = list.filter((item) => startOf(item) < since);
            list.length = 0;
            list.push(...keep);
        }

        return picked;
    };

    // When the page was hidden, so lag from its throttled background timers can be left out.
    const hiddenSpans: Array<[number, number]> = [];
    let hiddenSince: number | null = state.visibility.atInstall === "visible" ? null : state.installedAt;
    for (const [at, visibility] of state.visibility.changes) {
        if (visibility === "visible" && hiddenSince !== null) {
            hiddenSpans.push([hiddenSince, at]);
            hiddenSince = null;
        } else if (visibility !== "visible" && hiddenSince === null) {
            hiddenSince = at;
        }
    }

    if (hiddenSince !== null) {
        hiddenSpans.push([hiddenSince, Math.round(performance.now())]);
    }

    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const wanted = args.resources ?? [];
    const resources =
        wanted.length === 0
            ? []
            : (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
                  .filter((entry) => entry.startTime >= since && wanted.some((part) => entry.name.includes(part)))
                  .map((entry) => ({
                      name: entry.name,
                      initiatorType: entry.initiatorType,
                      start: Math.round(entry.startTime),
                      duration: Math.round(entry.duration),
                      transferSize: entry.transferSize,
                  }));

    return {
        url: location.href,
        now: Math.round(performance.now()),
        installedAt: state.installedAt,
        markBase: state.markBase,
        frames: take(state.frames, (frame) => frame.start),
        longtasks: take(state.longtasks, (task) => task[0]),
        shifts: take(state.shifts, (shift) => shift.start),
        events: take(state.events, (event) => event.start),
        lags: take(state.lags, (lag) => lag[0]),
        marks: { ...state.marks },
        unsupported: state.unsupported,
        visibleThroughout:
            state.visibility.atInstall === "visible" &&
            document.visibilityState === "visible" &&
            state.visibility.changes.every((change) => change[1] === "visible"),
        hiddenSpans,
        navigation: nav
            ? { domContentLoaded: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd) }
            : null,
        resources,
    };
}
