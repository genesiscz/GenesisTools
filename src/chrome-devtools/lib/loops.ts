import type { RecordedEvent } from "./channels.ts";

/**
 * A navigation's identity for loop detection: origin + path + the NAMES of its query parameters. Values
 * change on every lap of an auth loop (`code`, `state`, `nonce`), so keeping them would hide the loop.
 */
export function navigationKey(url: string): string {
    try {
        const parsed = new URL(url);
        const names = [...new Set([...parsed.searchParams.keys()])].sort();
        return `${parsed.origin}${parsed.pathname}${names.length > 0 ? `?${names.join("&")}` : ""}`;
    } catch {
        return url;
    }
}

export interface LoopAlert {
    key: string;
    /** Times the key was seen inside the window. */
    count: number;
    /** From the first of those visits to this one. */
    spanMs: number;
    /** The keys visited between the last two visits of `key`, starting and ending with it. */
    cycle: string[];
    at: number;
}

/**
 * Watches document navigations (main-frame commits and every document redirect hop, iframes included) and
 * reports a key that comes back `threshold` times within `windowMs`: the shape of a redirect or auth loop.
 * It reports again at every further `threshold` visits, so a loop that keeps going stays visible.
 */
export class LoopDetector {
    private readonly visits = new Map<string, number[]>();
    private readonly recent: Array<{ key: string; t: number }> = [];

    constructor(private readonly options: { threshold?: number; windowMs?: number } = {}) {}

    private get threshold(): number {
        return Math.max(2, this.options.threshold ?? 3);
    }

    /** The document URLs an event visits: a redirect hop's source, or a main-frame commit. */
    static urlsOf(event: RecordedEvent): string[] {
        const params = event.params;
        if (event.method === "Page.frameNavigated") {
            const frame = params.frame as { parentId?: string; url?: string } | undefined;
            return frame && !frame.parentId && frame.url ? [frame.url] : [];
        }

        if (event.method === "Network.requestWillBeSent" && params.type === "Document") {
            const redirect = params.redirectResponse as { url?: string } | undefined;
            return redirect?.url ? [redirect.url] : [];
        }

        return [];
    }

    observe(event: RecordedEvent): LoopAlert[] {
        const alerts: LoopAlert[] = [];
        const windowMs = this.options.windowMs ?? 60_000;
        for (const url of LoopDetector.urlsOf(event)) {
            const key = navigationKey(url);
            this.recent.push({ key, t: event.t });
            if (this.recent.length > 200) {
                this.recent.shift();
            }

            const times = (this.visits.get(key) ?? []).filter((time) => event.t - time <= windowMs);
            times.push(event.t);
            this.visits.set(key, times);
            if (times.length < this.threshold || times.length % this.threshold !== 0) {
                continue;
            }

            alerts.push({
                key,
                count: times.length,
                spanMs: event.t - (times[0] as number),
                cycle: this.cycleOf(key),
                at: event.t,
            });
        }

        return alerts;
    }

    private cycleOf(key: string): string[] {
        const last = this.recent.length - 1;
        let previous = last - 1;
        while (previous >= 0 && this.recent[previous]?.key !== key) {
            previous--;
        }

        return previous < 0 ? [key] : this.recent.slice(previous, last + 1).map((visit) => visit.key);
    }
}

/** One printable line for an alert, in the same shape as the other follow lines. */
export function loopLine(alert: LoopAlert, clock: (epochMs: number) => string): string {
    const cycle = alert.cycle.length > 1 ? `; cycle: ${alert.cycle.join(" -> ")}` : "";
    return `${clock(alert.at)} ${"LOOP".padEnd(8)} ${alert.key} seen ${alert.count}x in ${(alert.spanMs / 1000).toFixed(1)} s${cycle}`;
}
