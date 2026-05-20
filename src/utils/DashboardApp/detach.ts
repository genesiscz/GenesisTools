/**
 * Background-detach a child process.
 *
 * Ported from src/dev-dashboard/index.ts:255-310 (the `restart` verb).
 * Key invariants:
 *  - `detached: true` so the child gets its own session group; SIGHUP to the
 *    parent shell does NOT cascade.
 *  - `stdio: ["ignore", fdLog, fdLog]` redirects child output to a file fd we
 *    open ahead of time and close in the parent after spawn — the kernel keeps
 *    the dup'd fd alive for the child.
 *  - `child.unref()` so the parent's event loop is free to exit immediately.
 *
 * This module does NOT register the PID file — that's lifecycle.ts's job, so
 * detach can be reused for tests that don't want the side effects.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";

export interface DetachOptions {
    cmd: readonly string[];
    cwd?: string;
    env?: Record<string, string | undefined>;
    logFile: string;
}

export interface DetachResult {
    pid: number;
}

export function spawnDetached(opts: DetachOptions): DetachResult {
    const logFd = openSync(opts.logFile, "a");
    const child = spawn(opts.cmd[0], opts.cmd.slice(1), {
        cwd: opts.cwd,
        env: { ...process.env, ...filterUndefined(opts.env) },
        detached: true,
        stdio: ["ignore", logFd, logFd],
    });
    closeSync(logFd); // child holds its own dup'd fd now
    child.unref();

    if (!child.pid) {
        throw new Error("Failed to spawn detached process — no PID returned");
    }

    return { pid: child.pid };
}

function filterUndefined(env: Record<string, string | undefined> | undefined): Record<string, string> {
    if (!env) {
        return {};
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
        if (v !== undefined) {
            out[k] = v;
        }
    }
    return out;
}
