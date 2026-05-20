/**
 * Port conflict resolution for DashboardApp.
 *
 * Three distinct conflict states:
 *
 *  - **free** — port is available. Caller proceeds with up.
 *  - **mine** — port is held by THIS dashboard's PID (matches `pidFile`). Caller
 *    offers restart/down/attach/status.
 *  - **foreign** — port is held by someone else. Caller errors with the owning
 *    PID + cmdline; in TTY can offer kill+up; non-TTY suggests `--force`.
 */
import { getPortOwner, type PortOwner } from "@app/utils/network";
import { readPid } from "./pidFile";

export type PortConflict =
    | { state: "free" }
    | { state: "mine"; pid: number; owner: PortOwner | null }
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
    if (ourPid && owner.pid === ourPid) {
        return { state: "mine", pid: ourPid, owner };
    }

    return { state: "foreign", owner };
}
