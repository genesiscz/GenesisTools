/**
 * Port conflict resolution for DashboardApp.
 *
 * Three distinct conflict states:
 *
 *  - **free** — port is available. Caller proceeds with up.
 *  - **mine** — port is held by THIS dashboard's PID (matches `pidFile`). Caller
 *    offers restart/down/attach/status.
 *  - **stale** — port is held by a same-user process but the pid file is missing
 *    or points to a dead/different pid (typical orphan from a prior manual `up`).
 *    Callers reclaim automatically before launchd install or background spawn.
 *  - **foreign** — port is held by someone else. Caller errors with the owning
 *    PID + cmdline; in TTY can offer kill+up; non-TTY suggests `--force`.
 */
import { logger } from "@app/logger";
import { getPortOwner, type PortOwner } from "@app/utils/network";
import { defaultPlistLabel, isLaunchdInstalled } from "./launchd";
import { readPid, readPidRaw } from "./pidFile";
import { readPreferences } from "./preferences";

export type PortConflict =
    | { state: "free" }
    | { state: "mine"; pid: number; owner: PortOwner | null }
    | { state: "stale"; owner: PortOwner }
    | { state: "foreign"; owner: PortOwner | null };

/**
 * Source of truth for port occupancy: lsof. `isPortInUse` is unreliable here
 * because it probes a specific host/family (default `127.0.0.1` IPv4 only) and
 * misses Vite, which listens on `*:port` IPv6 dual-stack. lsof finds any
 * listener regardless of family.
 */
export async function checkPortConflict(key: string, port: number): Promise<PortConflict> {
    const owner = await getPortOwner(port);

    if (!owner) {
        return { state: "free" };
    }

    const ourPid = readPid(key);
    const rawPid = readPidRaw(key);

    if (owner.sameUser && isOwnedPortHolder(key, owner, ourPid)) {
        return { state: "mine", pid: owner.pid, owner };
    }

    const label = defaultPlistLabel(key);
    const hasOwnershipSignal =
        rawPid !== null || (isLaunchdInstalled(label) && (readPreferences(key).launchdInstalled ?? false));

    if (owner.sameUser && hasOwnershipSignal) {
        return { state: "stale", owner };
    }

    return { state: "foreign", owner };
}

function isOwnedPortHolder(key: string, owner: PortOwner, filePid: number | null): boolean {
    if (filePid && owner.pid === filePid) {
        return true;
    }

    if (!owner.sameUser) {
        return false;
    }

    const label = defaultPlistLabel(key);

    return isLaunchdInstalled(label) && (readPreferences(key).launchdInstalled ?? false);
}

export interface WaitForPortFreeOptions {
    /** After `timeoutMs`, escalate to SIGTERM→SIGKILL when the port is still held. Default false. */
    killIfHeld?: boolean;
    /** When killing, require `owner.sameUser`. Default true. */
    sameUserOnly?: boolean;
    /** Only kill when the listener is still this pid (avoids killing a new binder). */
    expectOwnerPid?: number;
    /**
     * Only kill when `checkPortConflict` reports `mine` or `stale` for this dashboard.
     * Use after stopping our own launchd agent / orphan reclaim — never on arbitrary ports.
     */
    dashboardKey?: string;
}

const POST_KILL_WAIT_MS = 2_000;

export async function waitForPortFree(
    port: number,
    timeoutMs: number,
    opts: WaitForPortFreeOptions = {}
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (!(await getPortOwner(port))) {
            return true;
        }

        await Bun.sleep(150);
    }

    if (!opts.killIfHeld) {
        return !(await getPortOwner(port));
    }

    const owner = await getPortOwner(port);

    if (!owner) {
        return true;
    }

    if (!(await canKillPortOwner(port, owner, opts))) {
        return false;
    }

    logger.warn({ port, pid: owner.pid, command: owner.command }, "port still held after graceful wait; forcing kill");
    await killPortOwner(owner, { force: true });

    const afterKillDeadline = Date.now() + POST_KILL_WAIT_MS;

    while (Date.now() < afterKillDeadline) {
        if (!(await getPortOwner(port))) {
            return true;
        }

        await Bun.sleep(150);
    }

    return false;
}

export async function canKillPortOwner(
    port: number,
    owner: PortOwner,
    opts: Pick<WaitForPortFreeOptions, "sameUserOnly" | "expectOwnerPid" | "dashboardKey">
): Promise<boolean> {
    const sameUserOnly = opts.sameUserOnly ?? true;

    if (sameUserOnly && !owner.sameUser) {
        return false;
    }

    if (opts.expectOwnerPid !== undefined && owner.pid !== opts.expectOwnerPid) {
        return false;
    }

    if (opts.dashboardKey) {
        const conflict = await checkPortConflict(opts.dashboardKey, port);

        if (conflict.state !== "mine" && conflict.state !== "stale") {
            return false;
        }
    }

    return true;
}

export async function killPortOwner(owner: PortOwner, opts: { force?: boolean } = {}): Promise<void> {
    const force = opts.force ?? true;

    try {
        process.kill(owner.pid, "SIGTERM");
    } catch (error) {
        logger.debug({ pid: owner.pid, signal: "SIGTERM", error }, "failed to signal process");
    }

    const graceDeadline = Date.now() + 5_000;

    while (Date.now() < graceDeadline) {
        if (!isProcessAlive(owner.pid)) {
            return;
        }

        await Bun.sleep(200);
    }

    if (!force) {
        return;
    }

    try {
        process.kill(owner.pid, "SIGKILL");
    } catch (error) {
        logger.debug({ pid: owner.pid, signal: "SIGKILL", error }, "failed to force-kill process");
    }

    await Bun.sleep(500);
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        logger.debug({ pid, error }, "process liveness probe failed");
        return false;
    }
}
