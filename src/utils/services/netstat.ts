import { type CaptureResult, captureSync } from "@genesiscz/utils/process/ps";

/**
 * `lsof -iTCP` walks every file descriptor of every process: 9 to 10 seconds on this Mac at a load
 * average of 7, past the 10 s deadline of the idle check, so the daemon's `services-idle-reap` was
 * killed on 38 of 79 runs on 2026-10-05. `netstat` reads the kernel's socket list directly (0.00 s)
 * and, with `-v`, names the owning process on macOS, which is all the service inventory and the idle
 * check ask of lsof.
 */
export const NETSTAT_ARGS = ["-anv", "-p", "tcp"] as const;

/** The columns after the state: `rxbytes txbytes rhiwat shiwat <name>:<pid> <5-hex state>`. The name may hold spaces. */
const LISTEN_ROW = /^tcp\S*\s+\d+\s+\d+\s+\S+\s+\S+\s+LISTEN\s+\d+\s+\d+\s+\d+\s+\d+\s+.+:(\d+)\s+[0-9a-f]{5}\s/;
const LISTEN_ADDRESS = /^tcp\S*\s+\d+\s+\d+\s+(\S+)\s/;
const ESTABLISHED_ROW = /^tcp\S*\s+\d+\s+\d+\s+(\S+)\s+\S+\s+ESTABLISHED\s/;

/** macOS writes `127.0.0.1.4242`, `*.4242` and `::1.4242`: the port follows the last dot. */
function portOf(address: string): number {
    return Number(address.slice(address.lastIndexOf(".") + 1));
}

export function netstatIsUsable(): boolean {
    return process.platform === "darwin";
}

export function runNetstat(timeoutMs = 10_000): CaptureResult {
    return captureSync("netstat", [...NETSTAT_ARGS], { timeoutMs });
}

/** The listening ports of each pid, the shape `parseLsofListeners` returns. */
export function parseNetstatListeners(stdout: string): Map<number, number[]> {
    const ports = new Map<number, number[]>();

    for (const line of stdout.split("\n")) {
        const pid = Number(LISTEN_ROW.exec(line)?.[1]);
        const port = portOf(LISTEN_ADDRESS.exec(line)?.[1] ?? "");

        if (Number.isInteger(pid) && pid > 0 && Number.isInteger(port)) {
            ports.set(pid, [...new Set([...(ports.get(pid) ?? []), port])]);
        }
    }

    return ports;
}

/** The local port of every established connection, both ends of a loopback pair included. */
export function parseNetstatClientPorts(stdout: string): Set<number> {
    const ports = new Set<number>();

    for (const line of stdout.split("\n")) {
        const address = ESTABLISHED_ROW.exec(line)?.[1];
        const port = address === undefined ? Number.NaN : portOf(address);

        if (Number.isInteger(port)) {
            ports.add(port);
        }
    }

    return ports;
}
