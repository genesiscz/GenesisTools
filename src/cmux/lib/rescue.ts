import type { Profile } from "@app/cmux/lib/types";
import { APP_BINARY_SUFFIX } from "@genesiscz/utils/cmux/lib/health";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { classifyPid, processStartMs, START_MS_TOLERANCE } from "@genesiscz/utils/process-identity";

/**
 * Rescue workflow primitives, kept out of the command layer so the irreversible
 * ones can be spied on. `killApp` reaches process.kill with SIGTERM and then
 * SIGKILL, which is exactly the shape the repo's side-effects rule says must be
 * testable independently of a Commander action.
 */

export interface RescueSystem {
    kill(pid: number, signal: NodeJS.Signals | 0): void;
    sleep(ms: number): Promise<void>;
    /**
     * Does `pid` still name the cmux app? Re-asked immediately before every
     * signal, because the pid arrives from a health probe that ran before the
     * offline capture and the confirmation prompt, and the SIGKILL escalation
     * fires a further 5 s after SIGTERM. Both are unbounded windows in which
     * cmux can exit and the kernel can reissue the number to something else.
     */
    isCmux(pid: number): boolean;
    /**
     * When the process at `pid` started, in epoch ms, or null when the OS will
     * not say. `isCmux` alone cannot separate the livelocked cmux from a SECOND
     * cmux launched into the same reissued number: both match the binary
     * suffix. The start time is the signal that does.
     */
    startMs(pid: number): number | null;
}

export const defaultRescueSystem: RescueSystem = {
    // The marker has to sit on the line immediately above the signal, so keep the
    // explanation short: killApp asks isCmux() right before each signal, and a pid
    // that no longer matches the cmux binary is never signalled at all.
    // pid-verified: isCmux() re-matched this pid's live `ps` command line first.
    kill: (pid, signal) => process.kill(pid, signal),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    isCmux: (pid) => {
        // "unverified" means the OS would not tell us the command line, not that
        // the pid is wrong; refusing there would break the rescue on the machines
        // that need it. Only a positive mismatch ("foreign") vetoes the signal.
        const identity = classifyPid(pid, (command) => command.endsWith(APP_BINARY_SUFFIX));

        if (identity.status === "foreign") {
            logger.warn({ pid, command: identity.command }, "[rescue] pid was recycled onto another process");
        }

        return identity.status === "live" || identity.status === "unverified";
    },
    startMs: (pid) => processStartMs(pid),
};

export function isAlive(pid: number, sys: RescueSystem = defaultRescueSystem): boolean {
    try {
        sys.kill(pid, 0);
        return true;
    } catch (err) {
        const code = (err as { code?: string }).code;

        // ESRCH is the ONLY answer that means gone. EPERM means the process
        // exists but is not ours to signal, and an unexpected probe failure says
        // nothing about liveness. Reporting either as dead would make killApp
        // claim `exited: true` while cmux is still up, and rescue would then
        // relaunch and replay into the live app.
        if (code === "ESRCH") {
            return false;
        }

        logger.debug({ err, pid, code }, "[rescue] liveness probe could not signal; treating the pid as alive");

        return true;
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

    // Baseline taken once, before the first signal. A pid reissued to a SECOND
    // cmux — the user relaunching the app while the confirmation prompt is up —
    // matches the binary suffix just as well as the livelocked one, so the
    // command line cannot tell them apart. The start time can.
    const baselineStartMs = sys.startMs(pid);

    /** Is this still the same process the health probe found? */
    const isSameApp = (): boolean => {
        if (!sys.isCmux(pid)) {
            return false;
        }

        // Nothing readable at baseline means this machine never offers the
        // signal (ps refused, or a platform without it), so the command match
        // stands alone exactly as it did before.
        if (baselineStartMs === null) {
            return true;
        }

        const current = sys.startMs(pid);

        // Readable then, unreadable now: something changed under us, and SIGKILL
        // is unrecoverable. Fail closed — the caller tells the user to quit the
        // app by hand, which costs a manual step and never the wrong process.
        if (current === null) {
            logger.warn({ pid }, "[rescue] pid start time became unreadable — refusing to signal");

            return false;
        }

        if (Math.abs(current - baselineStartMs) > START_MS_TOLERANCE) {
            logger.warn(
                { pid, baselineStartMs, current },
                "[rescue] pid was reissued to a different process with the same command"
            );

            return false;
        }

        return true;
    };

    if (!isSameApp()) {
        step(`pid ${pid} is no longer the cmux the health probe found — sending nothing.`);

        return { signals, exited: true };
    }

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

    if (!isSameApp()) {
        // Something at this pid is alive, but it is no longer the app we started
        // on: it died during the grace window and the number was reissued —
        // possibly to a fresh cmux. SIGKILL is unrecoverable, so the escalation
        // stops rather than guessing.
        step(`pid ${pid} was recycled onto another process — not escalating to SIGKILL.`);

        return { signals, exited: true };
    }

    step(`Still alive after ${graceMs / 1000} s — sending SIGKILL.`);

    try {
        sys.kill(pid, "SIGKILL");
        signals.push("SIGKILL");
    } catch (error) {
        logger.warn({ error, pid }, "[rescue] SIGKILL failed");
    }

    await sys.sleep(1000);

    // A pid reissued during that last second answers the liveness probe about a
    // stranger. The caller treats `exited: false` as fatal and refuses to
    // relaunch, so reading a stranger as "cmux survived" aborts a rescue that
    // actually worked. Our app is gone either way.
    return { signals, exited: !isAlive(pid, sys) || !isSameApp() };
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
