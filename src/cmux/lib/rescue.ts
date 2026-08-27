import type { Profile } from "@app/cmux/lib/types";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";

/**
 * Rescue workflow primitives, kept out of the command layer so the irreversible
 * ones can be spied on. `killApp` reaches process.kill with SIGTERM and then
 * SIGKILL, which is exactly the shape the repo's side-effects rule says must be
 * testable independently of a Commander action.
 */

export interface RescueSystem {
    kill(pid: number, signal: NodeJS.Signals | 0): void;
    sleep(ms: number): Promise<void>;
}

export const defaultRescueSystem: RescueSystem = {
    // The caller passes probeCmuxHealth().appPid, which findCmuxApp() obtained by
    // matching the process's own `comm` against cmux.app/Contents/MacOS/cmux.
    // pid-verified: identity established by a live command match, not a file read.
    kill: (pid, signal) => process.kill(pid, signal),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function isAlive(pid: number, sys: RescueSystem = defaultRescueSystem): boolean {
    try {
        sys.kill(pid, 0);
        return true;
    } catch (err) {
        // ESRCH is the answer we asked for; anything else (EPERM) still means
        // "not ours to signal", but is worth a trace rather than silence.
        logger.debug({ err, pid }, "[rescue] liveness probe says gone");
        return false;
    }
}

export interface KillOutcome {
    /** Signals actually delivered, in order. Empty when the process was already gone. */
    signals: NodeJS.Signals[];
    exited: boolean;
}

/**
 * SIGTERM, wait up to 5 s, then SIGKILL. Returns what was actually sent so the
 * caller can report it and a test can assert the escalation without a real pid.
 */
export async function killApp(
    pid: number,
    opts: { sys?: RescueSystem; graceMs?: number; onStep?: (message: string) => void } = {}
): Promise<KillOutcome> {
    const sys = opts.sys ?? defaultRescueSystem;
    const graceMs = opts.graceMs ?? 5000;
    const step = opts.onStep ?? (() => {});
    const signals: NodeJS.Signals[] = [];

    step(`Sending SIGTERM to cmux (pid ${pid})…`);

    try {
        sys.kill(pid, "SIGTERM");
        signals.push("SIGTERM");
    } catch (error) {
        logger.warn({ error, pid }, "[rescue] SIGTERM failed");
    }

    const slices = Math.max(1, Math.round(graceMs / 500));

    for (let i = 0; i < slices; i += 1) {
        await sys.sleep(500);

        if (!isAlive(pid, sys)) {
            step("cmux terminated on SIGTERM.");
            return { signals, exited: true };
        }
    }

    step(`Still alive after ${graceMs / 1000} s — sending SIGKILL.`);

    try {
        sys.kill(pid, "SIGKILL");
        signals.push("SIGKILL");
    } catch (error) {
        logger.warn({ error, pid }, "[rescue] SIGKILL failed");
    }

    await sys.sleep(1000);

    return { signals, exited: !isAlive(pid, sys) };
}

/**
 * `open` forwards its ENTIRE environment to the launched app, and every pane's
 * login shell inherits it. Launched from an agent session that would propagate
 * CLAUDECODE/CLAUDE_CODE_* markers and silently disable transcript saving in
 * every resumed claude — so the relaunch runs with a minimal clean environment.
 */
export function cleanRelaunchEnv(): Record<string, string> {
    const user = env.device.getUser() ?? "";

    return {
        HOME: env.paths.getHome(),
        USER: user,
        LOGNAME: env.device.getLogname() ?? user,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    };
}

export interface ReplayEntry {
    workspaceIndex: number;
    workspaceTitle: string;
    paneRef: string;
    tabIndex: number;
    title: string;
    command?: string;
}

export function collectReplayEntries(profile: Profile): ReplayEntry[] {
    const entries: ReplayEntry[] = [];
    let workspaceIndex = 0;

    for (const window of profile.windows) {
        for (const ws of window.workspaces) {
            for (const pane of ws.panes) {
                pane.surfaces.forEach((surface, tabIndex) => {
                    entries.push({
                        workspaceIndex,
                        workspaceTitle: ws.title,
                        paneRef: pane.ref,
                        tabIndex,
                        title: surface.title,
                        command: surface.type === "terminal" ? surface.command : undefined,
                    });
                });
            }

            workspaceIndex += 1;
        }
    }

    return entries;
}

/**
 * A saved surface may only be typed into when the reopened one is the same
 * surface. Titles derive from the running command, so a mismatch means the
 * layout moved and positional replay would type into a different terminal.
 */
export function mayReplayIntoSurface(saved: { title?: string }, live: { title?: string }): boolean {
    return !live.title || !saved.title || live.title === saved.title;
}
