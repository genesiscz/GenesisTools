import type { SessionCapture } from "./session";
import type { CaptureResult } from "./types";

/** One stretch of time during which a capture recorded one display; `to` is unset while it records. */
export interface DisplayInterval {
    displayId: number;
    from: string;
    to?: string;
}

/**
 * Which displays a recording records and when, shared by every recorder kind: the displays of the running captures
 * (by the name the recorder gave them last) and one interval per capture and display. An interval opens when its
 * capture starts or a frame of another display arrives, and closes when the capture is told to stop; when the
 * capture's result comes, each interval's start moves back onto the capture's own clock.
 */
export class DisplayBook {
    /** Every display seen so far, by id. */
    readonly names: Map<number, string>;
    /** Every interval, in the order they opened (a recording's earlier ones first). */
    readonly intervals: DisplayInterval[];
    /** The displays of the running captures; undefined until the first capture starts. */
    recorded?: Array<{ id: number; name: string }>;
    private lastIds = "";
    /** The interval each running capture records now. */
    private readonly current = new WeakMap<SessionCapture, DisplayInterval>();
    /** Every interval a capture opened, in order, so its result can move their starts onto its own clock. */
    private readonly perCapture = new WeakMap<SessionCapture, DisplayInterval[]>();

    constructor(history: { intervals?: readonly DisplayInterval[]; names?: Iterable<[number, string]> } = {}) {
        this.intervals = [...(history.intervals ?? [])];
        this.names = new Map(history.names ?? []);
    }

    /** Keeps the names of the connected displays. */
    see(displays: ReadonlyArray<{ id: number; name: string }>): void {
        for (const display of displays) {
            this.names.set(display.id, display.name);
        }
    }

    /**
     * The recorded displays follow the running captures, each by the display it records now (its frames can move to
     * another display without a switch call, as a follow-focus capture does); true when they changed.
     */
    sync(running: ReadonlyMap<number, SessionCapture>): boolean {
        const displayOf = (one: SessionCapture) => this.current.get(one)?.displayId ?? one.target.displayId;
        const ids = [...running.values()]
            .map(displayOf)
            .sort((a, b) => a - b)
            .join(",");

        if (ids === this.lastIds || running.size === 0) {
            return false;
        }

        this.lastIds = ids;
        this.recorded = [...running.values()].map((one) => ({
            id: displayOf(one),
            name: this.names.get(displayOf(one)) ?? one.target.label,
        }));
        return true;
    }

    /** The capture records `displayId` from now; the interval it recorded before ends. True when one opened. */
    open(capture: SessionCapture, displayId: number): boolean {
        const previous = this.current.get(capture);

        if (previous?.displayId === displayId && !previous.to) {
            return false;
        }

        if (previous && !previous.to) {
            previous.to = new Date().toISOString();
        }

        const interval: DisplayInterval = { displayId, from: new Date().toISOString() };
        this.intervals.push(interval);
        this.current.set(capture, interval);
        this.perCapture.set(capture, [...(this.perCapture.get(capture) ?? []), interval]);
        return true;
    }

    /** The capture was told to stop: its interval ends now, not when its post-processing ends. */
    close(capture: SessionCapture): void {
        const interval = this.current.get(capture);

        if (interval && !interval.to) {
            interval.to = new Date().toISOString();
        }
    }

    // A hook can arrive after the frame it reports: the capture's own clock moves each interval's start back to the
    // first frame of its display, before the frames become queryable.
    align(capture: SessionCapture, result: CaptureResult): void {
        const intervals = this.perCapture.get(capture) ?? [];
        let cursor = 0;
        let previousId: number | undefined;

        for (const frame of [...result.frames].sort((a, b) => a.atMs - b.atMs)) {
            const id = frame.displayId ?? capture.target.displayId;

            if (id === previousId) {
                continue;
            }

            previousId = id;
            const index = intervals.findIndex((span, position) => position >= cursor && span.displayId === id);

            if (index < 0) {
                continue;
            }

            const interval = intervals[index]!;
            const first = Math.min(Date.parse(interval.from), result.startedAtMs + frame.atMs);
            interval.from = new Date(first).toISOString();
            const previous = intervals[index - 1];

            if (previous?.to && Date.parse(previous.to) > first) {
                previous.to = interval.from;
            }

            cursor = index + 1;
        }
    }
}
