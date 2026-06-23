/**
 * LLM-assisted debugging instrumentation snippet — network mode.
 *
 * Self-contained — zero deps (web/node-18+ fetch + AbortSignal.timeout).
 * Fire-and-forget: every log call posts JSON to the dashboard and never
 * blocks the caller. Targets are probed in parallel on the first call;
 * the first successful host wins and is reused for every subsequent call.
 *
 * Edit HOSTS to point at the dashboard. The `tools debugging-master start`
 * command auto-substitutes `__LAN_IP__` with the detected local IP.
 *
 * Usage:
 *   import { dbg } from './llm-log';
 *   dbg.session('my-feature');
 *   dbg.info('request received', { url: req.url });
 *   dbg.dump('response', data);
 */

// ─── Config ──────────────────────────────────────────────────────────────────
const HOSTS = ["__LAN_IP__", "127.0.0.1", "localhost"];
const PORT = 7243;
const TIMEOUT_MS = 2000;
// ─────────────────────────────────────────────────────────────────────────────

interface LogOpts {
    h?: string;
    /** false = skip stack capture, string = use this stack verbatim. */
    stack?: boolean | string;
}

const timers: Record<string, number> = {};
const config = { captureStackByDefault: true };
let currentSession = "default";

let resolvedBase: string | null = null;
let probing: Promise<string> | null = null;
let reportedUnreachable = false;

async function probeHost(host: string): Promise<string> {
    const base = `http://${host}:${PORT}`;
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
    }
    return base;
}

function getBase(): Promise<string> {
    if (resolvedBase) {
        return Promise.resolve(resolvedBase);
    }
    if (!probing) {
        const candidates = HOSTS.filter((h) => h && !h.startsWith("__"));
        probing = Promise.any(candidates.map(probeHost))
            .then((b) => {
                resolvedBase = b;
                reportedUnreachable = false;
                return b;
            })
            .catch(() => {
                probing = null;
                throw new Error(`no dbg ingest reachable on ${candidates.join(", ")}:${PORT}`);
            });
    }
    return probing;
}

function send(entry: Record<string, unknown>): void {
    const sessionName = currentSession;

    getBase()
        .then((base) =>
            fetch(`${base}/log/${encodeURIComponent(sessionName)}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                // biome-ignore lint/style/noRestrictedGlobals: self-contained file — no external deps
                body: JSON.stringify(entry),
                signal: AbortSignal.timeout(TIMEOUT_MS),
            }).then((r) => {
                if (!r.ok) {
                    throw new Error(`HTTP ${r.status}`);
                }
            })
        )
        .catch((err) => {
            if (!reportedUnreachable) {
                reportedUnreachable = true;
                console.error("[dbg] ingest failed:", (err as Error).message);
            }
        });
}

function captureStack(): string {
    const raw = new Error().stack;
    if (!raw) {
        return "";
    }
    const lines = raw.split("\n");
    const out: string[] = [];
    let seenExternal = false;
    for (let i = 1; i < lines.length; i++) {
        const frame = lines[i];
        if (frame.includes("llm-log")) {
            if (seenExternal) {
                break;
            }
            continue;
        }
        seenExternal = true;
        out.push(frame.trim());
    }
    return out.join("\n");
}

function getCallerLocation(stack: string): { file: string; line: number } {
    const first = stack.split("\n")[0] ?? "";
    const m = first.match(/(?:at\s+.*?\s+\(|at\s+)(.+?):(\d+):\d+\)?/);
    return m ? { file: m[1], line: Number.parseInt(m[2], 10) } : { file: "unknown", line: 0 };
}

function emit(entry: Record<string, unknown>, opts?: LogOpts): void {
    const wantStack = opts?.stack === false ? false : opts?.stack !== undefined || config.captureStackByDefault;
    const stack = typeof opts?.stack === "string" ? opts.stack : wantStack ? captureStack() : "";
    const { file, line } = getCallerLocation(stack);
    const full: Record<string, unknown> = { ts: Date.now(), file, line, ...entry };
    if (opts?.h && full.h === undefined) {
        full.h = opts.h;
    }
    if (stack && wantStack && full.stack === undefined) {
        full.stack = stack;
    }
    send(full);
}

export const dbg = {
    session(name: string): void {
        currentSession = name;
    },

    configure(opts: { captureStackByDefault?: boolean }): void {
        if (opts.captureStackByDefault !== undefined) {
            config.captureStackByDefault = opts.captureStackByDefault;
        }
    },

    dump(label: string, data: unknown, opts?: LogOpts): void {
        emit({ level: "dump", label, data }, opts);
    },

    info(msg: string, data?: unknown, opts?: LogOpts): void {
        emit({ level: "info", msg, ...(data !== undefined && { data }) }, opts);
    },

    warn(msg: string, data?: unknown, opts?: LogOpts): void {
        emit({ level: "warn", msg, ...(data !== undefined && { data }) }, opts);
    },

    error(msg: string, err?: Error | unknown, opts?: LogOpts): void {
        const entry: Record<string, unknown> = { level: "error", msg };
        if (err instanceof Error) {
            entry.stack = err.stack;
            entry.data = { message: err.message, class: err.name, code: (err as { code?: unknown }).code };
        } else if (err !== undefined) {
            entry.data = err;
        }
        emit(entry, opts);
    },

    timerStart(label: string, opts?: LogOpts): void {
        timers[label] = Date.now();
        emit({ level: "timer-start", label }, opts);
    },

    timerEnd(label: string, opts?: LogOpts): void {
        const start = timers[label];
        const entry: Record<string, unknown> = { level: "timer-end", label };
        if (start !== undefined) {
            entry.durationMs = Date.now() - start;
            delete timers[label];
        }
        emit(entry, opts);
    },

    checkpoint(label: string, opts?: LogOpts): void {
        emit({ level: "checkpoint", label }, opts);
    },

    assert(condition: boolean, label: string, ctx?: unknown, opts?: LogOpts): void {
        emit({ level: "assert", label, passed: condition, ...(ctx !== undefined && { ctx }) }, opts);
    },

    snapshot(label: string, vars: Record<string, unknown>, opts?: LogOpts): void {
        emit({ level: "snapshot", label, vars }, opts);
    },

    trace(label: string, data?: unknown, opts?: LogOpts): void {
        emit({ level: "trace", label, ...(data !== undefined && { data }) }, opts);
    },
};
