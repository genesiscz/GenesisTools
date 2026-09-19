import { randomUUID } from "node:crypto";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { Stopwatch } from "@genesiscz/utils/Stopwatch";
import { type Observation, observationSchema } from "../decision/observation";
import { type Frame, frameArea, stableId, toObservedRows } from "./elements";
import { describeAll, describePoint, type IdbElement } from "./idb";

const { log } = logger.scoped("control-simulator");
const prof = profiler.scope("control-simulator");

/** Measured on an iPhone 17 Pro / iOS 26.5: 220 points at 48 in flight read the screen in ~4 s. */
export const DEFAULT_PROBE_STEP = 40;
export const DEFAULT_PROBE_CONCURRENCY = 48;
export const DEFAULT_MAX_PROBE_POINTS = 400;

export const DEFAULT_SCREEN: Frame = { x: 0, y: 0, width: 402, height: 874 };

export interface ProbeReport {
    /** Points idb was actually asked about. */
    points: number;
    /** Points the grid would have covered had nothing stopped it. */
    planned: number;
    elapsedMs: number;
    /** True when the point budget or the deadline cut the sweep short. */
    truncated: boolean;
}

export function probePoints(screen: Frame, step: number): Array<[number, number]> {
    const points: Array<[number, number]> = [];
    for (let y = screen.y + step / 2; y < screen.y + screen.height; y += step) {
        for (let x = screen.x + step / 2; x < screen.x + screen.width; x += step) {
            points.push([x, y]);
        }
    }
    return points;
}

/**
 * Keep a sweep inside its point budget by THINNING the grid, never by cutting its tail.
 *
 * The points are generated row by row from the top, so a prefix is the top of the screen and
 * nothing below it. That made a finer `--probe-step` find FEWER elements than a coarse one:
 * measured on iOS Settings, step 40 plans ~220 points and sweeps the whole screen, while step 20
 * plans ~880, was cut to the first 400, and saw only the top 45%. The knob that reads as "look
 * harder" was making the bottom half of every screen invisible.
 *
 * Taking every nth point instead degrades density uniformly, so a budgeted sweep still covers the
 * whole screen and can only be coarser than asked, never partial.
 */
export function withinBudget<T>(points: T[], maxPoints: number): T[] {
    if (points.length <= maxPoints) {
        return points;
    }

    const stride = Math.ceil(points.length / maxPoints);
    const kept: T[] = [];
    for (let index = 0; index < points.length; index += stride) {
        kept.push(points[index]);
    }

    return kept;
}

/**
 * `describe-all` reports only the elements an app publishes at the top of its accessibility
 * hierarchy, so a container that aggregates its children hides them completely. `describe-point`
 * hit-tests, and reveals the leaves behind such a container. Sweeping a bounded grid of points is
 * therefore the only way to enumerate an iOS screen. Measured against iOS Calendar: `describe-all`
 * returned 4 elements and found no Add button; a 40-point grid returned 32, including
 * `add-plus-button`. See `docs/benchmarks-simulator.md`.
 */
export async function probeScreen(options: {
    udid: string;
    screen: Frame;
    step?: number;
    concurrency?: number;
    maxPoints?: number;
    signal?: AbortSignal;
    deadlineMs?: number;
    describe?: typeof describePoint;
}): Promise<{ elements: IdbElement[]; report: ProbeReport }> {
    const clock = new Stopwatch();
    const step = Math.max(4, Math.floor(options.step ?? DEFAULT_PROBE_STEP));
    const concurrency = Math.min(64, Math.max(1, Math.floor(options.concurrency ?? DEFAULT_PROBE_CONCURRENCY)));
    const maxPoints = Math.max(1, Math.floor(options.maxPoints ?? DEFAULT_MAX_PROBE_POINTS));
    const deadlineMs = Math.max(1, Math.floor(options.deadlineMs ?? 30_000));
    const describe = options.describe ?? describePoint;

    const planned = probePoints(options.screen, step);
    const budgeted = withinBudget(planned, maxPoints);
    const elements: IdbElement[] = [];
    let next = 0;
    let attempted = 0;
    // Thinned, not cut: the sweep still covers the whole screen, at a coarser density than asked.
    let stopped = budgeted.length < planned.length;
    if (stopped) {
        log.warn(
            { step, planned: planned.length, sweeping: budgeted.length, maxPoints },
            "probe budget reached; the grid was thinned, so discovery is coarser than --probe-step asked for"
        );
    }

    const worker = async () => {
        for (;;) {
            if (options.signal?.aborted || clock.elapsedMs >= deadlineMs) {
                stopped = stopped || next < budgeted.length;
                return;
            }
            const index = next++;
            if (index >= budgeted.length) {
                return;
            }
            attempted++;
            const [x, y] = budgeted[index];
            const element = await describe({
                udid: options.udid,
                x,
                y,
                signal: options.signal,
                timeoutMs: Math.max(1, deadlineMs - Math.floor(clock.elapsedMs)),
            });
            if (element && frameArea(element.frame) > 0) {
                elements.push(element);
            }
        }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    const report: ProbeReport = {
        points: attempted,
        planned: planned.length,
        elapsedMs: Math.round(clock.elapsedMs),
        truncated: stopped,
    };
    log.debug({ udid: options.udid, ...report, found: elements.length }, "simulator probe sweep");
    return { elements, report };
}

export interface SimulatorObservation extends Observation {
    udid: string;
    screen: Frame;
    probe: ProbeReport | null;
}

export interface ObserveOptions {
    udid: string;
    deviceName: string;
    /** Real pid of the app under test when the caller launched it; identity for `sameScope`. */
    pid?: number;
    probe?: boolean;
    probeStep?: number;
    probeConcurrency?: number;
    maxProbePoints?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
    describeAllFn?: typeof describeAll;
    describePointFn?: typeof describePoint;
}

/**
 * The screen is the application root's frame, NOT the largest element observed. A scroll view
 * reports its whole scrollable content (measured: 338x1237 inside an 402x874 screen), and taking
 * that as the screen both aimed the probe grid off the right-hand edge — losing `add-plus-button`
 * entirely — and pushed most of its points below the visible area.
 */
export function screenFrom(elements: IdbElement[]): Frame {
    const application = elements.find((element) => (element.role ?? element.type) === "AXApplication");
    const frame = application?.frame;
    if (frame && frame.width > 0 && frame.height > 0) {
        return { x: 0, y: 0, width: frame.width, height: frame.height };
    }
    return DEFAULT_SCREEN;
}

function foregroundLabel(elements: IdbElement[]): string {
    const application = elements.find((element) => (element.role ?? element.type) === "AXApplication");
    const label = application?.AXLabel?.trim();
    return label && label.length > 0 ? label : "SpringBoard";
}

/**
 * One complete read of the simulator screen as addressable, labelled elements. Produces a real
 * `Observation`, so the shared candidate rules, admission gate, freshness check and readback all
 * apply to the simulator exactly as they do to a macOS window.
 */
export async function observeSimulator(options: ObserveOptions): Promise<SimulatorObservation> {
    options.signal?.throwIfAborted();
    const clock = new Stopwatch();
    const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 60_000));
    const stop = prof.start("observe");
    const top = await (options.describeAllFn ?? describeAll)({
        udid: options.udid,
        signal: options.signal,
        timeoutMs: Math.min(20_000, timeoutMs),
    });
    const screen = screenFrom(top);
    const app = foregroundLabel(top);

    let probeReport: ProbeReport | null = null;
    let elements = top;
    if (options.probe !== false) {
        const swept = await probeScreen({
            udid: options.udid,
            screen,
            step: options.probeStep,
            concurrency: options.probeConcurrency,
            maxPoints: options.maxProbePoints,
            signal: options.signal,
            deadlineMs: Math.max(1, timeoutMs - Math.floor(clock.elapsedMs)),
            describe: options.describePointFn,
        });
        probeReport = swept.report;
        elements = [...top, ...swept.elements];
    }

    const rows = toObservedRows(elements, screen, app);
    const observedMs = stop();
    const candidate = {
        ok: true as const,
        app,
        // The pid is the app-identity signal `sameScope` compares. With a bundle id the caller
        // gets the real pid, so a relaunch stops the task; without one there is nothing to
        // compare and only the device identity is pinned.
        pid: options.pid ?? stableId(`simulator:${options.udid}`),
        snapshot: randomUUID(),
        // The device screen IS the window. It must NOT be keyed on the foreground app label:
        // dismissing a system alert changes that label, and keying on it made a plain permission
        // dialog look like an app switch and abort the task.
        window: { id: stableId(`simulator-screen:${options.udid}`), title: `${options.deviceName} — ${app}` },
        scope: "window" as const,
        elements: rows,
    };
    const parsed = observationSchema.safeParse(candidate);
    if (!parsed.success) {
        throw new Error(`Simulator observation did not parse: ${parsed.error.issues[0]?.message}`);
    }
    log.info(
        {
            udid: options.udid,
            app,
            elements: rows.length,
            probe: probeReport,
            ms: Math.round(observedMs),
        },
        "simulator observed"
    );
    return { ...parsed.data, udid: options.udid, screen, probe: probeReport };
}
