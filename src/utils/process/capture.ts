/**
 * Run a binary with an argv and capture both streams. No shell, so a process name carrying a quote or a `$` cannot
 * become shell syntax. Tools that only need to run a program (`git`, `launchctl`, `tmux`, `cloudflared`) import this
 * module; questions about processes go to `processes.ts`, whose `ps` fallback (`ps.ts`) runs on top of this.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("process-capture");

export interface CaptureResult {
    stdout: string;
    stderr: string;
    /** Exit code, or null when the child was killed or never reported one. */
    status: number | null;
    /** Set by {@link capture} when it killed the child at its deadline; that kill is already logged there. */
    timedOut?: true;
}

/** Where macOS keeps `lsof`, `sysctl` and friends: absent from a launchd job's PATH unless its plist adds them. */
const SYSTEM_BIN_DIRS = ["/usr/sbin", "/sbin"];

/**
 * A bare command name the PATH cannot resolve, found in the system bin folders instead. The daemon
 * runs tasks with a PATH without `/usr/sbin`, so a bare `lsof` failed there and read as "no output".
 */
export function resolveSystemCommand(command: string): string {
    if (command.includes("/") || Bun.which(command)) {
        return command;
    }

    for (const dir of SYSTEM_BIN_DIRS) {
        const candidate = join(dir, command);

        if (existsSync(candidate)) {
            return candidate;
        }
    }

    return command;
}

/** Run a binary with an argv and capture both streams. No shell, so no quoting hazard. */
export function captureSync(command: string, args: string[], options?: { timeoutMs?: number }): CaptureResult {
    const result = spawnSync(resolveSystemCommand(command), args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: options?.timeoutMs,
    });

    return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        status: result.status,
    };
}

/**
 * Async {@link captureSync}. Use this one from anything with a render loop: a
 * synchronous `ps -axo` over a thousand processes blocks the event loop for as
 * long as it takes, and an Ink app cannot paint or read a keypress meanwhile.
 *
 * `timeoutMs` kills the child rather than waiting forever, because `lsof` can
 * block indefinitely on an unresponsive mount.
 */
export async function capture(
    command: string,
    args: string[],
    options?: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv }
): Promise<CaptureResult> {
    const proc = Bun.spawn([resolveSystemCommand(command), ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        cwd: options?.cwd,
        env: options?.env,
    });
    const timeoutMs = options?.timeoutMs;
    const streams = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    void streams.catch(() => {});

    if (timeoutMs === undefined) {
        const [stdout, stderr] = await streams;
        await proc.exited;

        return { stdout, stderr, status: proc.exitCode };
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await new Promise<boolean>((resolve) => {
        timeoutId = setTimeout(() => resolve(true), timeoutMs);
        void proc.exited.then(() => resolve(false));
    });

    if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
    }

    if (timedOut) {
        proc.kill("SIGKILL");
        log.warn({ command, args, timeoutMs }, "child was killed on timeout; its output is partial");

        return { stdout: "", stderr: "", status: null, timedOut: true };
    }

    const [stdout, stderr] = await streams;

    return { stdout, stderr, status: proc.exitCode };
}
