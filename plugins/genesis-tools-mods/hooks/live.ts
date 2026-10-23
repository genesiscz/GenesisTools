// Times that stay current on screen: `liveAgo(at)` ("12s ago") and `liveLeft(until)` ("4m 05s") are the text to draw,
// and drawing one notes when that text next changes. `startLiveClock` checks once a second and redraws this plugin's
// views only when a drawn time has changed, so nothing redraws while no live time is on screen: a closed sidebar, a
// band whose times count in minutes. A redraw draws the times again, which notes the next change.
import { type Host, shortDuration } from "./shared";

const HOUR = 3_600_000;

/** When the earliest live time drawn since the last tick changes its text. */
let due: number | undefined;
let started = false;

function changesAt(at: number): void {
    due = due === undefined ? at : Math.min(due, at);
}

/** The ms until a `shortDuration` of `ms` that grows reads differently: the next second under an hour, else the next minute. */
function untilNextUp(ms: number): number {
    return ms < HOUR ? 1_000 - (ms % 1_000) : 60_000 - (ms % 60_000);
}

/** How long since `at`: `12s`, `4m 05s`, `1h 02m`; for a run time or an idle time, which take no "ago". */
export function liveSince(at: number, now = Date.now()): string {
    const ms = Math.max(0, now - at);
    changesAt(now + untilNextUp(ms));

    return shortDuration(ms);
}

/** `12s ago`, `4m 05s ago`, `1h 02m ago`; `unit: "minute"` gives `4m ago` and changes once a minute. */
export function liveAgo(at: number, options: { unit?: "second" | "minute"; now?: number } = {}): string {
    const now = options.now ?? Date.now();
    const ms = Math.max(0, now - at);

    if (options.unit === "minute") {
        changesAt(now + 60_000 - (ms % 60_000));
        return ms < 60_000 ? "just now" : `${shortDuration(ms).split(" ")[0]} ago`;
    }

    return `${liveSince(at, now)} ago`;
}

/** What is left until `until`: `4m 05s`; `unit: "minute"` gives whole minutes rounded up, `5m`. */
export function liveLeft(until: number, options: { unit?: "second" | "minute"; now?: number } = {}): string {
    const now = options.now ?? Date.now();
    const ms = Math.max(0, until - now);

    if (options.unit === "minute") {
        changesAt(now + (ms % 60_000 || 60_000));
        return `${Math.ceil(ms / 60_000)}m`;
    }

    changesAt(now + (ms % 1_000 || 1_000));

    return shortDuration(ms);
}

/** Once a second: when a drawn live time has changed, redraw. Started once per loaded module. */
export function startLiveClock(host: Host): void {
    if (started) {
        return;
    }

    started = true;
    host.every(1_000, () => {
        if (due !== undefined && Date.now() >= due) {
            due = undefined;
            host.redraw();
        }
    });
}

/** When the next redraw is due; a test reads it. */
export function liveDue(): number | undefined {
    return due;
}

/** Forgets the due time: a test starts over. */
export function forgetLive(): void {
    due = undefined;
}
