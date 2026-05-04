/**
 * LLM-assisted debugging instrumentation snippet.
 *
 * This file is **self-contained** — copy it into any TypeScript/JS project.
 * It has zero external dependencies (only node: builtins).
 *
 * Usage:
 *   import { dbg } from './llm-log';
 *   dbg.session('my-feature');
 *   dbg.info('request received', { url: req.url });
 *   dbg.dump('response', data);
 *   dbg.timerStart('db-query');
 *   // ... do work ...
 *   dbg.timerEnd('db-query');
 *   dbg.snapshot('state', { user, cart, flags });
 *
 * Every entry captures the full call stack by default (callers up the chain).
 * To opt out per-call:           dbg.info('msg', undefined, { stack: false });
 * To opt out globally (one-time): dbg.configure({ captureStackByDefault: false });
 *
 * Every method accepts a final `opts` argument with `{ h?, stack? }`:
 *   - `h`     — hypothesis tag to filter by in the dashboard
 *   - `stack` — false to skip stack capture for this call; string to override
 *
 * Logs are written as JSONL to:
 *   ~/.genesis-tools/debugging-master/sessions/<session>.jsonl
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface LogOpts {
    h?: string;
    /** false = skip stack capture, string = use this stack verbatim. Default: capture full stack. */
    stack?: boolean | string;
}

const SESSIONS_DIR = join(homedir(), ".genesis-tools", "debugging-master", "sessions");
const timers: Record<string, number> = {};
let currentSession = "default";
let sessionPath = join(SESSIONS_DIR, `${currentSession}.jsonl`);
let dirEnsured = false;

const config = {
    captureStackByDefault: true,
};

function ensureDir(): void {
    if (dirEnsured) {
        return;
    }
    if (!existsSync(SESSIONS_DIR)) {
        mkdirSync(SESSIONS_DIR, { recursive: true });
    }
    dirEnsured = true;
}

/** Capture a full call stack, stripped of llm-log internal frames. */
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
            // skip llm-log internals (write, captureStack, getCaller, dbg.* method bodies)
            if (seenExternal) {
                // edge case: re-entry through llm-log — treat as boundary
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
    if (!stack) {
        return { file: "unknown", line: 0 };
    }
    const firstFrame = stack.split("\n")[0];
    const match = firstFrame?.match(/(?:at\s+.*?\s+\(|at\s+)(.+?):(\d+):\d+\)?/);
    if (match) {
        return { file: match[1], line: parseInt(match[2], 10) };
    }
    return { file: "unknown", line: 0 };
}

function shouldIncludeStack(opts?: LogOpts): boolean {
    if (opts?.stack === false) {
        return false;
    }
    if (opts?.stack === true) {
        return true;
    }
    if (typeof opts?.stack === "string") {
        // explicit override — always include
        return true;
    }
    return config.captureStackByDefault;
}

function write(entry: Record<string, unknown>, opts?: LogOpts): void {
    ensureDir();
    const stack = typeof opts?.stack === "string" ? opts.stack : captureStack();
    const { file, line } = getCallerLocation(stack);
    const full: Record<string, unknown> = { ...entry, ts: entry.ts ?? Date.now(), file, line };
    if (opts?.h && full.h === undefined) {
        full.h = opts.h;
    }
    if (shouldIncludeStack(opts) && stack && full.stack === undefined) {
        full.stack = stack;
    }
    // biome-ignore lint/style/noRestrictedGlobals: self-contained file — no external deps
    appendFileSync(sessionPath, `${JSON.stringify(full)}\n`);
}

export const dbg = {
    session(name: string): void {
        currentSession = name;
        sessionPath = join(SESSIONS_DIR, `${currentSession}.jsonl`);
        dirEnsured = false;
    },

    /** Adjust global behavior (e.g. disable default stack capture). */
    configure(opts: { captureStackByDefault?: boolean }): void {
        if (opts.captureStackByDefault !== undefined) {
            config.captureStackByDefault = opts.captureStackByDefault;
        }
    },

    dump(label: string, data: unknown, opts?: LogOpts): void {
        write({ level: "dump", label, data }, opts);
    },

    info(msg: string, data?: unknown, opts?: LogOpts): void {
        write({ level: "info", msg, ...(data !== undefined && { data }) }, opts);
    },

    warn(msg: string, data?: unknown, opts?: LogOpts): void {
        write({ level: "warn", msg, ...(data !== undefined && { data }) }, opts);
    },

    error(msg: string, err?: Error | unknown, opts?: LogOpts): void {
        const entry: Record<string, unknown> = { level: "error", msg };
        if (err instanceof Error) {
            // explicit Error stack wins over auto-captured caller stack
            entry.stack = err.stack;
            entry.data = { message: err.message, class: err.name, code: (err as { code?: unknown }).code };
        } else if (err !== undefined) {
            entry.data = err;
        }
        write(entry, opts);
    },

    timerStart(label: string, opts?: LogOpts): void {
        timers[label] = Date.now();
        write({ level: "timer-start", label }, opts);
    },

    timerEnd(label: string, opts?: LogOpts): void {
        const start = timers[label];
        const entry: Record<string, unknown> = { level: "timer-end", label };
        if (start !== undefined) {
            entry.durationMs = Date.now() - start;
            delete timers[label];
        }
        write(entry, opts);
    },

    checkpoint(label: string, opts?: LogOpts): void {
        write({ level: "checkpoint", label }, opts);
    },

    assert(condition: boolean, label: string, ctx?: unknown, opts?: LogOpts): void {
        write({ level: "assert", label, passed: condition, ...(ctx !== undefined && { ctx }) }, opts);
    },

    snapshot(label: string, vars: Record<string, unknown>, opts?: LogOpts): void {
        write({ level: "snapshot", label, vars }, opts);
    },

    trace(label: string, data?: unknown, opts?: LogOpts): void {
        write({ level: "trace", label, ...(data !== undefined && { data }) }, opts);
    },
};
