// Config-gated profiler with a daily log file. Env vars override the file for one process:
//   PROFILE=1                 enable ALL scopes (config.profiling.enabled is ignored)
//   PROFILE=du,engine         enable only those scopes (substring match)
//   PROFILE=0                 force off even if config enabled
//   PROFILE_TO_STDERR=0|1     echo each line to stderr (default: on when PROFILE is set, off for config-enabled)
//   PROFILE_TO_FILE=/path     write to this path instead of ~/.genesis-tools/logs/<date>-profiling.log
//
// Durable defaults live in ~/.genesis-tools/GenesisTools/config.json under `profiling`.
// When disabled, every call is a cheap no-op.
//
// Usage:
//   import { profiler } from "@genesiscz/utils/profile";
//   const p = profiler.scope("du");
//   const end = p.start("walk"); ...; end();
//   const r = p.measure("merge", () => mergeExtents());
//   const r = await p.measureAsync("scan", () => scan());
//   using _ = p.section("cluster");
//   p.summary();

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatLocalDate } from "@genesiscz/utils/date";
import { env } from "@genesiscz/utils/env";
import { getProfilingConfig, type ProfilingDetail } from "@genesiscz/utils/GenesisTools";
import { assertTestSafePath } from "@genesiscz/utils/storage/real-home-guard";

export interface ProfilerGate {
    on: boolean;
    scopes: string[] | null;
    stderr: boolean;
    file: boolean;
    filePath: string | null;
    minDurationMs: number;
    summaryOnExit: boolean;
    detail: ProfilingDetail;
}

function parseOnOff(raw: string | undefined): boolean | undefined {
    if (!raw) {
        return undefined;
    }

    const lower = raw.toLowerCase();

    if (lower === "0" || lower === "false" || lower === "off" || lower === "no") {
        return false;
    }

    if (lower === "1" || lower === "true" || lower === "all" || lower === "on" || lower === "yes" || lower === "*") {
        return true;
    }

    return undefined;
}

function resolveGate(): ProfilerGate {
    const cfg = getProfilingConfig();
    const profileRaw = env.profiling.getProfile();
    const profileOnOff = parseOnOff(profileRaw);

    let on = cfg.enabled;
    let scopes: string[] | null = cfg.scopes.length > 0 ? cfg.scopes : null;

    if (profileRaw !== undefined) {
        if (profileOnOff === false) {
            on = false;
            scopes = null;
        } else if (profileOnOff === true) {
            on = true;
            scopes = null;
        } else {
            on = true;
            scopes = profileRaw
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
        }
    } else if (on && cfg.scopes.length === 0) {
        scopes = null;
    }

    // PROFILE in the env is a per-run request to see the numbers, so it echoes
    // to stderr unless PROFILE_TO_STDERR says otherwise; config-enabled
    // profiling keeps the configured stderr setting.
    const stderrOverride = parseOnOff(env.profiling.getToStderr());
    const stderr = stderrOverride === undefined ? (profileRaw !== undefined && on) || cfg.stderr : stderrOverride;

    const fileOverride = env.profiling.getToFile();
    let file = cfg.file;
    let filePath = cfg.filePath;

    if (fileOverride !== undefined) {
        file = true;
        filePath = fileOverride;
    }

    return {
        on,
        scopes,
        stderr,
        file,
        filePath,
        minDurationMs: cfg.minDurationMs,
        summaryOnExit: cfg.summaryOnExit,
        detail: cfg.detail,
    };
}

let gate: ProfilerGate | null = null;
let exitHooked = false;
const scopes = new Map<string, ProfilerScope>();

function getGate(): ProfilerGate {
    if (!gate) {
        gate = resolveGate();
        ensureExitHook();
    }

    return gate;
}

function ensureExitHook(): void {
    if (exitHooked) {
        return;
    }

    exitHooked = true;
    process.on("exit", () => {
        const g = getGate();

        if (g.on && g.summaryOnExit) {
            // globalScope() stores "global" in this same map, so an extra
            // profiler.summary() here printed that table a second time.
            for (const s of scopes.values()) {
                s.summary();
            }
        }

        // Last chance for buffered records; a microtask never runs after this.
        flushProfilerFile();
    });
}

/** Re-read env + config. Call after tests mutate either. */
export function reloadProfiler(): void {
    // The gate about to be discarded owns the path the buffer belongs to.
    flushProfilerFile();
    gate = null;
    // A reload can point the sink at a different, writable path, so a previous
    // failure must not disable file output for the rest of the process.
    fileWriteBroken = false;

    // Callers hold module-level references (`const prof = profiler.scope(...)`),
    // and a scope captures `enabled` when it is built. Clearing the map alone
    // left every retained scope on the OLD gate forever while new ones used the
    // new one (PR #343 review t20), so each live object is rebuilt in place.
    for (const [name, existing] of scopes) {
        Object.assign(existing, makeScope(name));
    }
}

/** Snapshot of the resolved gate (config + env). Triggers a resolve if needed. */
export function getProfilerGate(): ProfilerGate {
    return { ...getGate() };
}

function scopeEnabled(scope: string): boolean {
    const g = getGate();

    if (!g.on) {
        return false;
    }

    if (g.scopes === null) {
        return true;
    }

    return g.scopes.some((s) => scope.includes(s) || s.includes(scope));
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

/** Flush the buffer once it holds this many records, so it cannot grow unbounded. */
/** Records buffered before a synchronous flush. Exported so tests cannot drift from it. */
export const FLUSH_AFTER_RECORDS = 256;

/** How long buffered records may wait before a batch flush. */
export const FLUSH_INTERVAL_MS = 250;

function defaultLogPath(): string {
    const day = formatLocalDate(new Date());
    return join(env.tools.getHome(), ".genesis-tools", "logs", `${day}-profiling.log`);
}

/** Set once a file write fails, so a broken sink cannot keep throwing. */
let fileWriteBroken = false;
let pending: string[] = [];
let flushScheduled = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * A profiler must not be the slowest thing in the path it measures.
 * `mkdirSync` + `appendFileSync` per event put blocking disk I/O inside every
 * timed operation, which dominates short high-frequency timers and distorts the
 * very numbers being collected (PR #343 review t3). Records are buffered and
 * flushed in batches; `flushProfilerFile()` drains them at exit.
 */
function flushFile(): void {
    if (pending.length === 0 || fileWriteBroken) {
        pending = [];
        return;
    }

    const text = pending.join("");
    pending = [];
    const g = getGate();
    const path = g.filePath || defaultLogPath();

    try {
        // The profiler writes with raw fs calls, bypassing Storage — so the
        // real-home guard belongs HERE, immediately before the primitive that
        // spends the write (PR #343 review t2 round 11). A test that leaks
        // GENESIS_TOOLS_HOME while profiling is enabled would otherwise land a
        // queued flush in the developer's real ~/.genesis-tools/logs, before the
        // preload's afterEach repair runs. Outside tests this returns instantly.
        assertTestSafePath(path, "write a profiling log to");
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, text);
    } catch (error) {
        fileWriteBroken = true;
        // The profiler already writes to stderr directly; importing the logger
        // here would pull a heavier module into the measured hot path.
        process.stderr.write(`profiler: file output disabled after a write failure at ${path}: ${String(error)}\n`);
    }
}

/** Write out anything still buffered. Safe to call more than once. */
export function flushProfilerFile(): void {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }

    flushScheduled = false;
    flushFile();
}

/**
 * A profiler is a diagnostic: it must never break the command it measures.
 * These calls run from the stop function that `measure`/`measureAsync`/`section`
 * invoke in a `finally`, so a throw here propagated out of the measured call and
 * in `measure` REPLACED the original error (PR #343 review t16).
 */
function appendFile(text: string): void {
    if (fileWriteBroken) {
        return;
    }

    pending.push(text);

    if (pending.length >= FLUSH_AFTER_RECORDS) {
        flushProfilerFile();
        return;
    }

    if (!flushScheduled) {
        flushScheduled = true;
        // A TIMER, not a microtask (PR #343 review t2 round 12). Async code
        // yields to the microtask queue between timed operations, so
        // `queueMicrotask` drained after almost every single record — which is
        // an appendFileSync per event, exactly the synchronous-per-event
        // overhead the buffer was introduced to remove. A short interval batches
        // across turns; the size threshold above still bounds memory, and the
        // exit hook plus `flushProfilerFile()` still drain deterministically.
        // `unref` so a pending flush can never hold the process open.
        flushTimer = setTimeout(flushProfilerFile, FLUSH_INTERVAL_MS);
        flushTimer.unref?.();
    }
}

function write(line: string, durMs?: number): void {
    const g = getGate();

    if (!g.on) {
        return;
    }

    if (durMs !== undefined && durMs < g.minDurationMs) {
        return;
    }

    const text = `${line}\n`;

    if (g.stderr) {
        process.stderr.write(text);
    }

    if (g.file) {
        appendFile(text);
    }
}

interface Stat {
    count: number;
    total: number;
    min: number;
    max: number;
}

export interface ProfilerScope {
    /** True when this scope is active (PROFILE / config gate matched). */
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
    /** Print the accumulated table (no-op when disabled or empty). */
    summary(title?: string): void;
    /** Clear accumulated stats. */
    reset(): void;
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
            write(`[profile:${name}] ${label} ${fmtMs(dur)}`, dur);
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
            let done = false;
            const stop = (): number => {
                if (done) {
                    return 0;
                }

                done = true;
                return end();
            };
            return { end: stop, [Symbol.dispose]: () => void stop() };
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

export interface Profiler extends ProfilerScope {
    /** Get (or create) a named sub-scope; PROFILE / config.scopes filters by name. */
    scope(name: string): ProfilerScope;
    /** True if profiling is enabled for any scope. */
    readonly active: boolean;
    /** Phase-only vs per-file/per-op. Call sites that have both honour this. */
    readonly detail: ProfilingDetail;
}

function globalScope(): ProfilerScope {
    let s = scopes.get("global");

    if (!s) {
        s = makeScope("global");
        scopes.set("global", s);
    }

    return s;
}

/** Global profiler (scope "global") plus a `.scope(name)` factory for tagged timers. */
export const profiler: Profiler = {
    get enabled() {
        return getGate().on;
    },
    get active() {
        return getGate().on;
    },
    get detail() {
        return getGate().detail;
    },
    start: (label) => globalScope().start(label),
    measure: (label, fn) => globalScope().measure(label, fn),
    measureAsync: (label, fn) => globalScope().measureAsync(label, fn),
    mark: (label) => globalScope().mark(label),
    section: (label) => globalScope().section(label),
    entries: () => globalScope().entries(),
    summary: (title) => globalScope().summary(title),
    reset: () => globalScope().reset(),
    scope(name: string): ProfilerScope {
        let s = scopes.get(name);

        if (!s) {
            s = makeScope(name);
            scopes.set(name, s);
        }

        return s;
    },
};
