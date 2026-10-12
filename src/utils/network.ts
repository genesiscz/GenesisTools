import { createServer } from "node:net";
import { networkInterfaces, userInfo } from "node:os";
import { logger } from "@genesiscz/utils/logger";
import { readProcessRow } from "@genesiscz/utils/process/libproc-table";
import { listeningPids } from "@genesiscz/utils/process/socket-owner";
import { readProcessCommand } from "@genesiscz/utils/process-identity";

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
 * Parse newline-separated PID output (e.g. `lsof -t`, `pgrep`) into positive
 * integer PIDs, dropping blank or non-numeric lines.
 */
export function parsePidLines(stdout: string): number[] {
    return stdout
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isFinite(pid) && pid > 0);
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
 * or the OS doesn't expose it to us. macOS reads libproc (the rows lsof would
 * print, without its 267 ms); Linux, or a Mac where libproc does not load, uses
 * `lsof`. Windows is unsupported for now (returns null) — most DashboardApp
 * consumers are macOS-only anyway.
 *
 * The command is the WHOLE `ps -o command=` line. It used to come from
 * `ps -o command=,uid=`, where ps cuts a column that is not the last one at 16
 * characters, so a caller matching it (`isAiProxyServeCommand`) never matched.
 */
export async function getPortOwner(port: number): Promise<PortOwner | null> {
    if (process.platform === "win32") {
        return null;
    }

    const fromKernel = listeningPids(port);

    if (fromKernel !== null) {
        const pid = fromKernel[0];

        if (pid === undefined) {
            return null;
        }

        const command = readProcessCommand(pid);

        if (command === null) {
            return { pid, command: "(unknown)", sameUser: false };
        }

        return { pid, command, sameUser: readProcessRow(pid)?.uid === userInfo().uid };
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

        const pid = parsePidLines(lsofOut)[0];
        if (!pid) {
            return null;
        }

        // uid first: ps cuts every column but the last one to its width, so the command must come last.
        const psProc = Bun.spawn(["ps", "-p", String(pid), "-o", "uid=,command="], {
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

        // `ps -p N -o uid=,command=` prints "<uid> <cmd...>" — uid is the first token.
        const firstSpace = psOut.indexOf(" ");
        let command = psOut;
        let uid = Number.NaN;
        if (firstSpace > 0) {
            uid = Number.parseInt(psOut.slice(0, firstSpace), 10);
            command = psOut.slice(firstSpace + 1).trim();
        }

        const myUid = userInfo().uid;

        return { pid, command, sameUser: !Number.isNaN(uid) && uid === myUid };
    } catch (err) {
        logger.debug({ err, port }, "getPortOwner failed");
        return null;
    }
}
