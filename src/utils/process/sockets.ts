/**
 * TCP and UDP sockets with their owning process, on every platform, without a caller ever choosing a reader (see
 * `processes.ts` for the rule): libproc on macOS, `/proc/net` plus descriptor links on Linux, one `netstat -ano` on
 * Windows, one `lsof` where none of those works. macOS and Linux read only this user's processes, which is what a
 * non-root `lsof` reads as well.
 */
import { existsSync } from "node:fs";
import { listProcPids, readProcTcp, readProcUdp, socketInodeOwners, TCP_STATE_NAMES } from "./linux-proc";
import { darwinKernel, processPlatform } from "./os";
import { captureSync } from "./ps";
import { listInetSockets } from "./socket-owner";
import { listNetstatTcp } from "./windows-cim";

export interface SocketEntry {
    pid: number;
    protocol: "TCP" | "UDP";
    family: "IPv4" | "IPv6";
    /** The local address as `lsof -n` prints it: `*` for any, `127.0.0.1`, `[::1]`. */
    address: string;
    port: number;
    /** The peer, or `""` and 0 for a listening or unconnected socket. */
    remoteAddress: string;
    remotePort: number;
    /** The TCP state as lsof prints it (`LISTEN`, `ESTABLISHED`, …); null for UDP. */
    state: string | null;
}

export interface SocketQuery {
    /** Either end of the socket, as `lsof -i :<port>` matches. */
    port?: number;
    protocol?: "TCP" | "UDP";
    /** A TCP state as lsof prints it; leaves UDP out. */
    state?: string;
}

const ANY = new Set(["0.0.0.0", "::", "*", "[::]"]);

function lsofAddress(address: string): string {
    if (ANY.has(address)) {
        return "*";
    }

    return address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
}

function linuxSockets(): SocketEntry[] {
    const owners = socketInodeOwners(undefined, listProcPids());
    const rows = [
        ...readProcTcp().map((row) => ({ row, protocol: "TCP" as const })),
        ...readProcUdp().map((row) => ({ row, protocol: "UDP" as const })),
    ];

    return rows.flatMap(({ row, protocol }) => {
        const pid = owners.get(row.inode);

        if (pid === undefined) {
            return [];
        }

        const connected = row.remotePort !== 0;
        return [
            {
                pid,
                protocol,
                family: row.localAddress.includes(":") ? ("IPv6" as const) : ("IPv4" as const),
                address: lsofAddress(row.localAddress),
                port: row.localPort,
                remoteAddress: connected ? lsofAddress(row.remoteAddress) : "",
                remotePort: connected ? row.remotePort : 0,
                state: protocol === "TCP" ? (TCP_STATE_NAMES[row.state] ?? "UNKNOWN") : null,
            },
        ];
    });
}

function windowsSockets(): SocketEntry[] {
    return listNetstatTcp().map((row) => {
        const connected = row.remotePort !== 0;
        return {
            pid: row.pid,
            protocol: row.protocol,
            family: row.localAddress.includes(":") ? ("IPv6" as const) : ("IPv4" as const),
            address: lsofAddress(row.localAddress),
            port: row.localPort,
            remoteAddress: connected ? lsofAddress(row.remoteAddress) : "",
            remotePort: connected ? row.remotePort : 0,
            state: row.protocol === "TCP" ? (row.state === "LISTENING" ? "LISTEN" : row.state) : null,
        };
    });
}

/** The socket rows of `lsof -nP -i` (header skipped): NODE is the protocol, NAME the ends, then `(STATE)` for TCP. */
export function parseLsofSockets(stdout: string): SocketEntry[] {
    const sockets: SocketEntry[] = [];

    for (const line of stdout.split("\n").slice(1)) {
        const parts = line.trim().split(/\s+/);
        const protocol = parts[7];

        if (parts.length < 9 || (protocol !== "TCP" && protocol !== "UDP")) {
            continue;
        }

        const [local = "", remote = ""] = parts[8].split("->");
        const localColon = local.lastIndexOf(":");
        const remoteColon = remote.lastIndexOf(":");

        if (localColon < 0) {
            continue;
        }

        sockets.push({
            pid: Number(parts[1]),
            protocol,
            family: parts[4] === "IPv6" ? "IPv6" : "IPv4",
            address: local.slice(0, localColon),
            port: Number(local.slice(localColon + 1)),
            remoteAddress: remoteColon < 0 ? "" : remote.slice(0, remoteColon),
            remotePort: remoteColon < 0 ? 0 : Number(remote.slice(remoteColon + 1)),
            state: protocol === "TCP" ? (parts[9]?.replace(/[()]/g, "") ?? null) : null,
        });
    }

    return sockets;
}

function allSockets(): SocketEntry[] {
    switch (processPlatform()) {
        case "linux":
            return linuxSockets();
        case "win32":
            return windowsSockets();
        default:
            break;
    }

    const sockets = darwinKernel() ? listInetSockets() : null;

    if (sockets === null) {
        return parseLsofSockets(captureSync("lsof", ["-nP", "-i"]).stdout);
    }

    return sockets.map((socket) => ({
        pid: socket.pid,
        protocol: socket.protocol,
        family: socket.type,
        address: socket.address,
        port: socket.port,
        remoteAddress: socket.remotePort === 0 ? "" : socket.remoteAddress,
        remotePort: socket.remotePort,
        state: socket.state,
    }));
}

/** Every socket matching the query, ascending by pid: `lsof -nP -i[TCP|UDP][:port] [-sTCP:<state>]`. */
export function listSockets(query: SocketQuery = {}): SocketEntry[] {
    return allSockets()
        .filter(
            (socket) =>
                (query.port === undefined || socket.port === query.port || socket.remotePort === query.port) &&
                (query.protocol === undefined || socket.protocol === query.protocol) &&
                (query.state === undefined || socket.state === query.state)
        )
        .sort((a, b) => a.pid - b.pid);
}

/** Every listening TCP socket this user may read (`lsof -nP -iTCP -sTCP:LISTEN`). */
export function listListeningTcp(): SocketEntry[] {
    return listSockets({ protocol: "TCP", state: "LISTEN" });
}

/** Every ESTABLISHED TCP connection this user may read, with both ends. */
export function listEstablishedTcp(): SocketEntry[] {
    return listSockets({ protocol: "TCP", state: "ESTABLISHED" });
}

/** The pids listening on TCP `port`, ascending and unique (`lsof -t -iTCP:<port> -sTCP:LISTEN`). */
export function listeningPidsOnPort(port: number): number[] {
    return [
        ...new Set(
            listListeningTcp()
                .filter((socket) => socket.port === port)
                .map((socket) => socket.pid)
        ),
    ];
}

/**
 * True when the socket readers here can answer at all: libproc on macOS, `/proc/net/tcp` on Linux, `netstat` on
 * Windows. Where it is false a list comes from `lsof` and may be empty because `lsof` failed, so a caller that would
 * act on "nobody is connected" (stop an idle server) must treat the answer as unknown.
 */
export function canReadSockets(): boolean {
    switch (processPlatform()) {
        case "linux":
            return existsSync("/proc/net/tcp");
        case "win32":
            return true;
        default:
            return darwinKernel();
    }
}
