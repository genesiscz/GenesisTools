import { classifyPortBatch, enrichPortsMeta } from "@app/dev-dashboard/lib/ports/enrich";
import type { KillPortResult, PortInfo, PortsResult } from "@app/dev-dashboard/lib/ports/types";
import { logger } from "@genesiscz/utils/logger";
import { readProcess } from "@genesiscz/utils/process/processes";
import { scanSockets } from "@genesiscz/utils/process/sockets";

/**
 * Fast list: lsof + batch process meta (argv/cwd/start/title/visibility). No HTTP probe.
 * Pair with `classifyListeningPorts` / SSE for progressive kind labels.
 */
export async function listListeningPorts(): Promise<PortsResult> {
    try {
        const sockets = scanSockets({ protocol: "TCP", state: "LISTEN" });
        if (sockets === null) {
            return { lsofAvailable: false, ports: [], scannedAt: Date.now() };
        }
        const seen = new Set<string>();
        const ports: PortInfo[] = [];
        for (const socket of sockets) {
            const proto = socket.family === "IPv6" ? "tcp6" : "tcp4";
            const key = `${socket.pid}:${socket.port}:${proto}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            ports.push({
                port: socket.port,
                pid: socket.pid,
                command: readProcess(socket.pid)?.name ?? "unknown",
                address: socket.address,
                proto,
            });
        }
        ports.sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
        return { lsofAvailable: true, ports: await enrichPortsMeta(ports), scannedAt: Date.now() };
    } catch (err) {
        logger.debug({ err }, "socket lookup failed; treating as unavailable");
        return { lsofAvailable: false, ports: [], scannedAt: Date.now() };
    }
}

/** HTTP-classify pending ports from a prior list. Returns only updated rows. */
export async function classifyListeningPorts(ports: PortInfo[]): Promise<PortInfo[]> {
    return classifyPortBatch(ports);
}

/**
 * Confirm the live process at `pid` still matches what we listed before signalling — PIDs are reused,
 * so without this we could kill an unrelated process (same discipline as ttyd manager's
 * processMatchesSession). Returns the live command string, or null when no such process exists.
 */
export function liveCommand(pid: number): string | null {
    return readProcess(pid, { otherUsers: true })?.command?.trim() ?? null;
}

export function killPort(pid: number, expectedCommand?: string): KillPortResult {
    if (!Number.isInteger(pid) || pid <= 1) {
        return { ok: false, killed: false, reason: "invalid pid" };
    }

    const cmd = liveCommand(pid);
    if (cmd === null) {
        return { ok: true, killed: false, reason: "pid not found" };
    }

    // lsof truncates COMMAND (e.g. "ControlCe"); require the listed token to be a substring of the
    // live command so we don't signal a recycled, unrelated PID.
    if (expectedCommand && !cmd.toLowerCase().includes(expectedCommand.toLowerCase().slice(0, 8))) {
        logger.warn({ pid, expectedCommand, cmd }, "port-killer: live command mismatch; refusing to kill");
        return { ok: false, killed: false, reason: "command mismatch" };
    }

    try {
        // pid-verified: liveCommand(pid) matched expectedCommand immediately above
        process.kill(pid, "SIGTERM");
        logger.info({ pid, cmd }, "port-killer: SIGTERM delivered");
        return { ok: true, killed: true };
    } catch (err) {
        logger.debug({ err, pid }, "port-killer: process.kill failed");
        return { ok: true, killed: false, reason: "already gone" };
    }
}
