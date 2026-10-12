import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("daemon");

/** Bound on the `ioreg` read; the scheduler treats a timeout as a loop failure and tries again next tick. */
export const WAKE_CHECK_TIMEOUT_MS = 5_000;

/** IOPMrootDomain's capability bit for graphics (`kIOPMSystemCapabilityGraphics`): set in a full wake, clear in a
 *  DarkWake (Power Nap and maintenance wakes run with CPU and network only). */
const CAPABILITY_GRAPHICS = 0x2;

/** The `"System Capabilities" = N` line of `ioreg -n IOPMrootDomain`, or null when it is missing. */
export function parseSystemCapabilities(ioreg: string): number | null {
    const match = /"System Capabilities"\s*=\s*(\d+)/.exec(ioreg);
    return match ? Number(match[1]) : null;
}

/** True when the Mac is in a full wake, false in a DarkWake. Spawns `ioreg` once; the scheduler asks only while an
 *  `on-wake` catch-up is due. A read that fails says true, so a broken check can delay nothing forever. */
export async function isFullWake(): Promise<boolean> {
    try {
        const proc = Bun.spawn(["/usr/sbin/ioreg", "-n", "IOPMrootDomain", "-r", "-d", "1"], {
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
        const capabilities = exitCode === 0 ? parseSystemCapabilities(stdout) : null;

        if (capabilities === null) {
            log.warn({ exitCode }, "[daemon] System Capabilities unreadable; treating this as a full wake");
            return true;
        }

        const full = (capabilities & CAPABILITY_GRAPHICS) !== 0;
        log.debug({ capabilities, full }, "[daemon] wake state read");
        return full;
    } catch (err) {
        log.warn({ err }, "[daemon] wake state check failed; treating this as a full wake");
        return true;
    }
}
