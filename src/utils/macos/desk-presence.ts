import { logger } from "@genesiscz/utils/logger";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";

const log = logger.child({ component: "macos:desk-presence" });

/** Whether someone sits at this Mac: seconds since the last key or pointer event, and whether the screen is locked. */
export interface DeskPresence {
    /** Null when `ioreg` gave no idle time. */
    idleSeconds: number | null;
    /** Null when the console session could not be read. */
    locked: boolean | null;
}

/** `"HIDIdleTime" = 123456789` (nanoseconds) in `ioreg -c IOHIDSystem` output, as seconds. */
export function parseIdleSeconds(text: string): number | null {
    const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(text);
    return match ? Math.floor(Number(match[1]) / 1e9) : null;
}

/** `CGSSessionScreenIsLocked` in the console users of `ioreg -n Root -d1 -a` (a plist); absent means unlocked. */
export function parseScreenLocked(plist: string): boolean | null {
    if (!plist.includes("IOConsoleUsers")) {
        return null;
    }

    return /<key>CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(plist);
}

/** Reads the desk presence with two `ioreg` calls (about 20 ms each). Read only. */
export async function readDeskPresence(): Promise<DeskPresence> {
    const [idle, root] = await Promise.all([
        boundedCommand({
            command: ["ioreg", "-c", "IOHIDSystem", "-r", "-d", "1", "-k", "HIDIdleTime"],
            timeoutMs: 3000,
        }),
        boundedCommand({ command: ["ioreg", "-n", "Root", "-d1", "-a"], timeoutMs: 3000 }),
    ]);
    const presence: DeskPresence = {
        idleSeconds: idle.status === 0 ? parseIdleSeconds(idle.stdout) : null,
        locked: root.status === 0 ? parseScreenLocked(root.stdout) : null,
    };

    if (presence.idleSeconds === null || presence.locked === null) {
        log.debug(
            { idle: idle.status, root: root.status, stderr: `${idle.stderr}${root.stderr}`.slice(0, 300) },
            "desk presence partly unknown"
        );
    }

    return presence;
}

/** Away from the desk: locked, or idle at least `idleMinutes`. Unknown counts as away, so a push is never lost. */
export function awayFromDesk(presence: DeskPresence, idleMinutes: number): boolean {
    if (presence.locked !== false) {
        return true;
    }

    if (presence.idleSeconds === null) {
        return true;
    }

    return presence.idleSeconds >= idleMinutes * 60;
}
