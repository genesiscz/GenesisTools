/**
 * Which process owns the client end of a loopback TCP connection.
 *
 * A local HTTP server (the mcp-manager gateway) sees only a peer port. The kernel knows
 * which process holds the socket with that local port, and that answer is exact: one
 * connected socket, one owner (plus any child that inherited the fd, which the caller
 * filters by name). Nothing here guesses from timing.
 *
 * macOS: libproc, the same calls `lsof` makes, without lsof's ~0.23 s start-up cost.
 * Other platforms return null and callers treat the peer as unknown.
 */

import { dlopen, FFIType, ptr } from "bun:ffi";
import { userInfo } from "node:os";
import { libSystem } from "@genesiscz/utils/fs/native/libsystem";
import { logger } from "@genesiscz/utils/logger";

const log = logger.child({ component: "process:socket-owner" });

/** Sizes and offsets from <sys/proc_info.h>; `socket-owner.test.ts` proves them on a live socket. */
const PROC_PIDLISTFDS = 1;
const PROC_FDINFO_SIZE = 8;
const PROX_FDTYPE_SOCKET = 2;
const PROC_PIDFDSOCKETINFO = 3;
const SOCKET_FDINFO_SIZE = 792;
/** `socket_fdinfo.psi` follows the 24-byte `proc_fileinfo`. */
const PSI = 24;
/** `socket_info.soi_kind`, after vinfo_stat (136) and the fixed fields up to the two sockbuf_infos. */
const SOI_KIND_OFFSET = PSI + 232;
const SOCKINFO_TCP = 2;
/** `socket_info.soi_proto.pri_tcp.tcpsi_ini.insi_fport` / `insi_lport`, network byte order in the low 16 bits. */
const INSI_FPORT_OFFSET = PSI + 240;
const INSI_LPORT_OFFSET = PSI + 244;

const PROC_PIDTBSDINFO = 3;
const PROC_PIDTBSDINFO_SIZE = 136;
const PBI_UID_OFFSET = 20;
const PBI_COMM_OFFSET = 48;
const PBI_COMM_SIZE = 16;
const PBI_START_TVSEC_OFFSET = 120;

type LibProc = {
    proc_listallpids: (buffer: unknown, size: number) => number;
    proc_pidinfo: (pid: number, flavor: number, arg: bigint, buffer: unknown, size: number) => number;
    proc_pidfdinfo: (pid: number, fd: number, flavor: number, buffer: unknown, size: number) => number;
};

let libproc: LibProc | null | undefined;

function loadLibproc(): LibProc | null {
    if (libproc !== undefined) {
        return libproc;
    }

    if (process.platform !== "darwin") {
        libproc = null;
        return libproc;
    }

    try {
        const lib = dlopen("libproc.dylib", {
            proc_listallpids: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
            proc_pidinfo: {
                args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
                returns: FFIType.i32,
            },
            proc_pidfdinfo: {
                args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.i32],
                returns: FFIType.i32,
            },
        });
        libproc = lib.symbols as LibProc;
    } catch (error) {
        log.debug({ error }, "libproc unavailable");
        libproc = null;
    }

    return libproc;
}

export interface ProcessInfo {
    pid: number;
    /** `pbi_comm`: the executable name, at most 16 bytes. */
    name: string;
    uid: number;
    /** Process start, seconds since the epoch. */
    startSec: number;
}

/** Name, uid and start time of `pid`, or null when it is gone or unreadable. */
export function readProcessInfo(pid: number): ProcessInfo | null {
    const lib = loadLibproc();
    if (!lib) {
        return null;
    }

    const buffer = new Uint8Array(PROC_PIDTBSDINFO_SIZE);
    if (lib.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0n, ptr(buffer), PROC_PIDTBSDINFO_SIZE) !== PROC_PIDTBSDINFO_SIZE) {
        return null;
    }

    const view = new DataView(buffer.buffer);
    const commBytes = buffer.subarray(PBI_COMM_OFFSET, PBI_COMM_OFFSET + PBI_COMM_SIZE);
    const end = commBytes.indexOf(0);
    const name = new TextDecoder().decode(end === -1 ? commBytes : commBytes.subarray(0, end));

    return {
        pid,
        name,
        uid: view.getUint32(PBI_UID_OFFSET, true),
        startSec: Number(view.getBigUint64(PBI_START_TVSEC_OFFSET, true)),
    };
}

function listAllPids(lib: LibProc): Int32Array {
    let capacity = 4096;

    while (true) {
        const pids = new Int32Array(capacity);
        const count = lib.proc_listallpids(ptr(pids), pids.byteLength);
        if (count < capacity) {
            return pids.subarray(0, Math.max(0, count));
        }

        capacity *= 2;
    }
}

const fdBuffer = { bytes: new Uint8Array(PROC_FDINFO_SIZE * 512) };
const socketBuffer = new Uint8Array(SOCKET_FDINFO_SIZE);
const socketView = new DataView(socketBuffer.buffer);

/** True when `pid` holds a TCP socket whose local port is `localPort` and foreign port is `foreignPort`. */
function holdsSocket(lib: LibProc, pid: number, localPort: number, foreignPort: number): boolean {
    let written = lib.proc_pidinfo(pid, PROC_PIDLISTFDS, 0n, ptr(fdBuffer.bytes), fdBuffer.bytes.byteLength);
    while (written === fdBuffer.bytes.byteLength) {
        fdBuffer.bytes = new Uint8Array(fdBuffer.bytes.byteLength * 2);
        written = lib.proc_pidinfo(pid, PROC_PIDLISTFDS, 0n, ptr(fdBuffer.bytes), fdBuffer.bytes.byteLength);
    }

    if (written <= 0) {
        return false;
    }

    const fds = new DataView(fdBuffer.bytes.buffer, 0, written);
    for (let offset = 0; offset + PROC_FDINFO_SIZE <= written; offset += PROC_FDINFO_SIZE) {
        if (fds.getUint32(offset + 4, true) !== PROX_FDTYPE_SOCKET) {
            continue;
        }

        const fd = fds.getInt32(offset, true);
        if (
            lib.proc_pidfdinfo(pid, fd, PROC_PIDFDSOCKETINFO, ptr(socketBuffer), SOCKET_FDINFO_SIZE) !==
            SOCKET_FDINFO_SIZE
        ) {
            continue;
        }

        if (socketView.getInt32(SOI_KIND_OFFSET, true) !== SOCKINFO_TCP) {
            continue;
        }

        if (
            socketView.getUint16(INSI_LPORT_OFFSET, false) === localPort &&
            socketView.getUint16(INSI_FPORT_OFFSET, false) === foreignPort
        ) {
            return true;
        }
    }

    return false;
}

/** How many descriptors `pid` has open (this user's processes only), from `PROC_PIDLISTFDS`; null when unreadable. */
export function countOpenFds(pid: number): number | null {
    const lib = loadLibproc();

    if (!lib) {
        return null;
    }

    let written = lib.proc_pidinfo(pid, PROC_PIDLISTFDS, 0n, ptr(fdBuffer.bytes), fdBuffer.bytes.byteLength);

    while (written === fdBuffer.bytes.byteLength) {
        fdBuffer.bytes = new Uint8Array(fdBuffer.bytes.byteLength * 2);
        written = lib.proc_pidinfo(pid, PROC_PIDLISTFDS, 0n, ptr(fdBuffer.bytes), fdBuffer.bytes.byteLength);
    }

    return written > 0 ? Math.floor(written / PROC_FDINFO_SIZE) : null;
}

const PROX_FDTYPE_VNODE = 1;
const PROC_PIDFDVNODEPATHINFO = 2;
/** `vnode_fdinfowithpath`: proc_fileinfo (24) + vnode_info (152) + vip_path[MAXPATHLEN]. */
const VNODE_FDINFOWITHPATH_SIZE = 24 + 152 + 1024;
const VNODE_PATH_OFFSET = 24 + 152;

/** Paths of the regular files `pid` holds open right now (same uid only). Empty when unreadable. */
export function readOpenFilePaths(pid: number): string[] {
    const lib = loadLibproc();
    if (!lib) {
        return [];
    }

    let written = lib.proc_pidinfo(pid, PROC_PIDLISTFDS, 0n, ptr(fdBuffer.bytes), fdBuffer.bytes.byteLength);
    while (written === fdBuffer.bytes.byteLength) {
        fdBuffer.bytes = new Uint8Array(fdBuffer.bytes.byteLength * 2);
        written = lib.proc_pidinfo(pid, PROC_PIDLISTFDS, 0n, ptr(fdBuffer.bytes), fdBuffer.bytes.byteLength);
    }

    if (written <= 0) {
        return [];
    }

    const fds = new DataView(fdBuffer.bytes.buffer.slice(0, written));
    const pathBuffer = new Uint8Array(VNODE_FDINFOWITHPATH_SIZE);
    const decoder = new TextDecoder();
    const paths: string[] = [];

    for (let offset = 0; offset + PROC_FDINFO_SIZE <= written; offset += PROC_FDINFO_SIZE) {
        if (fds.getUint32(offset + 4, true) !== PROX_FDTYPE_VNODE) {
            continue;
        }

        const fd = fds.getInt32(offset, true);
        const got = lib.proc_pidfdinfo(pid, fd, PROC_PIDFDVNODEPATHINFO, ptr(pathBuffer), VNODE_FDINFOWITHPATH_SIZE);
        if (got !== VNODE_FDINFOWITHPATH_SIZE) {
            continue;
        }

        const raw = pathBuffer.subarray(VNODE_PATH_OFFSET);
        const end = raw.indexOf(0);
        const path = decoder.decode(end === -1 ? raw : raw.subarray(0, end));
        if (path.length > 0) {
            paths.push(path);
        }
    }

    return paths;
}

/** `socket_info` fields of a listening TCP socket, offsets into `socket_fdinfo` (checked with `offsetof` in C). */
const SOI_FAMILY_OFFSET = PSI + 160;
const INSI_LADDR6_OFFSET = PSI + 288;
const INSI_LADDR4_OFFSET = PSI + 300;
const TCPSI_STATE_OFFSET = PSI + 320;
const TSI_S_LISTEN = 1;
const AF_INET6 = 30;
/** `proc_fileinfo.fi_openflags` (offset 0): FREAD and FWRITE, which lsof prints as the FD mode letter. */
const FREAD = 0x1;
const FWRITE = 0x2;

export interface ListeningSocket {
    pid: number;
    fd: number;
    /** lsof's FD mode letter: `u` read and write, `r`, `w`, or a space. */
    mode: string;
    port: number;
    /** The address family lsof names in its TYPE column. */
    type: "IPv4" | "IPv6";
    /** The local address as `lsof -n` prints it: `*` for any, `127.0.0.1`, `[::1]`. */
    address: string;
}

const addressBytes = new Uint8Array(16);
const addressText = Buffer.alloc(64);

/** The address at `offset` of the current `socket_fdinfo`, as `lsof -n` prints it. */
function formatAddress(type: ListeningSocket["type"], offset: number): string {
    const length = type === "IPv4" ? 4 : 16;
    const bytes = socketBuffer.subarray(offset, offset + length);

    if (bytes.every((byte) => byte === 0)) {
        return "*";
    }

    if (type === "IPv4") {
        return bytes.join(".");
    }

    // The C library's own text form, which is what lsof prints between the brackets.
    const symbols = libSystem();
    addressBytes.set(bytes);

    if (!symbols?.inet_ntop(AF_INET6, addressBytes, addressText, addressText.byteLength)) {
        return `[${Buffer.from(bytes).toString("hex")}]`;
    }

    return `[${addressText.toString("utf8", 0, addressText.indexOf(0))}]`;
}

/** `tcp_sockinfo.tcpsi_state` values (`<netinet/tcp_fsm.h>`). */
const TSI_S_ESTABLISHED = 4;
/** `in_sockinfo.insi_faddr`, 16 bytes before `insi_laddr`; an IPv4 address sits in its last 4 bytes. */
const INSI_FADDR6_OFFSET = PSI + 272;
const INSI_FADDR4_OFFSET = PSI + 284;

export interface TcpConnection extends ListeningSocket {
    /** The peer as `lsof -n` prints it: `127.0.0.1`, `[::1]`. */
    remoteAddress: string;
    remotePort: number;
}

/**
 * Every ESTABLISHED TCP socket of this user's processes, with both ends, from the same libproc reads as
 * {@link listListeningTcpSockets}. The `lsof -nP -iTCP -sTCP:ESTABLISHED` rows without the spawn. Null off macOS.
 */
export function listEstablishedTcpSockets(): TcpConnection[] | null {
    const lib = loadLibproc();

    if (!lib) {
        return null;
    }

    const connections: TcpConnection[] = [];

    scanTcpSockets(lib, TSI_S_ESTABLISHED, (socket) => {
        connections.push({
            ...socket,
            remoteAddress: formatAddress(socket.type, socket.type === "IPv4" ? INSI_FADDR4_OFFSET : INSI_FADDR6_OFFSET),
            remotePort: socketView.getUint16(INSI_FPORT_OFFSET, false),
        });
    });

    return connections;
}

/**
 * Every TCP socket in LISTEN state, in `lsof -nP -iTCP -sTCP:LISTEN` order (pid, then descriptor), from libproc:
 * `PROC_PIDLISTFDS`, then `PROC_PIDFDSOCKETINFO` per socket. Measured on 2026-10-12: 46 listening ports in about
 * 4 ms of CPU, identical to lsof's 46, where lsof cost 267 ms. Only this user's processes are readable, which is
 * exactly what `lsof` (not setuid on macOS) reads as well. Null off macOS or when libproc does not load.
 */
export function listListeningTcpSockets(): ListeningSocket[] | null {
    const lib = loadLibproc();

    if (!lib) {
        return null;
    }

    const sockets: ListeningSocket[] = [];
    scanTcpSockets(lib, TSI_S_LISTEN, (socket) => {
        sockets.push(socket);
    });

    return sockets;
}

/**
 * Calls `found` for each TCP socket in `state`, pid then descriptor ascending, while `socketBuffer` still holds that
 * socket's `socket_fdinfo` (so `found` may read more fields from it).
 */
function scanTcpSockets(lib: LibProc, state: number, found: (socket: ListeningSocket) => void): void {
    const pids = [...listAllPids(lib)].filter((pid) => pid > 0).sort((a, b) => a - b);

    for (const pid of pids) {
        // Another user's process answers 0 here; lsof, run as this user, cannot read it either.
        let written = lib.proc_pidinfo(pid, PROC_PIDLISTFDS, 0n, fdBuffer.bytes, fdBuffer.bytes.byteLength);
        while (written === fdBuffer.bytes.byteLength) {
            fdBuffer.bytes = new Uint8Array(fdBuffer.bytes.byteLength * 2);
            written = lib.proc_pidinfo(pid, PROC_PIDLISTFDS, 0n, fdBuffer.bytes, fdBuffer.bytes.byteLength);
        }

        if (written <= 0) {
            continue;
        }

        const fds = new DataView(fdBuffer.bytes.buffer, 0, written);

        for (let offset = 0; offset + PROC_FDINFO_SIZE <= written; offset += PROC_FDINFO_SIZE) {
            if (fds.getUint32(offset + 4, true) !== PROX_FDTYPE_SOCKET) {
                continue;
            }

            const fd = fds.getInt32(offset, true);

            if (
                lib.proc_pidfdinfo(pid, fd, PROC_PIDFDSOCKETINFO, socketBuffer, SOCKET_FDINFO_SIZE) !==
                    SOCKET_FDINFO_SIZE ||
                socketView.getInt32(SOI_KIND_OFFSET, true) !== SOCKINFO_TCP ||
                socketView.getInt32(TCPSI_STATE_OFFSET, true) !== state
            ) {
                continue;
            }

            // The family decides, as in lsof's TYPE column: a dual-stack IPv6 socket (vflag IPv4 and IPv6) is IPv6.
            const type = socketView.getInt32(SOI_FAMILY_OFFSET, true) === AF_INET6 ? "IPv6" : "IPv4";
            const flags = socketView.getUint32(0, true);
            const mode =
                (flags & FREAD) !== 0 ? ((flags & FWRITE) !== 0 ? "u" : "r") : (flags & FWRITE) !== 0 ? "w" : " ";

            found({
                pid,
                fd,
                mode,
                port: socketView.getUint16(INSI_LPORT_OFFSET, false),
                type,
                address: formatAddress(type, type === "IPv4" ? INSI_LADDR4_OFFSET : INSI_LADDR6_OFFSET),
            });
        }
    }
}

/**
 * {@link listListeningTcpSockets} printed as `lsof -nP -iTCP -sTCP:LISTEN` prints it (header, then one row per
 * socket, same order, same COMMAND / PID / USER / FD / TYPE / NAME cells), so every existing lsof parser reads it
 * unchanged. COMMAND is the process name cut at 9 characters and at its first space, as lsof shows it. Checked on
 * 2026-10-12 against lsof: 55 of 55 rows equal. Null where libproc is unavailable; the caller then runs lsof.
 */
export function listListeningTcpAsLsof(): string | null {
    const sockets = listListeningTcpSockets();

    if (sockets === null) {
        return null;
    }

    const own = userInfo();
    const rows = ["COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME"];

    for (const socket of sockets) {
        const info = readProcessInfo(socket.pid);
        const command = (info?.name ?? "?").slice(0, 9).split(" ")[0] || "?";
        const user = info === null || info.uid === own.uid ? own.username : String(info.uid);
        const fd = `${socket.fd}${socket.mode.trim()}`;
        rows.push(
            `${command} ${socket.pid} ${user} ${fd} ${socket.type} 0x0 0t0 TCP ${socket.address}:${socket.port} (LISTEN)`
        );
    }

    return `${rows.join("\n")}\n`;
}

/** The pids listening on TCP `port`, ascending like `lsof -t`, or null where libproc is unavailable. */
export function listeningPids(port: number): number[] | null {
    const sockets = listListeningTcpSockets();

    if (sockets === null) {
        return null;
    }

    return [...new Set(sockets.filter((socket) => socket.port === port).map((socket) => socket.pid))];
}

/** The last answer per client port, re-checked against that one pid before it is trusted again. */
const lastOwner = new Map<string, number>();

/**
 * Every process that holds the client end of the connection from `clientPort` to `serverPort`.
 * Usually one. A child that inherited the descriptor also appears, so callers pick by name.
 * Only processes of this uid are readable, which is the set that can reach a loopback server
 * with this user's token anyway.
 */
export function findLoopbackClientPids(opts: { clientPort: number; serverPort: number }): number[] {
    const lib = loadLibproc();
    if (!lib) {
        return [];
    }

    const key = `${opts.clientPort}:${opts.serverPort}`;
    const cached = lastOwner.get(key);
    if (cached !== undefined && holdsSocket(lib, cached, opts.clientPort, opts.serverPort)) {
        return [cached];
    }

    const ownUid = process.getuid?.() ?? -1;
    const owners: number[] = [];

    for (const pid of listAllPids(lib)) {
        if (pid <= 0) {
            continue;
        }

        const info = readProcessInfo(pid);
        if (!info || info.uid !== ownUid) {
            continue;
        }

        if (holdsSocket(lib, pid, opts.clientPort, opts.serverPort)) {
            owners.push(pid);
        }
    }

    if (owners.length === 1) {
        lastOwner.set(key, owners[0]);
    } else {
        lastOwner.delete(key);
    }

    if (lastOwner.size > 4096) {
        lastOwner.clear();
    }

    return owners;
}

/** `socket_info.soi_kind` values (`sys/proc_info.h`). */
const SOCKINFO_IN = 1;
const SOCKINFO_UN = 3;
/** `tcp_sockinfo.tcpsi_state` names, indexed by value (`netinet/tcp_fsm.h`), as lsof prints them. */
const TCP_STATE_NAMES = [
    "CLOSED",
    "LISTEN",
    "SYN_SENT",
    "SYN_RECEIVED",
    "ESTABLISHED",
    "CLOSE_WAIT",
    "FIN_WAIT_1",
    "CLOSING",
    "LAST_ACK",
    "FIN_WAIT_2",
    "TIME_WAIT",
];
/** `un_sockinfo.unsi_addr.ua_sun.sun_path`: after two 64-bit pcb words and `sun_len`, `sun_family`. */
const UNSI_PATH_OFFSET = PSI + 240 + 16 + 2;
const SUN_PATH_SIZE = 104;

export interface InetSocket {
    pid: number;
    fd: number;
    mode: string;
    protocol: "TCP" | "UDP";
    type: "IPv4" | "IPv6";
    address: string;
    port: number;
    /** `*` and 0 for an unconnected socket. */
    remoteAddress: string;
    remotePort: number;
    /** The TCP state as lsof prints it (`LISTEN`, `ESTABLISHED`, …); null for UDP. */
    state: string | null;
}

function openMode(flags: number): string {
    return (flags & FREAD) !== 0 ? ((flags & FWRITE) !== 0 ? "u" : "r") : (flags & FWRITE) !== 0 ? "w" : " ";
}

/** Reads `pid`'s descriptor list into `fdBuffer`; the number of bytes written, 0 when unreadable. */
function readFdList(lib: LibProc, pid: number): number {
    let written = lib.proc_pidinfo(pid, PROC_PIDLISTFDS, 0n, fdBuffer.bytes, fdBuffer.bytes.byteLength);

    while (written === fdBuffer.bytes.byteLength) {
        fdBuffer.bytes = new Uint8Array(fdBuffer.bytes.byteLength * 2);
        written = lib.proc_pidinfo(pid, PROC_PIDLISTFDS, 0n, fdBuffer.bytes, fdBuffer.bytes.byteLength);
    }

    return Math.max(0, written);
}

/** The TCP or UDP socket in `socketBuffer`, or null for another kind. */
function decodeInetSocket(pid: number, fd: number): InetSocket | null {
    const kind = socketView.getInt32(SOI_KIND_OFFSET, true);

    if (kind !== SOCKINFO_TCP && kind !== SOCKINFO_IN) {
        return null;
    }

    const type = socketView.getInt32(SOI_FAMILY_OFFSET, true) === AF_INET6 ? "IPv6" : "IPv4";
    const remote = formatAddress(type, type === "IPv4" ? INSI_FADDR4_OFFSET : INSI_FADDR6_OFFSET);
    return {
        pid,
        fd,
        mode: openMode(socketView.getUint32(0, true)),
        protocol: kind === SOCKINFO_TCP ? "TCP" : "UDP",
        type,
        address: formatAddress(type, type === "IPv4" ? INSI_LADDR4_OFFSET : INSI_LADDR6_OFFSET),
        port: socketView.getUint16(INSI_LPORT_OFFSET, false),
        remoteAddress: remote,
        remotePort: socketView.getUint16(INSI_FPORT_OFFSET, false),
        state:
            kind === SOCKINFO_TCP
                ? (TCP_STATE_NAMES[socketView.getInt32(TCPSI_STATE_OFFSET, true)] ?? "UNKNOWN")
                : null,
    };
}

/**
 * Every TCP and UDP socket of this user's processes, any state, pid then descriptor ascending: the rows of
 * `lsof -nP -i` without the spawn. Null off macOS.
 */
export function listInetSockets(): InetSocket[] | null {
    const lib = loadLibproc();

    if (!lib) {
        return null;
    }

    const sockets: InetSocket[] = [];

    for (const pid of [...listAllPids(lib)].filter((pid) => pid > 0).sort((a, b) => a - b)) {
        const written = readFdList(lib, pid);
        const fds = new DataView(fdBuffer.bytes.buffer, 0, written);

        for (let offset = 0; offset + PROC_FDINFO_SIZE <= written; offset += PROC_FDINFO_SIZE) {
            if (fds.getUint32(offset + 4, true) !== PROX_FDTYPE_SOCKET) {
                continue;
            }

            const fd = fds.getInt32(offset, true);

            if (
                lib.proc_pidfdinfo(pid, fd, PROC_PIDFDSOCKETINFO, socketBuffer, SOCKET_FDINFO_SIZE) !==
                SOCKET_FDINFO_SIZE
            ) {
                continue;
            }

            const socket = decodeInetSocket(pid, fd);

            if (socket) {
                sockets.push(socket);
            }
        }
    }

    return sockets;
}

/** `proc_fdinfo.proc_fdtype` values (`sys/proc_info.h`) and the TYPE lsof prints for the ones that are not files. */
const FD_TYPE_NAMES: Record<number, string> = { 3: "PSXSHM", 4: "PSXSEM", 5: "KQUEUE", 6: "PIPE", 7: "FSEVENT" };
/** `vinfo_stat.vst_mode`, after `vst_dev` (4 bytes), in the `vnode_info` that follows `proc_fileinfo`. */
const VST_MODE_OFFSET = 24 + 4;
/**
 * `S_IFMT` file types (`sys/stat.h`). A Map on purpose: Biome's number-key fix rewrites octal object keys wrongly
 * (`0o010000` became `2401`, the digits read in base 7).
 */
const FILE_TYPE_NAMES = new Map([
    [0x1000, "FIFO"],
    [0x2000, "CHR"],
    [0x4000, "DIR"],
    [0x6000, "BLK"],
    [0x8000, "REG"],
    [0xa000, "LINK"],
    [0xc000, "SOCK"],
]);
const S_IFMT = 0xf000;

export interface OpenFileEntry {
    /** lsof's FD column: `cwd`, `txt`, or the descriptor with its mode letter (`3u`). */
    fd: string;
    /** lsof's TYPE column: `DIR`, `REG`, `CHR`, `IPv4`, `IPv6`, `unix`, `PIPE`, `KQUEUE`, … */
    type: string;
    /** lsof's NAME column: a path, `127.0.0.1:3000->127.0.0.1:51000 (ESTABLISHED)`, or empty. */
    name: string;
}

/**
 * The open files of one of this user's processes, as `lsof -p <pid>` lists them: the working directory, the
 * executable, then every descriptor. Not the `mem` rows (mapped libraries), which need a region walk. Null when the
 * process is gone, belongs to another user, or this is not macOS.
 */
export function listOpenFileEntries(pid: number, cwd: string | null): OpenFileEntry[] | null {
    const lib = loadLibproc();

    if (!lib) {
        return null;
    }

    const written = readFdList(lib, pid);

    if (written === 0) {
        return null;
    }

    const fds = new DataView(fdBuffer.bytes.buffer.slice(0, written));
    const pathBuffer = new Uint8Array(VNODE_FDINFOWITHPATH_SIZE);
    const pathView = new DataView(pathBuffer.buffer);
    const decoder = new TextDecoder();
    const entries: OpenFileEntry[] = [];
    const executable = Buffer.alloc(4096);
    const executableLength = libSystem()?.proc_pidpath(pid, executable, executable.byteLength) ?? 0;

    if (cwd !== null) {
        entries.push({ fd: "cwd", type: "DIR", name: cwd });
    }

    if (executableLength > 0) {
        entries.push({ fd: "txt", type: "REG", name: executable.toString("utf8", 0, executableLength) });
    }

    for (let offset = 0; offset + PROC_FDINFO_SIZE <= written; offset += PROC_FDINFO_SIZE) {
        const fd = fds.getInt32(offset, true);
        const kind = fds.getUint32(offset + 4, true);

        if (kind === PROX_FDTYPE_VNODE) {
            if (
                lib.proc_pidfdinfo(pid, fd, PROC_PIDFDVNODEPATHINFO, ptr(pathBuffer), VNODE_FDINFOWITHPATH_SIZE) !==
                VNODE_FDINFOWITHPATH_SIZE
            ) {
                continue;
            }

            const raw = pathBuffer.subarray(VNODE_PATH_OFFSET);
            const end = raw.indexOf(0);
            entries.push({
                fd: `${fd}${openMode(pathView.getUint32(0, true)).trim()}`,
                type: FILE_TYPE_NAMES.get(pathView.getUint16(VST_MODE_OFFSET, true) & S_IFMT) ?? "VNODE",
                name: decoder.decode(end === -1 ? raw : raw.subarray(0, end)),
            });
            continue;
        }

        if (kind === PROX_FDTYPE_SOCKET) {
            if (
                lib.proc_pidfdinfo(pid, fd, PROC_PIDFDSOCKETINFO, socketBuffer, SOCKET_FDINFO_SIZE) !==
                SOCKET_FDINFO_SIZE
            ) {
                continue;
            }

            const socket = decodeInetSocket(pid, fd);
            const mode = openMode(socketView.getUint32(0, true)).trim();

            if (socket) {
                const remote = socket.remotePort === 0 ? "" : `->${socket.remoteAddress}:${socket.remotePort}`;
                const state = socket.state ? ` (${socket.state})` : "";
                entries.push({
                    fd: `${fd}${mode}`,
                    type: socket.type,
                    name: `${socket.protocol} ${socket.address}:${socket.port}${remote}${state}`,
                });
            } else if (socketView.getInt32(SOI_KIND_OFFSET, true) === SOCKINFO_UN) {
                const raw = socketBuffer.subarray(UNSI_PATH_OFFSET, UNSI_PATH_OFFSET + SUN_PATH_SIZE);
                const end = raw.indexOf(0);
                entries.push({
                    fd: `${fd}${mode}`,
                    type: "unix",
                    name: decoder.decode(end === -1 ? raw : raw.subarray(0, end)),
                });
            } else {
                entries.push({ fd: `${fd}${mode}`, type: "sock", name: "" });
            }

            continue;
        }

        entries.push({ fd: String(fd), type: FD_TYPE_NAMES[kind] ?? "unknown", name: "" });
    }

    return entries;
}
