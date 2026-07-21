// Env-gated, near-zero-overhead profiler for isolating hot timers fast.
//
// Enable with the PROFILE env var:
//   PROFILE=1            enable ALL scopes
//   PROFILE=du,engine    enable only the "du" and "engine" scopes (substring match)
//   (unset / 0 / false / off) — disabled; every call is a cheap no-op
//
// Each timer, when enabled, prints ONE line to stderr the moment it stops:
//   [profile:du] walk+scan 5.332s
// so you can grep a single label out of a noisy run. Durations also accumulate
// (count / total / min / max / avg) for a `.summary()` table at the end.
//
// Usage:
//   import { profiler } from "@genesiscz/utils/profile";
//   const p = profiler.scope("du");
//   const end = p.start("walk"); ...; end();                 // manual
//   const r = p.measure("merge", () => mergeExtents());       // sync wrap
//   const r = await p.measureAsync("scan", () => scan());     // async wrap
//   using _ = p.section("cluster");                           // `using` disposable
//   p.summary();                                              // print the table

import { getTrimmed } from "@genesiscz/utils/env/env-core";

function resolveGate(): { on: boolean; scopes: string[] | null } {
    const raw = getTrimmed("PROFILE");
    if (!raw) {
        return { on: false, scopes: null };
    }

    const lower = raw.toLowerCase();
    if (lower === "0" || lower === "false" || lower === "off" || lower === "no") {
        return { on: false, scopes: null };
    }
    if (lower === "1" || lower === "true" || lower === "all" || lower === "on" || lower === "yes") {
        return { on: true, scopes: null };
    }

    return {
        on: true,
        scopes: raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
    };
}

const GATE = resolveGate();

function scopeEnabled(scope: string): boolean {
    if (!GATE.on) {
        return false;
    }
    if (GATE.scopes === null) {
        return true;
    }
    return GATE.scopes.some((s) => scope.includes(s) || s.includes(scope));
}

function fmtMs(ms: number): string {
    if (ms >= 1000) {
        return `${(ms / 1000).toFixed(3)}s`;
    }
    if (ms >= 1) {
        return `${ms.toFixed(2)}ms`;
    }
    return `${ms.toFixed(3)}ms`;
}

interface Stat {
    count: number;
    total: number;
    min: number;
    max: number;
}

export interface ProfilerScope {
    /** True when this scope is active (PROFILE gate matched). */
    readonly enabled: boolean;
    /** Start a timer; call the returned fn to stop it (records + logs the duration). */
    start(label: string): () => number;
    /** Time a synchronous fn, record under `label`, return its value. */
    measure<T>(label: string, fn: () => T): T;
    /** Time an async fn, record under `label`, return its value. */
    measureAsync<T>(label: string, fn: () => Promise<T>): Promise<T>;
    /** Record an instantaneous mark (ms since this scope was created). */
    mark(label: string): void;
    /** `using`-friendly section: stops on dispose or explicit .end(). */
    section(label: string): { end(): number } & Disposable;
    /** Structured accumulated stats, one entry per label. */
    entries(): Array<{ label: string; count: number; total: number; min: number; max: number; avg: number }>;
    /** Print the accumulated table to stderr (no-op when disabled or empty). */
    summary(title?: string): void;
    /** Clear accumulated stats. */
    reset(): void;
}

function write(line: string): void {
    process.stderr.write(`${line}\n`);
}

function makeScope(name: string): ProfilerScope {
    const enabled = scopeEnabled(name);
    const stats = new Map<string, Stat>();
    const t0 = performance.now();

    const record = (label: string, dur: number): void => {
        let s = stats.get(label);
        if (!s) {
            s = { count: 0, total: 0, min: Infinity, max: 0 };
            stats.set(label, s);
        }
        s.count++;
        s.total += dur;
        if (dur < s.min) {
            s.min = dur;
        }
        if (dur > s.max) {
            s.max = dur;
        }
    };

    if (!enabled) {
        // Cheap no-op implementation — keep call sites unconditional.
        const noopEnd = () => 0;
        return {
            enabled: false,
            start: () => noopEnd,
            measure: (_label, fn) => fn(),
            measureAsync: (_label, fn) => fn(),
            mark: () => {},
            section: () => ({ end: noopEnd, [Symbol.dispose]() {} }),
            entries: () => [],
            summary: () => {},
            reset: () => {},
        };
    }

    const start = (label: string): (() => number) => {
        const s = performance.now();
        return () => {
            const dur = performance.now() - s;
            record(label, dur);
            write(`[profile:${name}] ${label} ${fmtMs(dur)}`);
            return dur;
        };
    };

    return {
        enabled: true,
        start,
        measure: (label, fn) => {
            const end = start(label);
            try {
                return fn();
            } finally {
                end();
            }
        },
        measureAsync: async (label, fn) => {
            const end = start(label);
            try {
                return await fn();
            } finally {
                end();
            }
        },
        mark: (label) => {
            write(`[profile:${name}] @${label} ${fmtMs(performance.now() - t0)}`);
        },
        section: (label) => {
            const end = start(label);
            return { end, [Symbol.dispose]: () => void end() };
        },
        entries: () =>
            [...stats.entries()].map(([label, s]) => ({
                label,
                count: s.count,
                total: s.total,
                min: s.min,
                max: s.max,
                avg: s.total / s.count,
            })),
        summary: (title) => {
            if (stats.size === 0) {
                return;
            }
            write(`[profile:${name}] ── ${title ?? "summary"} ──`);
            const rows = [...stats.entries()].sort((a, b) => b[1].total - a[1].total);
            for (const [label, s] of rows) {
                const avg = s.total / s.count;
                write(
                    `[profile:${name}]   ${label.padEnd(24)} n=${String(s.count).padStart(5)}  ` +
                        `total=${fmtMs(s.total).padStart(9)}  avg=${fmtMs(avg).padStart(9)}  max=${fmtMs(s.max).padStart(9)}`
                );
            }
        },
        reset: () => stats.clear(),
    };
}

const scopes = new Map<string, ProfilerScope>();

export interface Profiler extends ProfilerScope {
    /** Get (or create) a named sub-scope; PROFILE=<name> filters by scope. */
    scope(name: string): ProfilerScope;
    /** True if PROFILE is enabled for any scope. */
    readonly active: boolean;
}

/** Global profiler (scope "global") plus a `.scope(name)` factory for tagged timers. */
export const profiler: Profiler = Object.assign(makeScope("global"), {
    scope(name: string): ProfilerScope {
        let s = scopes.get(name);
        if (!s) {
            s = makeScope(name);
            scopes.set(name, s);
        }
        return s;
    },
    get active(): boolean {
        return GATE.on;
    },
});
