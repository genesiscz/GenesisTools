import { createServer } from "node:net";
import { networkInterfaces, userInfo } from "node:os";
import { logger } from "@app/logger";

/**
 * Returns the first non-internal IPv4 address (LAN IP).
 * Falls back to 127.0.0.1 when no external interface is found.
 */
export function getLocalIpv4(): string {
    for (const ifaces of Object.values(networkInterfaces())) {
        for (const iface of ifaces ?? []) {
            if (iface.family === "IPv4" && !iface.internal) {
                return iface.address;
            }
        }
    }

    return "127.0.0.1";
}

function hasErrnoCode(e: unknown): e is { code: string } {
    return typeof e === "object" && e !== null && "code" in e && typeof (e as { code: unknown }).code === "string";
}

/**
 * Returns true if the given port is already bound on the given host.
 * Resolves false when the port is free (and closes the probe server).
 * Never throws for the normal EADDRINUSE case.
 */
export async function isPortInUse(port: number, host = "127.0.0.1"): Promise<boolean> {
    return new Promise((resolve) => {
        const server = createServer();

        server.once("error", (err) => {
            if (hasErrnoCode(err) && err.code === "EADDRINUSE") {
                resolve(true);
            } else {
                resolve(false);
            }
        });

        server.listen(port, host, () => {
            server.close(() => {
                resolve(false);
            });
        });
    });
}

export interface PortOwner {
    pid: number;
    command: string;
    /** True when the owning process runs as the current user (and is therefore signal-able). */
    sameUser: boolean;
}

/**
 * Find who's listening on a TCP port. Returns null when nothing is listening
 * or the OS doesn't expose it to us. macOS/Linux use `lsof`. Windows is
 * unsupported for now (returns null) — most DashboardApp consumers are
 * macOS-only anyway.
 */
export async function getPortOwner(port: number): Promise<PortOwner | null> {
    if (process.platform === "win32") {
        return null;
    }

    try {
        // /usr/sbin/lsof on macOS; some sandboxed PATHs don't include /usr/sbin.
        const lsofBinary = process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof";
        const lsofProc = Bun.spawn([lsofBinary, "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
            stdout: "pipe",
            stderr: "pipe",
        });
        const lsofOut = await new Response(lsofProc.stdout).text();
        const lsofExit = await lsofProc.exited;

        if (lsofExit !== 0) {
            logger.debug({ port, exitCode: lsofExit }, "lsof returned non-zero exit");
            return null;
        }

        const pid = Number.parseInt(
            lsofOut
                .split("\n")
                .map((line) => line.trim())
                .find((line) => line.length > 0) ?? "",
            10
        );
        if (Number.isNaN(pid) || pid <= 0) {
            return null;
        }

        const psProc = Bun.spawn(["ps", "-p", String(pid), "-o", "command=,uid="], {
            stdout: "pipe",
            stderr: "pipe",
        });
        const psOut = (await new Response(psProc.stdout).text()).trim();
        const psExit = await psProc.exited;

        if (psExit !== 0) {
            logger.debug({ port, pid, exitCode: psExit }, "ps returned non-zero exit");
            return { pid, command: "(unknown)", sameUser: false };
        }

        if (!psOut) {
            return { pid, command: "(unknown)", sameUser: false };
        }

        // `ps -p N -o command=,uid=` prints "<cmd...> <uid>" — uid is the last token.
        const lastSpace = psOut.lastIndexOf(" ");
        let command = psOut;
        let uid = Number.NaN;
        if (lastSpace > 0) {
            command = psOut.slice(0, lastSpace).trim();
            uid = Number.parseInt(psOut.slice(lastSpace + 1).trim(), 10);
        }

        const myUid = userInfo().uid;

        return { pid, command, sameUser: !Number.isNaN(uid) && uid === myUid };
    } catch (err) {
        logger.debug({ err, port }, "getPortOwner failed");
        return null;
    }
}
